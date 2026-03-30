"""
Vosk 本地語音辨識微服務
接收 WAV 音訊，回傳辨識文字
"""

import os
import io
import wave
import json
import struct
import logging
from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse
from vosk import Model, KaldiRecognizer, SetLogLevel

# ====== 設定 ======
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH = os.environ.get("VOSK_MODEL_PATH", os.path.join(BASE_DIR, "models", "vosk-model-small-cn-0.22"))
SAMPLE_RATE = 16000
PORT = int(os.environ.get("VOSK_PORT", 5050))

# 降低 Vosk 日誌噪音
SetLogLevel(-1)

logging.basicConfig(level=logging.INFO, format="[Vosk] %(asctime)s %(message)s")
logger = logging.getLogger(__name__)

# ====== 載入模型 ======
logger.info(f"正在載入 Vosk 模型：{MODEL_PATH}")

if not os.path.exists(MODEL_PATH):
    logger.error(f"模型不存在：{MODEL_PATH}")
    logger.error("請下載模型：https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip")
    raise FileNotFoundError(f"Vosk model not found: {MODEL_PATH}")

model = Model(MODEL_PATH)
logger.info("Vosk 模型載入完成 ✅")

# ====== FastAPI ======
app = FastAPI(title="Vosk STT Server")


@app.get("/health")
async def health():
    """健康檢查"""
    return {"status": "ok", "model": MODEL_PATH}


@app.post("/recognize")
async def recognize(file: UploadFile = File(...)):
    """
    接收音訊檔案，回傳辨識結果
    支援格式：
      - WAV (16kHz mono s16le)
      - RAW PCM (16kHz mono s16le)
    """
    try:
        audio_data = await file.read()
        filename = file.filename or "audio"

        logger.info(f"收到音訊：{filename}，大小：{len(audio_data)} bytes")

        if len(audio_data) < 100:
            return JSONResponse({"text": "", "error": "audio too short"})

        pcm_data = extract_pcm(audio_data)

        if pcm_data is None or len(pcm_data) < 100:
            return JSONResponse({"text": "", "error": "failed to extract PCM"})

        # 🆕 SetWords(True) 取得每字信心分數
        recognizer = KaldiRecognizer(model, SAMPLE_RATE)
        recognizer.SetWords(True)

        chunk_size = 4000
        for i in range(0, len(pcm_data), chunk_size):
            chunk = pcm_data[i:i + chunk_size]
            recognizer.AcceptWaveform(chunk)

        result = json.loads(recognizer.FinalResult())
        text = result.get("text", "").strip()
        words = result.get("result", [])  # 🆕 每字詳細資訊
        avg_conf = (                       # 🆕 計算平均信心分數
            sum(w.get("conf", 0) for w in words) / len(words)
            if words else 0.0
        )

        logger.info(f"辨識結果：「{text}」avg_conf={avg_conf:.2f}")

        return JSONResponse({
            "text": text,
            "words": words,        # 🆕
            "avg_conf": avg_conf,  # 🆕
        })

    except Exception as e:
        logger.error(f"辨識失敗：{e}")
        return JSONResponse({"text": "", "error": str(e)}, status_code=500)


@app.post("/recognize-raw")
async def recognize_raw(file: UploadFile = File(...)):
    """
    接收 RAW PCM 音訊（16kHz mono s16le），回傳辨識結果
    用於 Node.js 直接傳送降採樣後的 PCM buffer
    """
    try:
        pcm_data = await file.read()

        logger.info(f"收到 RAW PCM，大小：{len(pcm_data)} bytes")

        if len(pcm_data) < 100:
            return JSONResponse({"text": "", "error": "audio too short"})

        # 🆕 SetWords(True) 取得每字信心分數
        recognizer = KaldiRecognizer(model, SAMPLE_RATE)
        recognizer.SetWords(True)

        chunk_size = 4000
        for i in range(0, len(pcm_data), chunk_size):
            chunk = pcm_data[i:i + chunk_size]
            recognizer.AcceptWaveform(chunk)

        result = json.loads(recognizer.FinalResult())
        text = result.get("text", "").strip()
        words = result.get("result", [])  # 🆕
        avg_conf = (                       # 🆕
            sum(w.get("conf", 0) for w in words) / len(words)
            if words else 0.0
        )

        logger.info(f"辨識結果：「{text}」avg_conf={avg_conf:.2f}")

        return JSONResponse({
            "text": text,
            "words": words,        # 🆕
            "avg_conf": avg_conf,  # 🆕
        })

    except Exception as e:
        logger.error(f"辨識失敗：{e}")
        return JSONResponse({"text": "", "error": str(e)}, status_code=500)


def extract_pcm(audio_data: bytes) -> bytes | None:
    """從 WAV 或 RAW 資料中提取 PCM"""
    try:
        wav_io = io.BytesIO(audio_data)
        with wave.open(wav_io, "rb") as wf:
            if wf.getnchannels() != 1 or wf.getsampwidth() != 2:
                logger.warning(f"WAV 格式不符：channels={wf.getnchannels()}, sampwidth={wf.getsampwidth()}")
            frames = wf.readframes(wf.getnframes())
            return frames
    except wave.Error:
        logger.info("非 WAV 格式，當作 RAW PCM 處理")
        return audio_data


if __name__ == "__main__":
    import uvicorn
    logger.info(f"啟動 Vosk 伺服器，port: {PORT}")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")