# server.py — OWW HTTP Server（共用 ONNX 推論 session，每個 session 各自的串流狀態）
#
# 串流協定（與 handlers/voice/sttSession.js 對應）：
#   Node 端平常只送「上次之後新增」的 PCM；音訊有中斷（安靜被略過、冷卻、錄音中、請求失敗）時
#   改送整個滑動視窗並帶 ?reset=1，伺服器先清空該 session 的串流狀態再處理。
#   每個 session 的 OWW 緩衝區彼此獨立，不同使用者的音訊不會再混進同一個模型狀態。
import collections
import copy
import logging
import os
import threading
import time
# 移除不必要的 gc import，OWWSession 不持有大型資源，
# 強制 gc.collect() 只會造成停頓而無實質效益。
from pathlib import Path
from typing import Dict, Optional, Deque

import numpy as np
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
CHUNK_SIZE      = int(os.environ["OWW_CHUNK_SIZE"])
PROB_THRESHOLD  = float(os.environ["OWW_PROB_THRESHOLD"])
MIN_CONSECUTIVE = int(os.environ["OWW_MIN_CONSECUTIVE"])
COOLDOWN_SEC    = float(os.environ["OWW_COOLDOWN_SEC"])
MAX_SESSIONS    = int(os.environ["OWW_MAX_SESSIONS"])
DEBUG_SCORE     = os.environ.get("OWW_DEBUG_SCORE", "0") == "1"

SESSION_TTL_SEC = float(os.environ.get("OWW_SESSION_TTL_SEC", "120"))
TTL_CHECK_SEC   = float(os.environ.get("OWW_TTL_CHECK_SEC", "30"))

# HTTP 單次偵測最多接受多少秒音訊
MAX_DETECT_SEC   = float(os.environ.get("OWW_MAX_DETECT_SEC", "2"))
MAX_DETECT_BYTES = int(16000 * MAX_DETECT_SEC * 2)

# 每個 session 的速率限制：在滑動視窗內最多允許多少次 /detect 請求
# 預設：每 1 秒內最多 10 次（對應 Node.js 端 DETECT_INTERVAL_MS=100ms 的極端情況）
RATE_LIMIT_MAX_CALLS  = int(os.environ.get("OWW_RATE_LIMIT_MAX_CALLS", "10"))
RATE_LIMIT_WINDOW_SEC = float(os.environ.get("OWW_RATE_LIMIT_WINDOW_SEC", "1.0"))

SAMPLE_RATE = 16000
CHUNK_BYTES = CHUNK_SIZE * 2

app = Flask(__name__)

# 關閉 Werkzeug access log，避免 /detect 太吵
logging.getLogger("werkzeug").setLevel(logging.ERROR)

# =========================================================
# Utilities
# =========================================================
def check_model_files(model_path: Path):
    if not model_path.exists():
        raise FileNotFoundError(f"[OWW] 找不到模型檔: {model_path}")

    ext_data_path = Path(str(model_path) + ".data")
    if ext_data_path.exists():
        print(f"[OWW] 找到外部權重檔: {ext_data_path}")
    else:
        print(f"[OWW] 提示: 未找到 {ext_data_path.name}（若模型為單檔 ONNX 可忽略）")


# =========================================================
# Lightweight Session State
# =========================================================
class OWWSession:
    """
    每個 session 保留輕量狀態：
    - paused / cooldown / last_active（原有）
    - [修正 PY-1] consecutive_hits：跨請求累積的連續命中數，
      讓 MIN_CONSECUTIVE 的時序判斷能跨越多次 HTTP 請求生效，
      恢復 OWW 時序偵測的核心優勢。
    - [修正 PY-9] _rate_timestamps：滑動視窗速率限制的時間戳記佇列。
    """

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.last_trigger_ts = 0.0
        self.paused = False
        self.created_at = time.time()
        self.last_active = time.time()

        # 跨請求累積的連續命中計數
        self.consecutive_hits: int = 0

        # 速率限制：記錄最近請求的時間戳（使用 deque 自動淘汰舊記錄）
        self._rate_timestamps: Deque[float] = collections.deque()

        # 串流狀態：此 session 專屬的 OWW 緩衝區（第一次偵測時才建立，約需 40ms）
        # 與不足一個 CHUNK_SIZE 的尾端樣本（留到下次請求接著處理，不丟棄）。
        # lock 保護兩者：同一個 session 的請求依序處理，不同 session 可並行推論。
        self.lock = threading.Lock()
        self.stream: Optional[Model] = None
        self.leftover = np.empty(0, dtype=np.int16)

    def ensure_stream(self) -> Model:
        """呼叫端需持有 self.lock"""
        if self.stream is None:
            self.stream = create_stream_model()
        return self.stream

    def reset_stream(self):
        """清空串流緩衝區（偵測成功後、或 Node 端告知音訊中斷時）。呼叫端需持有 self.lock"""
        if self.stream is not None:
            self.stream.reset()
        self.leftover = np.empty(0, dtype=np.int16)

    def reset(self):
        with self.lock:
            self.last_trigger_ts = 0.0
            # 重置時同步清除跨請求命中計數與串流狀態
            self.consecutive_hits = 0
            self.reset_stream()

    def is_rate_limited(self) -> bool:
        now = time.time()
        cutoff = now - RATE_LIMIT_WINDOW_SEC

        # 移除視窗外的舊記錄
        while self._rate_timestamps and self._rate_timestamps[0] < cutoff:
            self._rate_timestamps.popleft()

        if len(self._rate_timestamps) >= RATE_LIMIT_MAX_CALLS:
            return True

        self._rate_timestamps.append(now)
        return False

    def close(self):
        """釋放串流緩衝區（ONNX 推論 session 是共用的，不在這裡釋放）"""
        self.stream = None
        self.leftover = np.empty(0, dtype=np.int16)


class SessionManager:
    def __init__(self, max_sessions: int):
        self.sessions: Dict[str, OWWSession] = {}
        self.max_sessions = max_sessions
        self.global_lock = threading.Lock()
        self.global_paused = False
        self.active_wakeup_session: Optional[str] = None

    def get_or_create(self, session_id: str) -> OWWSession:
        now = time.time()

        with self.global_lock:
            session = self.sessions.get(session_id)
            if session is not None:
                session.last_active = now
                return session

            if len(self.sessions) >= self.max_sessions:
                self._evict_oldest_locked()

            session = OWWSession(session_id)
            self.sessions[session_id] = session

            return session

    def remove(self, session_id: str):
        with self.global_lock:
            session = self.sessions.pop(session_id, None)

        if session is not None:
            session.close()

    def pause_all(self, except_session: str = None):
        with self.global_lock:
            self.global_paused = True
            self.active_wakeup_session = except_session

            for sid, session in self.sessions.items():
                session.paused = sid != except_session

            print(f"[OWW] ⏸️ 全域暫停，活躍 Session: {except_session}")

    def resume_all(self):
        with self.global_lock:
            self.global_paused = False
            self.active_wakeup_session = None

            for session in self.sessions.values():
                session.paused = False
                # 恢復偵測時重置跨請求命中計數，避免舊狀態誤觸發
                session.consecutive_hits = 0

            print("[OWW] ▶️ 全域恢復偵測")

    def reset_session(self, session_id: str):
        with self.global_lock:
            session = self.sessions.get(session_id)

        if session is not None:
            session.reset()

    def _evict_oldest_locked(self):
        if not self.sessions:
            return

        oldest_id = min(
            self.sessions.keys(),
            key=lambda sid: self.sessions[sid].last_active,
            default=None,
        )

        if oldest_id is None:
            return

        evicted = self.sessions.pop(oldest_id, None)

        if evicted is not None:
            evicted.close()

    def cleanup_expired_sessions(self):
        now = time.time()
        expired: list[tuple[str, OWWSession, float]] = []

        with self.global_lock:
            for sid, session in list(self.sessions.items()):
                idle_sec = now - session.last_active
                if idle_sec > SESSION_TTL_SEC:
                    expired.append((sid, session, idle_sec))
                    del self.sessions[sid]

            remaining = len(self.sessions)

        for sid, session, idle_sec in expired:
            session.close()

        # 移除 gc.collect() 呼叫。
        # OWWSession 不持有大型資源，強制 GC 只會造成執行緒停頓，
        # Python 的自動 GC 已足夠處理這類輕量物件的回收。
        if expired:
            print(f"[OWW] 🧹 TTL 清理：移除 {len(expired)} 個閒置 session，剩餘 {remaining} 個")

    def get_status(self) -> dict:
        now = time.time()

        with self.global_lock:
            return {
                "total_sessions": len(self.sessions),
                "global_paused": self.global_paused,
                "active_wakeup_session": self.active_wakeup_session,
                "sessions": {
                    sid: {
                        "paused": session.paused,
                        "last_active_sec": round(now - session.last_active, 1),
                        "cooldown_remaining": max(
                            0.0,
                            round(COOLDOWN_SEC - (now - session.last_trigger_ts), 2)
                        ),
                        # [修正 PY-1] 在狀態回報中顯示跨請求命中計數，方便除錯
                        "consecutive_hits": session.consecutive_hits,
                    }
                    for sid, session in self.sessions.items()
                },
            }


# =========================================================
# Bootstrap
# =========================================================
print("[OWW] 啟動中...")
print(f"[OWW] MODEL_PATH={MODEL_PATH}")
print(f"[OWW] PROB_THRESHOLD={PROB_THRESHOLD}, MIN_CONSECUTIVE={MIN_CONSECUTIVE}")
print(f"[OWW] MAX_SESSIONS={MAX_SESSIONS}")
print(f"[OWW] SESSION_TTL_SEC={SESSION_TTL_SEC}, TTL_CHECK_SEC={TTL_CHECK_SEC}")
print(f"[OWW] MAX_DETECT_SEC={MAX_DETECT_SEC}, MAX_DETECT_BYTES={MAX_DETECT_BYTES}")
print(f"[OWW] RATE_LIMIT={RATE_LIMIT_MAX_CALLS} calls / {RATE_LIMIT_WINDOW_SEC}s")

check_model_files(MODEL_PATH)

# =========================================================
# OpenWakeWord 範本模型（ONNX 推論 session 由所有串流共用）
# =========================================================
print("[OWW] 載入模型中...")

TEMPLATE_MODEL = Model(
    wakeword_models=[str(MODEL_PATH)],
    inference_framework="onnx",
)

MODEL_NAMES = list(TEMPLATE_MODEL.models.keys())
if not MODEL_NAMES:
    raise RuntimeError("[OWW] 沒有載入任何模型")

TARGET_NAME = MODEL_NAMES[0]

# 每個串流保留的原始樣本數（見 create_stream_model 的說明）
RAW_BUFFER_SAMPLES = max(SAMPLE_RATE, CHUNK_SIZE + 1280 + 480)

print(f"[OWW] 模型載入完成 ✅ target={TARGET_NAME}")


def create_stream_model() -> Model:
    """
    建立一份獨立的串流狀態，但共用範本的 ONNX 推論 session。

    一個完整的 Model 約佔 40MB（大多是 ONNX Runtime 的 session），每個使用者各開一份
    太浪費；而 InferenceSession.run() 本身無狀態且可多執行緒呼叫。會隨音訊變動的只有
    Model.prediction_buffer 與 preprocessor 的各個緩衝區，所以淺拷貝後換上新的緩衝區即可。
    """
    stream = copy.copy(TEMPLATE_MODEL)
    stream.preprocessor = copy.copy(TEMPLATE_MODEL.preprocessor)
    # reset() 對 raw_data_buffer 是就地 clear()，必須先換成新的 deque，否則會清到範本的。
    # openwakeword 只會讀這個緩衝區最後 n_samples + 480 個樣本（n_samples ≤ CHUNK_SIZE + 1279），
    # 原本保留 10 秒（16 萬個 Python int，約 5MB）且每次 predict 都整個轉成 list；縮成 1 秒結果不變。
    stream.preprocessor.raw_data_buffer = collections.deque(maxlen=RAW_BUFFER_SAMPLES)
    # 重新配置其餘緩衝區（melspectrogram / feature / remainder）與 prediction_buffer
    stream.reset()
    return stream


session_manager = SessionManager(max_sessions=MAX_SESSIONS)

def predict_stream(session: OWWSession, audio_np: np.ndarray):
    """
    把新音訊接續餵進 session 專屬的串流模型（呼叫端需持有 session.lock）。
    上次不足一個 CHUNK_SIZE 的尾端樣本會先接在前面，這次的尾端再留給下次。

    Returns:
        (detected, raw_max, prob_max, final_hits, num_chunks)
        final_hits: 本次推理結束後的累積命中數，應回寫至 session
    """
    stream = session.ensure_stream()
    if session.leftover.size:
        audio_np = np.concatenate((session.leftover, audio_np))

    num_chunks = len(audio_np) // CHUNK_SIZE
    session.leftover = audio_np[num_chunks * CHUNK_SIZE:].copy()

    local_hits = session.consecutive_hits
    detected = False
    prob_max = 0.0
    raw_max = float("-inf")

    for i in range(num_chunks):
        chunk = audio_np[i * CHUNK_SIZE:(i + 1) * CHUNK_SIZE]

        prediction = stream.predict(chunk)

        # 模型直接輸出 0~1 的機率值
        raw = float(prediction.get(TARGET_NAME, 0.0))
        prob = raw

        if raw > raw_max:
            raw_max = raw

        if prob > prob_max:
            prob_max = prob

        if prob > PROB_THRESHOLD:
            local_hits += 1
        else:
            # 機率低於閾值時重置連續計數（非連續命中不算數）
            local_hits = 0

        if local_hits >= MIN_CONSECUTIVE:
            detected = True
            break

    if raw_max == float("-inf"):
        raw_max = 0.0

    return detected, raw_max, prob_max, local_hits, num_chunks


# =========================================================
# TTL Cleanup Thread
# =========================================================
def _ttl_cleanup_loop():
    while True:
        time.sleep(TTL_CHECK_SEC)

        try:
            session_manager.cleanup_expired_sessions()
        except Exception as e:
            print(f"[OWW] ⚠️ TTL 清理執行緒發生錯誤: {e}")


_ttl_thread = threading.Thread(
    target=_ttl_cleanup_loop,
    daemon=True,
    name="oww-ttl-cleanup",
)
_ttl_thread.start()

print(
    f"[OWW] 🕒 TTL 清理執行緒已啟動"
    f"（每 {TTL_CHECK_SEC:.0f}s 掃描，TTL={SESSION_TTL_SEC:.0f}s）"
)


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
        "shared_model": True,           # ONNX 推論 session 仍為共用
        "per_session_stream": True,     # 串流緩衝區每個 session 各自獨立
        "incremental_audio": True,      # 接受增量音訊，?reset=1 表示音訊中斷
        "max_detect_sec": MAX_DETECT_SEC,
        "max_detect_bytes": MAX_DETECT_BYTES,
        "rate_limit_max_calls": RATE_LIMIT_MAX_CALLS,
        "rate_limit_window_sec": RATE_LIMIT_WINDOW_SEC,
        **session_manager.get_status(),
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


@app.route("/reset_session", methods=["POST"])
def reset_session():
    data = request.get_json(silent=True) or {}
    session_id = str(data.get("session_id", "")).strip()

    if not session_id:
        return jsonify({"error": "missing session_id"}), 400

    session_manager.reset_session(session_id)

    return jsonify({"ok": True, "session_id": session_id})


# =========================================================
# /detect — HTTP Wakeword Detection
# =========================================================
@app.route("/detect", methods=["POST"])
def detect():
    session_id = request.args.get("session_id", "").strip()

    if not session_id:
        return jsonify({"error": "missing session_id"}), 400

    pcm_bytes = request.data

    if not pcm_bytes:
        return jsonify({"error": "empty body"}), 400

    # 超過上限時保留「最新」的音訊（尾端）。原本取開頭會把最近的音訊丟掉，
    # 而喚醒詞通常就落在視窗尾端；同時對齊 int16（2 bytes），避免奇數長度讓 np.frombuffer 拋錯。
    if len(pcm_bytes) > MAX_DETECT_BYTES:
        pcm_bytes = pcm_bytes[-MAX_DETECT_BYTES:]
    if len(pcm_bytes) % 2:
        pcm_bytes = pcm_bytes[1:]

    session = session_manager.get_or_create(session_id)

    # [速率限制檢查：防止異常客戶端無限制地發送請求
    if session.is_rate_limited():
        return jsonify({
            "detected": False,
            "reason": "rate_limited",
            "session_id": session_id,
        }), 429

    # processed=False 代表這段音訊沒有餵進模型：Node 端據此判定串流中斷，下次改送整個視窗並帶 reset=1
    if session.paused:
        return jsonify({
            "detected": False,
            "processed": False,
            "reason": "paused",
            "session_id": session_id,
        })

    # Node 端告知音訊不連續（本次送的是整個視窗），先清空串流狀態再處理
    reset_requested = request.args.get("reset") == "1"

    # np.frombuffer 不複製資料，audio_np 與 pcm_bytes 共享記憶體。
    #             在 Flask request context 內（請求結束前）pcm_bytes 不會被釋放，
    #             此處是安全的。若未來改用非同步框架，需改為 np.frombuffer(...).copy()。
    audio_np = np.frombuffer(pcm_bytes, dtype=np.int16)

    # 同一個 session 的請求依序處理；不同 session 各自持鎖，可並行推論
    with session.lock:
        now = time.time()
        cooldown_remaining = COOLDOWN_SEC - (now - session.last_trigger_ts)

        if cooldown_remaining > 0:
            # Cooldown 期間重置跨請求命中計數，避免冷卻結束後立即誤觸發
            session.consecutive_hits = 0
            return jsonify({
                "detected": False,
                "processed": False,
                "reason": "cooldown",
                "cooldown_remaining": round(cooldown_remaining, 2),
                "session_id": session_id,
            })

        if reset_requested:
            session.consecutive_hits = 0
            session.reset_stream()

        # 跨請求累積的命中數在 predict_stream 內讀取，推理後回寫
        detected, raw_max, prob_max, final_hits, num_chunks = predict_stream(session, audio_np)

        if detected:
            session.last_trigger_ts = time.time()
            # 偵測成功後重置命中計數與串流緩衝區，避免冷卻結束後被緩衝區裡同一句喚醒詞再次觸發
            session.consecutive_hits = 0
            session.reset_stream()
        else:
            # 未偵測到時，將最終命中數回寫至 session 供下次請求繼續累積
            session.consecutive_hits = final_hits

    if num_chunks <= 0:
        # 樣本不足一個 chunk：已暫存到 leftover，下次請求會接著處理
        return jsonify({
            "detected": False,
            "processed": True,
            "reason": "too_short",
            "session_id": session_id,
        })

    if DEBUG_SCORE or detected:
        print(
            f"[OWW] {session_id} | "
            f"hit={final_hits}/{MIN_CONSECUTIVE} | "
            f"prob={prob_max:.3f} | raw={raw_max:.3f} | det={detected}"
            f"{' | reset' if reset_requested else ''}"
        )

    return jsonify({
        "detected": detected,
        "processed": True,
        "prob_score": round(prob_max, 4),
        "raw_score": round(raw_max, 4),
        "local_hits": final_hits,
        "session_id": session_id,
    })

if __name__ == "__main__":
    # 開發環境：使用 threaded=True 允許並發請求（同一 session 依序處理，不同 session 可並行）
    # 生產環境：請使用上方 gunicorn 指令
    # 預設只綁 127.0.0.1：Node 與本服務同容器，不需要對外開放；
    # /pause_all 等管理端點沒有任何驗證。若要跨容器使用請明確設定 OWW_HOST。
    app.run(host=os.environ.get("OWW_HOST", "127.0.0.1"), port=HTTP_PORT, debug=False, use_reloader=False, threaded=True)
