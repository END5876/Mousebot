# testmodel.py
import math
import time
import numpy as np
import sounddevice as sd
from openwakeword.model import Model
from pathlib import Path

# ===== 基本設定 =====
BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = BASE_DIR / "models" / "hey_ji_qi_niao.onnx"
CHUNK_SIZE = 1280  # 80ms @ 16kHz

# 分數門檻（注意：openwakeword 有時是 raw score，不一定是 0~1）
# 若你的輸出常 > 1，建議先當 raw score 用 sigmoid 轉機率
TRIGGER_PROB = 0.995   # 可調：0.98 / 0.995 / 0.999
MIN_CONSECUTIVE = 2    # 連續幾幀達標才觸發
COOLDOWN_SEC = 1.5     # 觸發後冷卻秒數，防連發

# ===== 載入模型 =====
if not MODEL_PATH.exists():
    raise FileNotFoundError(f"找不到模型檔：{MODEL_PATH}")

model = Model(wakeword_models=[str(MODEL_PATH)], inference_framework="onnx")
model_names = list(model.models.keys())
if not model_names:
    raise RuntimeError("未載入任何 wakeword 模型")
target_name = model_names[0]

print("已載入模型：", model_names)
print("🎤 開始監聽，請說喚醒詞...")
print("按 Ctrl+C 停止\n")

# ===== 狀態變數 =====
last_trigger_t = 0.0
consecutive_hits = 0

def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))

def callback(indata, frames, time_info, status):
    global last_trigger_t, consecutive_hits

    if status:
        print(f"⚠️ {status}")

    # 取單聲道 + int16
    audio = indata[:, 0].astype(np.int16)

    prediction = model.predict(audio)
    score = float(prediction.get(target_name, 0.0))

    # 將 raw score 轉機率（如果你的 score 本來就是 0~1，也不影響可讀性）
    prob = sigmoid(score)

    # 日誌（可改成每 N 幀印一次）
    print(f"[{target_name}] raw={score:.4f}, prob={prob:.4f}")

    # 連續幀判斷
    if prob >= TRIGGER_PROB:
        consecutive_hits += 1
    else:
        consecutive_hits = 0

    now = time.time()
    if consecutive_hits >= MIN_CONSECUTIVE and (now - last_trigger_t) >= COOLDOWN_SEC:
        print(f"✅ 偵測到喚醒詞！prob={prob:.4f}")
        last_trigger_t = now
        consecutive_hits = 0  # 重置，避免立即再次觸發

try:
    with sd.InputStream(
        samplerate=16000,
        channels=1,
        dtype="int16",
        blocksize=CHUNK_SIZE,
        callback=callback
    ):
        sd.sleep(30000)  # 監聽 30 秒
except KeyboardInterrupt:
    print("\n🛑 已停止監聽")
