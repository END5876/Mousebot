"""
OWW 喚醒詞閾值測試工具（支援 sigmoid 正規化）
"""

import argparse
import time
import sys
import os
import numpy as np

try:
    import pyaudio
except ImportError:
    print("❌ 請先安裝 pyaudio：pip install pyaudio")
    sys.exit(1)

try:
    from openwakeword.model import Model
except ImportError:
    print("❌ 請先安裝 openwakeword：pip install openwakeword")
    sys.exit(1)

# ══════════════════════════════════════════════════════════
# 參數解析
# ══════════════════════════════════════════════════════════

parser = argparse.ArgumentParser(description="OWW 喚醒詞閾值測試工具")
parser.add_argument("--model",             type=str,   default="./models/hey_ji_qi_niao.onnx")
parser.add_argument("--display-threshold", type=float, default=0.01)
parser.add_argument("--chunk-ms",          type=int,   default=80)
parser.add_argument("--duration",          type=int,   default=0)
parser.add_argument(
    "--no-sigmoid",
    action="store_true",
    help="停用 sigmoid 正規化（若模型已輸出 0~1 機率值則使用此選項）",
)
args = parser.parse_args()

USE_SIGMOID = not args.no_sigmoid

# ══════════════════════════════════════════════════════════
# 正規化函式
# ══════════════════════════════════════════════════════════

def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-float(x)))

def normalize_score(raw):
    if USE_SIGMOID:
        return sigmoid(raw)
    return float(raw)

# ══════════════════════════════════════════════════════════
# 載入模型
# ══════════════════════════════════════════════════════════

if not os.path.exists(args.model):
    print(f"❌ 找不到模型檔：{args.model}")
    sys.exit(1)

print(f"📦 載入模型：{args.model}")
print(f"🔧 sigmoid 正規化：{'✅ 啟用' if USE_SIGMOID else '❌ 停用'}")

oww_model   = Model(wakeword_models=[args.model], inference_framework="onnx")
model_names = list(oww_model.models.keys())
print(f"✅ 模型載入完成，喚醒詞：{model_names}")

# ══════════════════════════════════════════════════════════
# 音訊設定
# ══════════════════════════════════════════════════════════

SAMPLE_RATE = 16000
CHANNELS    = 1
FORMAT      = pyaudio.paInt16
CHUNK_SIZE  = int(SAMPLE_RATE * args.chunk_ms / 1000)

pa = pyaudio.PyAudio()

print("\n🎤 可用音訊輸入裝置：")
default_index = pa.get_default_input_device_info()["index"]
for i in range(pa.get_device_count()):
    info = pa.get_device_info_by_index(i)
    if info["maxInputChannels"] > 0:
        marker = " ◀ 預設" if i == default_index else ""
        print(f"  [{i}] {info['name']}{marker}")

stream = pa.open(
    format=FORMAT,
    channels=CHANNELS,
    rate=SAMPLE_RATE,
    input=True,
    frames_per_buffer=CHUNK_SIZE,
)

print("\n" + "=" * 70)
print("🎙️  開始監聽！請對麥克風說出喚醒詞")
print(f"📊  顯示閾值（正規化後）：{args.display_threshold}")
print(f"🔧  sigmoid：{'啟用' if USE_SIGMOID else '停用'}")
if args.duration > 0:
    print(f"⏱️  測試時長：{args.duration} 秒")
else:
    print("⏱️  按 Ctrl+C 結束測試")
print("=" * 70 + "\n")

# 統計用
all_scores       = []
peak_scores      = []
detection_events = []

prev_score   = 0.0
rising       = False
current_peak = 0.0
start_time   = time.time()
frame_count  = 0

try:
    while True:
        elapsed = time.time() - start_time
        if args.duration > 0 and elapsed > args.duration:
            print("\n⏱️  測試時間到！")
            break

        pcm_bytes = stream.read(CHUNK_SIZE, exception_on_overflow=False)
        audio_np  = np.frombuffer(pcm_bytes, dtype=np.int16)
        frame_count += 1

        rms        = np.sqrt(np.mean(audio_np.astype(np.float64) ** 2))
        prediction = oww_model.predict(audio_np)

        for name, raw_score in prediction.items():
            score_val = normalize_score(raw_score)

            # 峰值追蹤
            if score_val > prev_score:
                rising       = True
                current_peak = max(current_peak, score_val)
            elif rising and score_val < prev_score:
                if current_peak > args.display_threshold:
                    peak_scores.append(current_peak)
                rising       = False
                current_peak = 0.0

            prev_score = score_val

            if score_val > 0.001:
                all_scores.append(score_val)

            if score_val > args.display_threshold:
                bar_len = int(min(score_val, 1.0) * 50)
                bar     = "█" * bar_len + "░" * (50 - bar_len)

                if score_val >= 0.9:
                    color, label = "\033[91m", "🔴 極高"
                elif score_val >= 0.7:
                    color, label = "\033[93m", "🟡 高"
                elif score_val >= 0.5:
                    color, label = "\033[92m", "🟢 中"
                elif score_val >= 0.3:
                    color, label = "\033[96m", "🔵 低"
                else:
                    color, label = "\033[90m", "⚪ 微"

                reset     = "\033[0m"
                raw_disp  = f"raw={raw_score:.2f}" if USE_SIGMOID else ""
                timestamp = time.strftime("%H:%M:%S")

                print(
                    f"  {timestamp} │ "
                    f"{color}{bar}{reset} │ "
                    f"正規化: {color}{score_val:.4f}{reset} │ "
                    f"{raw_disp:12} │ "
                    f"RMS: {rms:5.0f} │ "
                    f"{label}"
                )

                detection_events.append({"time": elapsed, "score": score_val, "rms": rms})

except KeyboardInterrupt:
    print("\n\n⏹️  手動停止")

finally:
    stream.stop_stream()
    stream.close()
    pa.terminate()

# ══════════════════════════════════════════════════════════
# 統計報告
# ══════════════════════════════════════════════════════════

elapsed_total = time.time() - start_time

print("\n" + "=" * 60)
print("📊  測試統計報告")
print("=" * 60)
print(f"  測試時長：{elapsed_total:.1f} 秒")
print(f"  總幀數：  {frame_count}")
print(f"  sigmoid： {'啟用' if USE_SIGMOID else '停用'}")
print(f"  非零分數：{len(all_scores)} 次")
print(f"  峰值次數：{len(peak_scores)} 次")

if len(all_scores) > 0:
    scores_np = np.array(all_scores)
    print(f"\n  ── 正規化分數統計 ──")
    print(f"  最小值：{scores_np.min():.6f}")
    print(f"  最大值：{scores_np.max():.6f}")
    print(f"  平均值：{scores_np.mean():.6f}")
    print(f"  中位數：{np.median(scores_np):.6f}")
    print(f"  P90：   {np.percentile(scores_np, 90):.6f}")
    print(f"  P95：   {np.percentile(scores_np, 95):.6f}")
    print(f"  P99：   {np.percentile(scores_np, 99):.6f}")

if len(peak_scores) > 0:
    peaks_np = np.array(peak_scores)
    print(f"\n  ── 峰值統計 ──")
    for i, p in enumerate(peak_scores):
        status = "✅ 喚醒詞" if p >= 0.5 else "⚠️ 可能誤觸"
        print(f"  峰值 #{i+1}：{p:.6f}  {status}")
    print(f"\n  峰值最小：{peaks_np.min():.6f}")
    print(f"  峰值最大：{peaks_np.max():.6f}")
    print(f"  峰值平均：{peaks_np.mean():.6f}")

print(f"\n  ── 各閾值下的觸發次數（正規化後）──")
thresholds_to_test = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99]
for t in thresholds_to_test:
    count      = sum(1 for e in detection_events if e["score"] >= t)
    peak_count = sum(1 for p in peak_scores if p >= t) if peak_scores else 0
    bar        = "▓" * min(count, 30)
    print(f"  閾值 {t:<5} │ 觸發幀: {count:>4} │ 峰值次數: {peak_count:>3} │ {bar}")

print(f"\n  ── 建議 ──")
if len(peak_scores) > 0:
    min_peak = min(peak_scores)
    max_peak = max(peak_scores)
    print(f"  ✅ 喚醒詞分數範圍：{min_peak:.4f} ~ {max_peak:.4f}")
    print(f"  💡 建議閾值：{round(min_peak * 0.9, 3)}（最低峰值的 90%）")
    print(f"     保守值：  {round(min_peak * 0.95, 3)}（最低峰值的 95%，減少誤觸發）")
    print(f"     敏感值：  {round(min_peak * 0.8, 3)}（最低峰值的 80%，更容易觸發）")
else:
    print("  ⚠️ 沒有偵測到任何峰值")

print("\n" + "=" * 60)