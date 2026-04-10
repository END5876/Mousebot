# server.py
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

# =========================================================
# Config
# =========================================================
BASE_DIR = Path(__file__).resolve().parent

MODEL_PATH = Path(os.environ.get("OWW_MODEL_PATH", str(BASE_DIR / "models" / "hey_ji_qi_niao.onnx")))
HTTP_PORT = int(os.environ.get("OWW_PORT", "5051"))
WS_PORT = int(os.environ.get("OWW_WS_PORT", "5052"))

SAMPLE_RATE = 16000
CHUNK_SIZE = int(os.environ.get("OWW_CHUNK_SIZE", "1280"))  # 80ms @ 16kHz
CHUNK_BYTES = CHUNK_SIZE * 2  # int16 => 2 bytes/sample

# 你指定的觸發條件
PROB_THRESHOLD = float(os.environ.get("OWW_PROB_THRESHOLD", "0.9"))  # prob > 0.9 trigger

# 改善穩定度
MIN_CONSECUTIVE = int(os.environ.get("OWW_MIN_CONSECUTIVE", "2"))
COOLDOWN_SEC = float(os.environ.get("OWW_COOLDOWN_SEC", "1.2"))

# 是否回傳 debug 資訊
DEBUG_SCORE = os.environ.get("OWW_DEBUG_SCORE", "1") == "1"

app = Flask(__name__)

# =========================================================
# Utilities
# =========================================================
def sigmoid(x: float) -> float:
    # 避免 overflow
    if x >= 0:
        z = math.exp(-x)
        return 1.0 / (1.0 + z)
    else:
        z = math.exp(x)
        return z / (1.0 + z)

def check_model_files(model_path: Path):
    if not model_path.exists():
        raise FileNotFoundError(f"[OWW] 找不到模型檔: {model_path}")

    # ONNX external data 常見命名：xxx.onnx.data
    ext_data_path = Path(str(model_path) + ".data")
    if ext_data_path.exists():
        print(f"[OWW] 找到外部權重檔: {ext_data_path}")
    else:
        # 不一定每個模型都需要 .data，僅提醒
        print(f"[OWW] 提示: 未找到 {ext_data_path.name}（若模型為單檔 ONNX 可忽略）")

def build_response(
    detected: bool,
    raw_max: float,
    prob_max: float,
    chunks: int,
    duration_ms: float,
    consecutive: int = 0,
    silenced: bool = False,
    error: str = ""
) -> Dict[str, Any]:
    return {
        "detected": bool(detected),
        "raw_score": round(float(raw_max), 6),
        "prob_score": round(float(prob_max), 6),
        "threshold_prob": PROB_THRESHOLD,
        "chunks": int(chunks),
        "duration_ms": round(float(duration_ms), 2),
        "consecutive_hits": int(consecutive),
        "silenced": bool(silenced),
        "error": error
    }

# =========================================================
# Model bootstrap
# =========================================================
print("[OWW] 啟動中...")
print(f"[OWW] MODEL_PATH={MODEL_PATH}")
print(f"[OWW] PROB_THRESHOLD={PROB_THRESHOLD}, MIN_CONSECUTIVE={MIN_CONSECUTIVE}, COOLDOWN_SEC={COOLDOWN_SEC}")

check_model_files(MODEL_PATH)

oww_model = Model(
    wakeword_models=[str(MODEL_PATH)],
    inference_framework="onnx"
)

MODEL_NAMES = list(oww_model.models.keys())
if not MODEL_NAMES:
    raise RuntimeError("[OWW] 沒有載入任何模型")

TARGET_NAME = MODEL_NAMES[0]
print(f"[OWW] 模型載入完成 ✅ names={MODEL_NAMES}, target={TARGET_NAME}")

# openwakeword 模型通常含狀態，需鎖保護
model_lock = threading.Lock()

def reset_model_state():
    """重置 OWW 模型內部滑動視窗狀態與特徵緩衝區"""
    try:
        # 正確的重置方式是調用 oww_model.reset()，這會清空特徵提取器與預測緩存
        if hasattr(oww_model, 'reset'):
            oww_model.reset()
        else:
            # 僅作為極舊版本的 Fallback
            for name in MODEL_NAMES:
                if hasattr(oww_model, "prediction_buffer") and name in oww_model.prediction_buffer:
                    oww_model.prediction_buffer[name] = [0.0] * len(oww_model.prediction_buffer[name])
    except Exception as e:
        print(f"[OWW] ⚠️ reset_model_state 失敗（非致命）：{e}")

def infer_chunks(audio_np: np.ndarray):
    """
    以 CHUNK_SIZE 分塊推理，回傳：
    detected, raw_max, prob_max, num_chunks, final_consecutive
    """
    num_chunks = len(audio_np) // CHUNK_SIZE
    raw_max = float("-inf")
    prob_max = 0.0
    detected = False
    consecutive = 0

    with model_lock:
        for i in range(num_chunks):
            chunk = audio_np[i * CHUNK_SIZE:(i + 1) * CHUNK_SIZE]
            prediction = oww_model.predict(chunk)

            raw = float(prediction.get(TARGET_NAME, 0.0))
            prob = sigmoid(raw)

            if raw > raw_max:
                raw_max = raw
            if prob > prob_max:
                prob_max = prob

            if prob > PROB_THRESHOLD:
                consecutive += 1
            else:
                consecutive = 0

            if consecutive >= MIN_CONSECUTIVE:
                detected = True
                # 可提早退出，降低延遲
                break

    if raw_max == float("-inf"):
        raw_max = 0.0

    return detected, raw_max, prob_max, num_chunks, consecutive

# =========================================================
# HTTP Routes
# =========================================================
@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "model_names": MODEL_NAMES,
        "target_model": TARGET_NAME,
        "sample_rate": SAMPLE_RATE,
        "chunk_size": CHUNK_SIZE,
        "prob_threshold": PROB_THRESHOLD,
        "min_consecutive": MIN_CONSECUTIVE,
        "cooldown_sec": COOLDOWN_SEC
    })

@app.route("/reset", methods=["POST"])
def reset():
    try:
        with model_lock:
            reset_model_state()
        return jsonify({"ok": True, "message": "model state reset"})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route("/detect", methods=["POST"])
def detect():
    try:
        pcm_bytes = request.data
        if not pcm_bytes:
            return jsonify(build_response(
                detected=False, raw_max=0.0, prob_max=0.0, chunks=0, duration_ms=0.0, error="empty body"
            )), 400

        audio_np = np.frombuffer(pcm_bytes, dtype=np.int16)
        total_samples = len(audio_np)
        duration_ms = total_samples / SAMPLE_RATE * 1000.0

        if total_samples < CHUNK_SIZE:
            return jsonify(build_response(
                detected=False, raw_max=0.0, prob_max=0.0, chunks=0, duration_ms=duration_ms, error="audio too short"
            )), 400

        # 補齊到 chunk 邊界
        remainder = total_samples % CHUNK_SIZE
        if remainder > 0:
            pad = np.zeros(CHUNK_SIZE - remainder, dtype=np.int16)
            audio_np = np.concatenate([audio_np, pad])

        # 單次 HTTP 偵測前，重置一次模型狀態（避免前一次請求殘留）
        with model_lock:
            reset_model_state()

        detected, raw_max, prob_max, num_chunks, consecutive = infer_chunks(audio_np)

        resp = build_response(
            detected=detected,
            raw_max=raw_max,
            prob_max=prob_max,
            chunks=num_chunks,
            duration_ms=duration_ms,
            consecutive=consecutive
        )
        return jsonify(resp)

    except Exception as e:
        return jsonify(build_response(
            detected=False, raw_max=0.0, prob_max=0.0, chunks=0, duration_ms=0.0, error=str(e)
        )), 500

# =========================================================
# WebSocket Streaming
# =========================================================
async def ws_handler(websocket, path=None):
    peer = websocket.remote_address
    print(f"[OWW-WS] 新連線: {peer}")

    remainder_buf = bytearray()
    silenced = False
    consecutive_hits = 0
    last_trigger_ts = 0.0

    # 連線建立時先 reset
    with model_lock:
        reset_model_state()

    try:
        async for message in websocket:
            # -----------------------------
            # Text command
            # -----------------------------
            if isinstance(message, str):
                cmd = message.strip().lower()

                if cmd == "reset":
                    with model_lock:
                        reset_model_state()
                    remainder_buf.clear()
                    silenced = False
                    consecutive_hits = 0
                    await websocket.send(json.dumps({"event": "reset_ok"}))
                    print("[OWW-WS] 🔄 reset 完成，恢復偵測")
                    continue

                if cmd == "ping":
                    await websocket.send(json.dumps({"event": "pong"}))
                    continue

                await websocket.send(json.dumps({"event": "unknown_command", "command": cmd}))
                continue

            # -----------------------------
            # Binary PCM
            # -----------------------------
            if silenced:
                # 靜默期間丟棄音訊，等待 reset
                continue

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

            with model_lock:
                for i in range(num_chunks):
                    chunk = audio_np[i * CHUNK_SIZE:(i + 1) * CHUNK_SIZE]
                    pred = oww_model.predict(chunk)
                    raw = float(pred.get(TARGET_NAME, 0.0))
                    prob = sigmoid(raw)

                    if raw > raw_max:
                        raw_max = raw
                    if prob > prob_max:
                        prob_max = prob

                    if prob > PROB_THRESHOLD:
                        consecutive_hits += 1
                    else:
                        consecutive_hits = 0

                    now = time.time()
                    cooldown_ok = (now - last_trigger_ts) >= COOLDOWN_SEC
                    if consecutive_hits >= MIN_CONSECUTIVE and cooldown_ok:
                        detected = True
                        last_trigger_ts = now
                        break

            if raw_max == float("-inf"):
                raw_max = 0.0

            # 回傳結果（可觀測）
            payload = {
                "event": "inference",
                "detected": detected,
                "raw_score": round(raw_max, 6),
                "prob_score": round(prob_max, 6),
                "threshold_prob": PROB_THRESHOLD,
                "chunks": num_chunks,
                "consecutive_hits": consecutive_hits,
                "silenced": silenced
            }

            # 降低噪音：沒 debug 時，只在 detected 才送
            if DEBUG_SCORE or detected:
                await websocket.send(json.dumps(payload))

            if detected:
                print(f"[OWW-WS] ✅ 偵測到喚醒詞 raw={raw_max:.4f} prob={prob_max:.4f}")
                # 進入靜默，等待上游送 reset
                silenced = True
                remainder_buf.clear()
                consecutive_hits = 0
                with model_lock:
                    reset_model_state()
                await websocket.send(json.dumps({"event": "detected_and_silenced"}))
                print("[OWW-WS] 🔇 已進入靜默期，等待 reset")

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        print(f"[OWW-WS] 錯誤: {e}")
    finally:
        print(f"[OWW-WS] 連線關閉: {peer}")

# =========================================================
# Run
# =========================================================
def run_flask():
    print(f"[OWW] HTTP 啟動於 0.0.0.0:{HTTP_PORT}")
    app.run(host="0.0.0.0", port=HTTP_PORT, debug=False, use_reloader=False)

async def run_websocket():
    print(f"[OWW] WebSocket 啟動於 0.0.0.0:{WS_PORT}")
    async with websockets.serve(
        ws_handler,
        "0.0.0.0",
        WS_PORT,
        max_size=2**22,      # 放寬訊息大小上限
        ping_interval=20,
        ping_timeout=20
    ):
        await asyncio.Future()

if __name__ == "__main__":
    flask_thread = threading.Thread(target=run_flask, daemon=True)
    flask_thread.start()
    asyncio.run(run_websocket())