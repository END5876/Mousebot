# test_model.py
import numpy as np
import sounddevice as sd
from openwakeword.model import Model

MODEL_PATH = "./models/ji_qi_niao.onnx"
THRESHOLD  = 0.5
CHUNK_SIZE = 1280  # 80ms @ 16kHz

model = Model(wakeword_models=[MODEL_PATH], inference_framework="onnx")
print(model.models.keys())

print("🎤 開始監聽，請說喚醒詞...")
print("按 Ctrl+C 停止\n")

def callback(indata, frames, time, status):

    if status:
        print(f"⚠️ {status}")
    
    audio = indata[:, 0].astype(np.int16)

    prediction = model.predict(audio)
    for name, score in prediction.items():
        if float(score) > 0.01:  # 只顯示有意義的分數
            print(f"[{name}] 分數：{float(score):.4f}")

with sd.InputStream(
    samplerate=16000,
    channels=1,
    dtype='int16',
    blocksize=CHUNK_SIZE,
    callback=callback
):
    sd.sleep(30000)  # 監聽 30 秒