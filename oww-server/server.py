# server.py — Shared-Model OWW HTTP Server (修正版)
import logging
import os
import threading
import time
import gc
from pathlib import Path
from typing import Dict, Optional

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

# 是否定期手動 gc
ENABLE_GC_CLEANUP = os.environ.get("OWW_ENABLE_GC_CLEANUP", "1") == "1"

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
    重點：
    這裡不再持有 Model。
    每個 session 只保留 paused / cooldown / last_active 這類輕量狀態。
    """

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.last_trigger_ts = 0.0
        self.paused = False
        self.created_at = time.time()
        self.last_active = time.time()

    def reset(self):
        self.last_trigger_ts = 0.0

    def close(self):
        """
        session 不再持有 ONNX Model，所以這裡不用釋放大型資源。
        保留此方法是為了相容 SessionManager 的清理流程。
        """
        pass


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

        if expired:
            if ENABLE_GC_CLEANUP:
                gc.collect()

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

check_model_files(MODEL_PATH)

# =========================================================
# Shared OpenWakeWord Model
# =========================================================
print("[OWW] 載入共享模型中...")

SHARED_MODEL = Model(
    wakeword_models=[str(MODEL_PATH)],
    inference_framework="onnx",
)

MODEL_NAMES = list(SHARED_MODEL.models.keys())
if not MODEL_NAMES:
    raise RuntimeError("[OWW] 沒有載入任何模型")

TARGET_NAME = MODEL_NAMES[0]
SHARED_MODEL_LOCK = threading.Lock()

print(f"[OWW] 共享模型載入完成 ✅ target={TARGET_NAME}")

session_manager = SessionManager(max_sessions=MAX_SESSIONS)


# =========================================================
# Shared Inference
# =========================================================
def predict_chunks_shared(audio_np: np.ndarray, num_chunks: int):
    """
    使用單一共享 OWW Model 推理。
    """
    local_hits = 0
    detected = False
    prob_max = 0.0
    raw_max = float("-inf")

    with SHARED_MODEL_LOCK:
        try:
            if hasattr(SHARED_MODEL, "reset"):
                SHARED_MODEL.reset()
        except Exception as e:
            print(f"[OWW] ⚠️ shared model reset 失敗: {e}")

        for i in range(num_chunks):
            chunk = audio_np[i * CHUNK_SIZE:(i + 1) * CHUNK_SIZE]

            prediction = SHARED_MODEL.predict(chunk)
            
            # 修正：模型直接輸出 0~1 的機率值，不再需要 sigmoid 轉換
            raw = float(prediction.get(TARGET_NAME, 0.0))
            prob = raw 

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
                break

    if raw_max == float("-inf"):
        raw_max = 0.0

    return detected, raw_max, prob_max, local_hits


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
        "shared_model": True,
        "max_detect_sec": MAX_DETECT_SEC,
        "max_detect_bytes": MAX_DETECT_BYTES,
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

    if len(pcm_bytes) > MAX_DETECT_BYTES:
        pcm_bytes = pcm_bytes[:MAX_DETECT_BYTES]

    session = session_manager.get_or_create(session_id)

    if session.paused:
        return jsonify({
            "detected": False,
            "reason": "paused",
            "session_id": session_id,
        })

    audio_np = np.frombuffer(pcm_bytes, dtype=np.int16)
    num_chunks = len(audio_np) // CHUNK_SIZE

    if num_chunks <= 0:
        return jsonify({
            "detected": False,
            "reason": "too_short",
            "session_id": session_id,
        })

    now = time.time()
    cooldown_remaining = COOLDOWN_SEC - (now - session.last_trigger_ts)

    if cooldown_remaining > 0:
        return jsonify({
            "detected": False,
            "reason": "cooldown",
            "cooldown_remaining": round(cooldown_remaining, 2),
            "session_id": session_id,
        })

    detected, raw_max, prob_max, local_hits = predict_chunks_shared(audio_np, num_chunks)

    if detected:
        session.last_trigger_ts = time.time()

    if DEBUG_SCORE or detected:
        print(f"[OWW] {session_id} | hit={local_hits}/{MIN_CONSECUTIVE} | prob={prob_max:.3f} | raw={raw_max:.3f} | det={detected}")

    return jsonify({
        "detected": detected,
        "prob_score": round(prob_max, 4),
        "raw_score": round(raw_max, 4),
        "local_hits": local_hits,
        "session_id": session_id,
    })

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=HTTP_PORT, debug=False, use_reloader=False)