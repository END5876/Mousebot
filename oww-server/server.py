from flask import Flask, request, jsonify
import numpy as np
import openwakeword
from openwakeword.model import Model
import os
import threading
import asyncio
import websockets
import json

app = Flask(__name__)

MODEL_PATH = os.environ.get("OWW_MODEL_PATH", "./models/ji_qi_niao.onnx")
THRESHOLD  = float(os.environ.get("OWW_THRESHOLD", "0.05"))

print(f"[OWW] 載入模型：{MODEL_PATH}，閾值：{THRESHOLD}")
oww_model = Model(
    wakeword_models=[MODEL_PATH],
    inference_framework="onnx"
)
print("[OWW] 模型載入完成 ✅")

CHUNK_SIZE   = 1280
MODEL_NAMES  = list(oww_model.models.keys())
print(f"[OWW] 已載入模型名稱：{MODEL_NAMES}")

model_lock = threading.Lock()


def reset_model_state():
    """重置 OWW 模型內部滑動窗口狀態"""
    try:
        for name in MODEL_NAMES:
            if name in oww_model.prediction_buffer:
                oww_model.prediction_buffer[name] = [0.0] * len(oww_model.prediction_buffer[name])
    except Exception as e:
        print(f"[OWW] ⚠️ reset 失敗（非致命）：{e}")


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "model": MODEL_NAMES,
        "threshold": THRESHOLD
    })


@app.route("/detect", methods=["POST"])
def detect():
    pcm_bytes = request.data
    if not pcm_bytes:
        return jsonify({"detected": False, "score": 0.0, "chunks": 0,
                        "duration_ms": 0.0, "error": "empty body"}), 400

    audio_np      = np.frombuffer(pcm_bytes, dtype=np.int16)
    total_samples = len(audio_np)
    duration_ms   = total_samples / 16000 * 1000

    if total_samples < CHUNK_SIZE:
        return jsonify({"detected": False, "score": 0.0, "chunks": 0,
                        "duration_ms": round(duration_ms, 1), "error": "audio too short"})

    remainder = total_samples % CHUNK_SIZE
    if remainder > 0:
        padding  = np.zeros(CHUNK_SIZE - remainder, dtype=np.int16)
        audio_np = np.concatenate([audio_np, padding])

    num_chunks = len(audio_np) // CHUNK_SIZE
    max_score  = 0.0
    detected   = False

    with model_lock:
        reset_model_state()
        for i in range(num_chunks):
            chunk      = audio_np[i * CHUNK_SIZE:(i + 1) * CHUNK_SIZE]
            prediction = oww_model.predict(chunk)
            for _, score in prediction.items():
                score_val = float(score)
                if score_val > max_score:
                    max_score = score_val
                if score_val >= THRESHOLD:
                    detected = True

    return jsonify({
        "detected":    bool(detected),
        "score":       round(float(max_score), 4),
        "chunks":      num_chunks,
        "duration_ms": round(duration_ms, 1)
    })


# ══════════════════════════════════════════════════════════
# WebSocket 串流偵測
# ══════════════════════════════════════════════════════════

async def ws_handler(websocket, path=None):
    peer = websocket.remote_address
    print(f"[OWW-WS] 新連線：{peer}")

    remainder_buf = bytearray()

    # 🔑 每個連線獨立的「靜默期」旗標
    #    偵測到喚醒詞後，進入靜默期，丟棄所有音訊直到收到 reset
    silenced = False

    try:
        async for message in websocket:

            # ── 文字指令 ──────────────────────────────────
            if isinstance(message, str):
                cmd = message.strip().lower()
                if cmd == "reset":
                    with model_lock:
                        reset_model_state()
                    remainder_buf.clear()
                    silenced = False   # 🔑 解除靜默
                    await websocket.send(json.dumps({"event": "reset_ok"}))
                    print("[OWW-WS] 🔄 reset 完成，恢復偵測")
                continue

            # 🔑 靜默期間：丟棄所有音訊，不推理
            if silenced:
                continue

            # ── 二進位 PCM ────────────────────────────────
            remainder_buf.extend(message)

            chunk_bytes = CHUNK_SIZE * 2  # int16 = 2 bytes/sample
            if len(remainder_buf) < chunk_bytes:
                continue

            usable = (len(remainder_buf) // chunk_bytes) * chunk_bytes
            pcm_bytes = bytes(remainder_buf[:usable])
            del remainder_buf[:usable]

            audio_np   = np.frombuffer(pcm_bytes, dtype=np.int16)
            num_chunks = len(audio_np) // CHUNK_SIZE

            max_score = 0.0
            detected  = False

            with model_lock:
                for i in range(num_chunks):
                    chunk      = audio_np[i * CHUNK_SIZE:(i + 1) * CHUNK_SIZE]
                    prediction = oww_model.predict(chunk)
                    for _, score in prediction.items():
                        score_val = float(score)
                        if score_val > max_score:
                            max_score = score_val
                        if score_val >= THRESHOLD:
                            detected = True

            if max_score > 0.01 or detected:
                await websocket.send(json.dumps({
                    "detected": detected,
                    "score":    round(max_score, 4),
                    "chunks":   num_chunks,
                }))

            if detected:
                print(f"[OWW-WS] ✅ 偵測到喚醒詞！分數：{max_score:.4f}")

                # 🔑 偵測到後立刻：
                #    1. 進入靜默期（丟棄後續所有音訊）
                #    2. 重置模型（清空 prediction_buffer）
                #    3. 清空殘留 buffer
                silenced = True
                with model_lock:
                    reset_model_state()
                remainder_buf.clear()
                print("[OWW-WS] 🔇 進入靜默期，等待 Node.js 送 reset 解除")

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        print(f"[OWW-WS] 錯誤：{e}")
    finally:
        print(f"[OWW-WS] 連線關閉：{peer}")


# ══════════════════════════════════════════════════════════
# 啟動
# ══════════════════════════════════════════════════════════

def run_flask():
    port = int(os.environ.get("OWW_PORT", 5051))
    print(f"[OWW] HTTP 啟動於 port {port}")
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)


async def run_websocket():
    ws_port = int(os.environ.get("OWW_WS_PORT", 5052))
    print(f"[OWW] WebSocket 啟動於 port {ws_port}")
    async with websockets.serve(ws_handler, "0.0.0.0", ws_port):
        await asyncio.Future()


if __name__ == "__main__":
    flask_thread = threading.Thread(target=run_flask, daemon=True)
    flask_thread.start()
    asyncio.run(run_websocket())