# server.py — Multi-Session OWW Server
from flask import Flask, request, jsonify
import numpy as np
from openwakeword.model import Model
import os
import threading
import asyncio
import websockets
import json
import math
import time
from pathlib import Path
from typing import Dict, Any
from dotenv import load_dotenv

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

SAMPLE_RATE = 16000
CHUNK_BYTES = CHUNK_SIZE * 2  # int16 => 2 bytes/sample

app = Flask(__name__)
# 關閉 Werkzeug access log（隱藏 /detect 的每次請求紀錄）
import logging
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

    def reset(self):
        with self.lock:
            self.consecutive_hits = 0
            try:
                if hasattr(self.model, 'reset'):
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
        self.active_wakeup_session: str | None = None

    def get_or_create(self, session_id: str) -> OWWSession:
        with self.global_lock:
            if session_id in self.sessions:
                self.sessions[session_id].last_active = time.time()
                return self.sessions[session_id]
            if len(self.sessions) >= self.max_sessions:
                self._evict_oldest()
            session = OWWSession(session_id)
            self.sessions[session_id] = session
            print(f"[OWW] 🆕 建立 Session: {session_id} (總數: {len(self.sessions)})")
            return session

    def remove(self, session_id: str):
        with self.global_lock:
            if session_id in self.sessions:
                del self.sessions[session_id]
                print(f"[OWW] 🗑️ 移除 Session: {session_id} (剩餘: {len(self.sessions)})")

    def pause_all(self, except_session: str = None):
        with self.global_lock:
            self.global_paused = True
            self.active_wakeup_session = except_session
            for sid, session in self.sessions.items():
                session.paused = (sid != except_session)
            print(f"[OWW] ⏸️ 全域暫停，活躍 Session: {except_session}")

    def resume_all(self):
        with self.global_lock:
            self.global_paused = False
            self.active_wakeup_session = None
            for session in self.sessions.values():
                session.paused = False
                session.reset()
            print(f"[OWW] ▶️ 全域恢復偵測，已重置所有 Session")

    def reset_session(self, session_id: str):
        with self.global_lock:
            if session_id in self.sessions:
                self.sessions[session_id].reset()

    def _evict_oldest(self):
        if not self.sessions:
            return
        oldest_id = min(self.sessions, key=lambda k: self.sessions[k].last_active)
        del self.sessions[oldest_id]
        print(f"[OWW] ♻️ 淘汰最舊 Session: {oldest_id}")

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
                }
            }

# =========================================================
# Bootstrap
# =========================================================
print("[OWW] 啟動中...")
print(f"[OWW] MODEL_PATH={MODEL_PATH}")
print(f"[OWW] PROB_THRESHOLD={PROB_THRESHOLD}, MIN_CONSECUTIVE={MIN_CONSECUTIVE}")
print(f"[OWW] MAX_SESSIONS={MAX_SESSIONS}")

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
# ✅ 新增：/detect — 單次 PCM 片段喚醒詞偵測（HTTP POST）
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

    # 每次 /detect 呼叫前先重置連續計數，避免跨呼叫累積
    session.consecutive_hits = 0

    detected    = False
    prob_max    = 0.0
    raw_max     = float("-inf")

    now = time.time()
    cooldown_ok = (now - session.last_trigger_ts) >= COOLDOWN_SEC

    if not cooldown_ok:
        return jsonify({
            "detected": False,
            "reason": "cooldown",
            "cooldown_remaining": round(COOLDOWN_SEC - (now - session.last_trigger_ts), 2)
        })

    for i in range(num_chunks):
        chunk = audio_np[i * CHUNK_SIZE:(i + 1) * CHUNK_SIZE]
        raw, prob = session.predict_chunk(chunk)

        if raw > raw_max:
            raw_max = raw
        if prob > prob_max:
            prob_max = prob

        if prob > PROB_THRESHOLD:
            session.consecutive_hits += 1
        else:
            session.consecutive_hits = 0

        if session.consecutive_hits >= MIN_CONSECUTIVE:
            detected = True
            session.last_trigger_ts = time.time()
            break

    # 推理完畢後重置，避免殘留影響下次呼叫
    session.consecutive_hits = 0

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
# WebSocket Streaming（保留，供其他用途）
# =========================================================
async def ws_handler(websocket, path=None):
    peer = websocket.remote_address

    import urllib.parse
    parsed = urllib.parse.urlparse(str(websocket.path) if hasattr(websocket, 'path') else '/')
    params = urllib.parse.parse_qs(parsed.query)
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

    try:
        async for message in websocket:
            if isinstance(message, str):
                cmd = message.strip().lower()
                if cmd == "reset":
                    session.paused = False
                    session.reset()
                    remainder_buf.clear()
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
                        await websocket.send(json.dumps({"event": "resumed", "session_id": session_id}))
                        continue
                except (json.JSONDecodeError, AttributeError):
                    pass
                await websocket.send(json.dumps({"event": "unknown_command", "command": cmd}))
                continue

            if session.paused:
                continue

            session.last_active = time.time()
            remainder_buf.extend(message)
            if len(remainder_buf) < CHUNK_BYTES:
                continue

            usable = (len(remainder_buf) // CHUNK_BYTES) * CHUNK_BYTES
            pcm = bytes(remainder_buf[:usable])
            del remainder_buf[:usable]

            audio_np = np.frombuffer(pcm, dtype=np.int16)
            num_chunks = len(audio_np) // CHUNK_SIZE
            raw_max = float("-inf")
            prob_max = 0.0
            detected = False

            for i in range(num_chunks):
                chunk = audio_np[i * CHUNK_SIZE:(i + 1) * CHUNK_SIZE]
                raw, prob = session.predict_chunk(chunk)
                if raw > raw_max: raw_max = raw
                if prob > prob_max: prob_max = prob
                if prob > PROB_THRESHOLD:
                    session.consecutive_hits += 1
                else:
                    session.consecutive_hits = 0
                now = time.time()
                cooldown_ok = (now - session.last_trigger_ts) >= COOLDOWN_SEC
                if session.consecutive_hits >= MIN_CONSECUTIVE and cooldown_ok:
                    detected = True
                    session.last_trigger_ts = now
                    break

            if raw_max == float("-inf"):
                raw_max = 0.0

            payload = {
                "event": "inference", "session_id": session_id,
                "detected": detected, "raw_score": round(raw_max, 6),
                "prob_score": round(prob_max, 6),
                "threshold_prob": PROB_THRESHOLD,
                "chunks": num_chunks,
                "consecutive_hits": session.consecutive_hits,
                "paused": session.paused,
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
        print(f"[OWW-WS] 🔌 斷線: session={session_id}")

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
    ws_thread = threading.Thread(target=run_ws, daemon=True)
    ws_thread.start()
    print(f"[OWW-HTTP] HTTP 伺服器啟動於 http://0.0.0.0:{HTTP_PORT}")
    app.run(host="0.0.0.0", port=HTTP_PORT, debug=False, use_reloader=False)