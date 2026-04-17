# server.py — Multi-Session OWW Server
import logging
import math
import os
import threading
import asyncio
import json
import time
import urllib.parse
from pathlib import Path
from typing import Dict, Optional

import numpy as np
import websockets
from dotenv import load_dotenv
from flask import Flask, request, jsonify
from openwakeword.model import Model

load_dotenv()

# =========================================================
# Config
# =========================================================
BASE_DIR = Path(__file__).resolve().parent

MODEL_PATH      = Path(os.environ["OWW_MODEL_PATH"])
HTTP_PORT       = int(os.environ["OWW_PORT"])
WS_PORT         = int(os.environ["OWW_WS_PORT"])
CHUNK_SIZE      = int(os.environ["OWW_CHUNK_SIZE"])
PROB_THRESHOLD  = float(os.environ["OWW_PROB_THRESHOLD"])
MIN_CONSECUTIVE = int(os.environ["OWW_MIN_CONSECUTIVE"])
COOLDOWN_SEC    = float(os.environ["OWW_COOLDOWN_SEC"])
MAX_SESSIONS    = int(os.environ["OWW_MAX_SESSIONS"])
DEBUG_SCORE     = os.environ["OWW_DEBUG_SCORE"] == "1"
SESSION_TTL_SEC = float(os.environ.get("OWW_SESSION_TTL_SEC", "300"))  # 預設 5 分鐘
TTL_CHECK_SEC   = float(os.environ.get("OWW_TTL_CHECK_SEC",   "60"))   # 預設每 60 秒掃描一次

SAMPLE_RATE = 16000
CHUNK_BYTES = CHUNK_SIZE * 2  # int16 => 2 bytes/sample

# FIX #3: WS remainder_buf 上限（約 4 秒音訊），防止無界成長
WS_MAX_BUF_BYTES = SAMPLE_RATE * 4 * 2

app = Flask(__name__)

# 關閉 Werkzeug access log（隱藏 /detect 的每次請求紀錄）
# FIX #9: import logging 移至頂層（原本在函式外但非頂層區段）
logging.getLogger('werkzeug').setLevel(logging.ERROR)

# =========================================================
# Utilities
# =========================================================
def sigmoid(x: float) -> float:
    if x >= 0:
        z = math.exp(-x)
        return 1.0 / (1.0 + z)
    else:
        z = math.exp(x)
        return z / (1.0 + z)

def check_model_files(model_path: Path):
    if not model_path.exists():
        raise FileNotFoundError(f"[OWW] 找不到模型檔: {model_path}")
    ext_data_path = Path(str(model_path) + ".data")
    if ext_data_path.exists():
        print(f"[OWW] 找到外部權重檔: {ext_data_path}")
    else:
        print(f"[OWW] 提示: 未找到 {ext_data_path.name}（若模型為單檔 ONNX 可忽略）")

# =========================================================
# Per-Session Model Manager
# =========================================================
class OWWSession:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.model = Model(
            wakeword_models=[str(MODEL_PATH)],
            inference_framework="onnx"
        )
        self.model_names = list(self.model.models.keys())
        self.target_name = self.model_names[0] if self.model_names else ""
        self.lock = threading.Lock()
        self.consecutive_hits = 0
        self.last_trigger_ts = 0.0
        self.paused = False
        self.created_at = time.time()
        self.last_active = time.time()

    # FIX #1: 顯式釋放 ONNX 原生記憶體，防止 C-heap 持續累積
    def close(self):
        """釋放 ONNX InferenceSession 佔用的原生資源。"""
        with self.lock:
            try:
                if self.model is not None:
                    # openwakeword Model 持有 onnxruntime.InferenceSession；
                    # 刪除參考後 CPython 的引用計數機制會立即呼叫 C++ 解構子。
                    self.model = None
            except Exception as e:
                print(f"[OWW] ⚠️ Session {self.session_id} close 失敗: {e}")

    def reset(self):
        with self.lock:
            self.consecutive_hits = 0
            try:
                if self.model is not None and hasattr(self.model, 'reset'):
                    self.model.reset()
            except Exception as e:
                print(f"[OWW] ⚠️ Session {self.session_id} reset 失敗: {e}")

    def predict_chunk(self, chunk: np.ndarray):
        with self.lock:
            prediction = self.model.predict(chunk)
            raw = float(prediction.get(self.target_name, 0.0))
            prob = sigmoid(raw)
            return raw, prob


class SessionManager:
    def __init__(self, max_sessions: int):
        self.sessions: Dict[str, OWWSession] = {}
        self.max_sessions = max_sessions
        self.global_lock = threading.Lock()
        self.global_paused = False
        self.active_wakeup_session: Optional[str] = None

    # FIX #4: 鎖外建立 OWWSession，防止 ONNX 載入期間阻塞所有請求
    def get_or_create(self, session_id: str) -> OWWSession:
        # 快速路徑：session 已存在，只需更新 last_active
        with self.global_lock:
            if session_id in self.sessions:
                self.sessions[session_id].last_active = time.time()
                return self.sessions[session_id]
            # 若 session 不存在，先佔位（None）防止其他執行緒並發建立相同 id
            if len(self.sessions) >= self.max_sessions:
                self._evict_oldest()
            self.sessions[session_id] = None  # 佔位符

        # 在鎖外建立 OWWSession（ONNX 載入可能耗時數秒）
        try:
            new_session = OWWSession(session_id)
        except Exception:
            # 建立失敗時移除佔位符，讓下次請求重試
            with self.global_lock:
                if self.sessions.get(session_id) is None:
                    del self.sessions[session_id]
            raise

        with self.global_lock:
            # 再次確認：若其他執行緒已填入真實 session（理論上不會，但防禦性編程）
            existing = self.sessions.get(session_id)
            if existing is not None:
                new_session.close()
                return existing
            self.sessions[session_id] = new_session
            print(f"[OWW] 🆕 建立 Session: {session_id} (總數: {len(self.sessions)})")
            return new_session

    # FIX #1: remove 前呼叫 close() 釋放 ONNX 原生記憶體
    def remove(self, session_id: str):
        with self.global_lock:
            session = self.sessions.pop(session_id, None)
        if session is not None:
            session.close()
            print(f"[OWW] 🗑️ 移除 Session: {session_id} (剩餘: {len(self.sessions)})")

    def pause_all(self, except_session: str = None):
        with self.global_lock:
            self.global_paused = True
            self.active_wakeup_session = except_session
            for sid, session in self.sessions.items():
                if session is not None:
                    session.paused = (sid != except_session)
            print(f"[OWW] ⏸️ 全域暫停，活躍 Session: {except_session}")

    def resume_all(self):
        with self.global_lock:
            self.global_paused = False
            self.active_wakeup_session = None
            for session in self.sessions.values():
                if session is not None:
                    session.paused = False
                    session.reset()
            print(f"[OWW] ▶️ 全域恢復偵測，已重置所有 Session")

    def reset_session(self, session_id: str):
        with self.global_lock:
            session = self.sessions.get(session_id)
        if session is not None:
            session.reset()

    # FIX #1: _evict_oldest 前呼叫 close()
    def _evict_oldest(self):
        """必須在持有 global_lock 時呼叫。"""
        if not self.sessions:
            return
        oldest_id = min(
            (k for k, v in self.sessions.items() if v is not None),
            key=lambda k: self.sessions[k].last_active,
            default=None,
        )
        if oldest_id is None:
            return
        evicted = self.sessions.pop(oldest_id)
        print(f"[OWW] ♻️ 淘汰最舊 Session: {oldest_id}")
        # close() 在鎖外呼叫（避免在持鎖期間執行 C++ 解構，雖然風險低但保持一致性）
        # 注意：此處仍在 global_lock 內，若 close() 耗時長可考慮收集後統一在鎖外處理
        if evicted is not None:
            evicted.close()

    # =========================================================
    # TTL 清理
    # =========================================================
    def cleanup_expired_sessions(self):
        """清理超過 SESSION_TTL_SEC 未活躍的 Session。

        FIX #2: 先記錄 idle 時間再刪除，修正日誌 bug。
        FIX #6: 鎖內只做列表收集與 dict 移除，鎖外呼叫 close() 釋放原生資源，
                縮短持鎖時間，避免阻塞所有請求。
        """
        now = time.time()

        # 鎖內：只收集過期項目並從 dict 移除
        with self.global_lock:
            expired: list[tuple[str, OWWSession, float]] = []
            for sid, s in list(self.sessions.items()):
                if s is not None and (now - s.last_active) > SESSION_TTL_SEC:
                    idle_sec = now - s.last_active  # FIX #2: 先記錄，再刪除
                    expired.append((sid, s, idle_sec))
                    del self.sessions[sid]

        # 鎖外：釋放 ONNX 原生記憶體（可能耗時）
        for sid, session, idle_sec in expired:
            session.close()
            print(f"[OWW] 🧹 TTL 清理 Session: {sid} (閒置 {idle_sec:.0f}s)")

        if expired:
            print(f"[OWW] 🧹 本次清理 {len(expired)} 個過期 Session，剩餘: {len(self.sessions)}")

    def get_status(self) -> dict:
        with self.global_lock:
            return {
                "total_sessions": len(self.sessions),
                "global_paused": self.global_paused,
                "active_wakeup_session": self.active_wakeup_session,
                "sessions": {
                    sid: {
                        "paused": s.paused,
                        "last_active_sec": round(time.time() - s.last_active, 1),
                    }
                    for sid, s in self.sessions.items()
                    if s is not None
                }
            }

# =========================================================
# Bootstrap
# =========================================================
print("[OWW] 啟動中...")
print(f"[OWW] MODEL_PATH={MODEL_PATH}")
print(f"[OWW] PROB_THRESHOLD={PROB_THRESHOLD}, MIN_CONSECUTIVE={MIN_CONSECUTIVE}")
print(f"[OWW] MAX_SESSIONS={MAX_SESSIONS}")
print(f"[OWW] SESSION_TTL_SEC={SESSION_TTL_SEC}, TTL_CHECK_SEC={TTL_CHECK_SEC}")

check_model_files(MODEL_PATH)

_test_model = Model(wakeword_models=[str(MODEL_PATH)], inference_framework="onnx")
_test_names = list(_test_model.models.keys())
if not _test_names:
    raise RuntimeError("[OWW] 沒有載入任何模型")
TARGET_NAME = _test_names[0]
del _test_model
print(f"[OWW] 模型驗證完成 ✅ target={TARGET_NAME}")

session_manager = SessionManager(max_sessions=MAX_SESSIONS)

# =========================================================
# TTL 清理背景執行緒
# =========================================================
def _ttl_cleanup_loop():
    """每隔 TTL_CHECK_SEC 秒執行一次過期 Session 清理。"""
    while True:
        time.sleep(TTL_CHECK_SEC)
        try:
            session_manager.cleanup_expired_sessions()
        except Exception as e:
            print(f"[OWW] ⚠️ TTL 清理執行緒發生錯誤: {e}")

_ttl_thread = threading.Thread(target=_ttl_cleanup_loop, daemon=True, name="oww-ttl-cleanup")
_ttl_thread.start()
print(f"[OWW] 🕐 TTL 清理執行緒已啟動（每 {TTL_CHECK_SEC:.0f}s 掃描，TTL={SESSION_TTL_SEC:.0f}s）")

# =========================================================
# HTTP Routes
# =========================================================
@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "target_model": TARGET_NAME,
        "sample_rate": SAMPLE_RATE,
        "chunk_size": CHUNK_SIZE,
        "prob_threshold": PROB_THRESHOLD,
        "min_consecutive": MIN_CONSECUTIVE,
        "cooldown_sec": COOLDOWN_SEC,
        "max_sessions": MAX_SESSIONS,
        "session_ttl_sec": SESSION_TTL_SEC,
        "ttl_check_sec": TTL_CHECK_SEC,
        **session_manager.get_status()
    })

@app.route("/pause_all", methods=["POST"])
def pause_all():
    data = request.get_json(silent=True) or {}
    except_session = data.get("except_session")
    session_manager.pause_all(except_session)
    return jsonify({"ok": True})

@app.route("/resume_all", methods=["POST"])
def resume_all():
    session_manager.resume_all()
    return jsonify({"ok": True})

# =========================================================
# /detect — 單次 PCM 片段喚醒詞偵測（HTTP POST）
#
#   Body: raw binary (int16 LE, 16kHz mono)
#   Query: ?session_id=xxx
#
#   流程：
#     1. 接收最多 2 秒的 PCM 二進位資料
#     2. 切成 CHUNK_SIZE 幀逐一推理
#     3. 只要有任一幀 prob > PROB_THRESHOLD 且連續達標
#        → 回傳 detected: true
#     4. 每個 session 獨立冷卻，防止同一人重複觸發
# =========================================================
@app.route("/detect", methods=["POST"])
def detect():
    session_id = request.args.get("session_id", "").strip()
    if not session_id:
        return jsonify({"error": "missing session_id"}), 400

    pcm_bytes = request.data
    if not pcm_bytes:
        return jsonify({"error": "empty body"}), 400

    # 最多接受 2 秒的資料（2 * 16000 * 2 = 64000 bytes）
    MAX_DETECT_BYTES = SAMPLE_RATE * 2 * 2
    if len(pcm_bytes) > MAX_DETECT_BYTES:
        pcm_bytes = pcm_bytes[:MAX_DETECT_BYTES]

    session = session_manager.get_or_create(session_id)

    if session.paused:
        return jsonify({"detected": False, "reason": "paused"})

    audio_np = np.frombuffer(pcm_bytes, dtype=np.int16)
    num_chunks = len(audio_np) // CHUNK_SIZE

    if num_chunks == 0:
        return jsonify({"detected": False, "reason": "too_short"})

    now = time.time()
    cooldown_ok = (now - session.last_trigger_ts) >= COOLDOWN_SEC

    if not cooldown_ok:
        return jsonify({
            "detected": False,
            "reason": "cooldown",
            "cooldown_remaining": round(COOLDOWN_SEC - (now - session.last_trigger_ts), 2)
        })

    # FIX #11: 使用區域變數 local_hits，不汙染 session.consecutive_hits，
    #          消除 HTTP 與 WS 路徑同用同一 session 時的競態。
    local_hits = 0
    detected   = False
    prob_max   = 0.0
    raw_max    = float("-inf")

    for i in range(num_chunks):
        chunk = audio_np[i * CHUNK_SIZE:(i + 1) * CHUNK_SIZE]
        raw, prob = session.predict_chunk(chunk)

        if raw > raw_max:
            raw_max = raw
        if prob > prob_max:
            prob_max = prob

        if prob > PROB_THRESHOLD:
            local_hits += 1
        else:
            local_hits = 0

        if local_hits >= MIN_CONSECUTIVE:
            detected = True
            session.last_trigger_ts = time.time()
            break

    if raw_max == float("-inf"):
        raw_max = 0.0

    if DEBUG_SCORE or detected:
        print(
            f"[OWW-HTTP] session={session_id} "
            f"detected={detected} prob_max={prob_max:.4f} "
            f"chunks={num_chunks}"
        )

    return jsonify({
        "detected":   detected,
        "prob_score": round(prob_max, 6),
        "raw_score":  round(raw_max, 6),
        "chunks":     num_chunks,
        "session_id": session_id,
    })

# =========================================================
# WebSocket Streaming
# =========================================================
async def ws_handler(websocket, path=None):
    peer = websocket.remote_address

    # FIX #9: urllib.parse 已移至頂層 import，此處直接使用
    parsed    = urllib.parse.urlparse(str(websocket.path) if hasattr(websocket, 'path') else '/')
    params    = urllib.parse.parse_qs(parsed.query)
    session_id = params.get("session_id", [None])[0]

    if not session_id:
        try:
            first_msg = await asyncio.wait_for(websocket.recv(), timeout=5.0)
            if isinstance(first_msg, str):
                try:
                    init = json.loads(first_msg)
                    session_id = init.get("session_id", "").strip()
                except json.JSONDecodeError:
                    session_id = first_msg.strip()
        except asyncio.TimeoutError:
            await websocket.close(1008, "No session_id provided")
            return

    if not session_id:
        await websocket.close(1008, "Empty session_id")
        return

    print(f"[OWW-WS] 新連線: {peer} session={session_id}")
    session = session_manager.get_or_create(session_id)
    session.reset()
    remainder_buf = bytearray()

    # FIX #11: WS 路徑同樣使用區域變數追蹤連續命中，不共享 session.consecutive_hits
    local_hits = 0

    try:
        async for message in websocket:
            if isinstance(message, str):
                # FIX #8: 控制訊息也更新 last_active，防止活躍 session 被提前 TTL 清除
                session.last_active = time.time()

                cmd = message.strip().lower()
                if cmd == "reset":
                    session.paused = False
                    session.reset()
                    remainder_buf.clear()
                    local_hits = 0
                    await websocket.send(json.dumps({"event": "reset_ok", "session_id": session_id}))
                    continue
                if cmd == "ping":
                    await websocket.send(json.dumps({"event": "pong"}))
                    continue
                try:
                    cmd_obj = json.loads(message)
                    if cmd_obj.get("command") == "pause":
                        session.paused = True
                        await websocket.send(json.dumps({"event": "paused", "session_id": session_id}))
                        continue
                    if cmd_obj.get("command") == "resume":
                        session.paused = False
                        session.reset()
                        remainder_buf.clear()
                        local_hits = 0
                        await websocket.send(json.dumps({"event": "resumed", "session_id": session_id}))
                        continue
                except (json.JSONDecodeError, AttributeError):
                    pass
                await websocket.send(json.dumps({"event": "unknown_command", "command": cmd}))
                continue

            if session.paused:
                continue

            session.last_active = time.time()

            # FIX #3: remainder_buf 上限保護，防止異常客戶端造成無界記憶體成長
            if len(remainder_buf) + len(message) > WS_MAX_BUF_BYTES:
                print(
                    f"[OWW-WS] ⚠️ Session {session_id} buffer 超過上限 "
                    f"({WS_MAX_BUF_BYTES} bytes)，清空緩衝區"
                )
                remainder_buf.clear()
                local_hits = 0

            remainder_buf.extend(message)
            if len(remainder_buf) < CHUNK_BYTES:
                continue

            usable = (len(remainder_buf) // CHUNK_BYTES) * CHUNK_BYTES
            pcm = bytes(remainder_buf[:usable])
            del remainder_buf[:usable]

            audio_np   = np.frombuffer(pcm, dtype=np.int16)
            num_chunks = len(audio_np) // CHUNK_SIZE
            raw_max    = float("-inf")
            prob_max   = 0.0
            detected   = False

            for i in range(num_chunks):
                chunk = audio_np[i * CHUNK_SIZE:(i + 1) * CHUNK_SIZE]
                raw, prob = session.predict_chunk(chunk)
                if raw > raw_max:
                    raw_max = raw
                if prob > prob_max:
                    prob_max = prob

                # FIX #11: 使用區域變數 local_hits（不修改 session.consecutive_hits）
                if prob > PROB_THRESHOLD:
                    local_hits += 1
                else:
                    local_hits = 0

                now = time.time()
                cooldown_ok = (now - session.last_trigger_ts) >= COOLDOWN_SEC
                if local_hits >= MIN_CONSECUTIVE and cooldown_ok:
                    detected = True
                    session.last_trigger_ts = now
                    local_hits = 0  # 觸發後重置，防止連續觸發
                    break

            if raw_max == float("-inf"):
                raw_max = 0.0

            payload = {
                "event":            "inference",
                "session_id":       session_id,
                "detected":         detected,
                "raw_score":        round(raw_max, 6),
                "prob_score":       round(prob_max, 6),
                "threshold_prob":   PROB_THRESHOLD,
                "chunks":           num_chunks,
                "consecutive_hits": local_hits,
                "paused":           session.paused,
            }
            if DEBUG_SCORE or detected:
                await websocket.send(json.dumps(payload))
            if detected:
                print(f"[OWW-WS] ✅ Session {session_id} 偵測到喚醒詞! prob={prob_max:.4f}")

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        print(f"[OWW-WS] ❌ Session {session_id} 錯誤: {e}")
    finally:
        # FIX #7: 斷線時主動移除 session，立即釋放 ONNX 記憶體，不需等到 TTL 到期
        print(f"[OWW-WS] 🔌 斷線: session={session_id}")
        session_manager.remove(session_id)

# =========================================================
# Start servers
# =========================================================
def run_ws():
    async def _start():
        async with websockets.serve(ws_handler, "0.0.0.0", WS_PORT):
            print(f"[OWW-WS] WebSocket 伺服器啟動於 ws://0.0.0.0:{WS_PORT}")
            await asyncio.Future()
    asyncio.run(_start())

if __name__ == "__main__":
    # FIX #10: 生產環境建議改用 gunicorn 取代 Flask 內建開發伺服器，例如：
    #   gunicorn -w 4 -k gevent --bind 0.0.0.0:PORT "server:app"
    # 注意：多 worker 模式下 SessionManager 為 in-process 狀態，
    # 需改用 Redis / 外部 store 才能跨 worker 共享 session。
    ws_thread = threading.Thread(target=run_ws, daemon=True)
    ws_thread.start()
    print(f"[OWW-HTTP] HTTP 伺服器啟動於 http://0.0.0.0:{HTTP_PORT}")
    app.run(host="0.0.0.0", port=HTTP_PORT, debug=False, use_reloader=False)