// handlers/voice/sttConfig.js
// 環境變數、常數設定、工具函式、Semaphore

const http = require('http');
const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const bootSummary = require('../../utils/bootSummary');

// ── 路徑設定 ────────────────────────────────────────────
const WAKEUP_VOICE_PATH = path.join(__dirname, 'sttwakeupvoice.wav');
const TEMP_DIR          = path.join(__dirname, '../../temp');

// ── 環境變數常數 ─────────────────────────────────────────
const OWW_HTTP_URL          = process.env.OWW_HTTP_URL;
const RECORD_MAX_MS         = parseInt(process.env.STT_RECORD_MS,          10);
const RECORD_SILENCE_MS     = parseInt(process.env.STT_SILENCE_MS,         10);
const WAKEUP_COOLDOWN_MS    = parseInt(process.env.STT_COOLDOWN_MS,        10);
const RMS_THRESHOLD         = parseFloat(process.env.STT_RMS_THRESHOLD);

// 滑動視窗大小 (建議 2500 ~ 3000 ms)
const DETECT_WINDOW_MS      = parseInt(process.env.STT_DETECT_WINDOW_MS,   10);
// 週期性檢查間隔 (建議 500 ms)
const DETECT_INTERVAL_MS    = parseInt(process.env.STT_DETECT_INTERVAL_MS || '500', 10);

const MAX_DETECT_CHUNKS     = parseInt(process.env.STT_MAX_DETECT_CHUNKS,  10);
const MAX_RECORD_BYTES      = parseInt(process.env.STT_MAX_RECORD_BYTES,   10);
const VAD_AMP_THRESHOLD     = parseFloat(process.env.STT_VAD_THRESHOLD);
const VAD_VOICE_RATIO_MIN   = parseFloat(process.env.STT_VAD_RATIO_MIN);
const MIN_AUDIO_DURATION_MS = parseInt(process.env.STT_MIN_DURATION_MS,    10);
const START_DELAY_MS        = parseInt(process.env.STT_START_DELAY_MS,     10);
const NO_SPEECH_THRESHOLD   = parseFloat(process.env.STT_NO_SPEECH_PROB);
const OWW_MAX_SOCKETS       = parseInt(process.env.STT_OWW_MAX_SOCKETS    || '8',  10);
const OWW_MAX_CONCURRENT    = parseInt(process.env.STT_OWW_MAX_CONCURRENT || '4',  10);
const STT_USER_IDLE_MS      = parseInt(process.env.STT_USER_IDLE_MS       || '600000', 10);
const STT_USER_CLEANUP_INTERVAL_MS = parseInt(process.env.STT_USER_CLEANUP_INTERVAL_MS || '60000', 10);

// Semaphore 佇列上限，防止 OWW 服務異常時無限積累等待者
// 預設為 OWW_MAX_CONCURRENT 的 2 倍，超過時直接拒絕新請求
const OWW_SEMAPHORE_QUEUE_MAX = parseInt(process.env.STT_OWW_QUEUE_MAX || String(OWW_MAX_CONCURRENT * 2), 10);

// ── 衍生常數 ─────────────────────────────────────────────
const SAMPLE_RATE         = 16000;
const DETECT_MAX_BYTES    = SAMPLE_RATE * (DETECT_WINDOW_MS / 1000) * 2;
const VAD_FRAME_SIZE_MS   = 20;
const VAD_FRAME_SAMPLES   = (SAMPLE_RATE * VAD_FRAME_SIZE_MS) / 1000;
const VAD_FRAME_BYTES     = VAD_FRAME_SAMPLES * 2;
const SILENCE_CHECK_MS    = 100;

// ── 環境變數檢查 ─────────────────────────────────────────
const requiredEnvVars = [
  'OWW_HTTP_URL', 'STT_RECORD_MS', 'STT_SILENCE_MS', 'STT_COOLDOWN_MS',
  'STT_RMS_THRESHOLD', 'STT_DETECT_WINDOW_MS', 'STT_MAX_DETECT_CHUNKS',
  'STT_MAX_RECORD_BYTES', 'STT_VAD_THRESHOLD', 'STT_VAD_RATIO_MIN',
  'STT_MIN_DURATION_MS', 'STT_START_DELAY_MS', 'STT_NO_SPEECH_PROB',
  'GROQ_API_KEY',
];

const missingVars = requiredEnvVars.filter(v => process.env[v] === undefined);

if (missingVars.length > 0) {
  bootSummary.report('語音辨識 STT', 'off', `缺少環境變數: ${missingVars.join(', ')}`);
} else {
  bootSummary.report('語音辨識 STT', 'ok', '喚醒詞偵測 + Groq Whisper 已就緒');
}

// ══════════════════════════════════════════════════════════
// Semaphore（OWW 並發控制）
// [修正 JS-9] 加入 maxQueue 上限，OWW 服務異常時拒絕超量等待者，
//             避免 _queue 無限增長造成記憶體壓力。
// ══════════════════════════════════════════════════════════
class Semaphore {
  /**
   * @param {number} max      最大並發數
   * @param {number} maxQueue 等待佇列上限，超過時 acquire() 拋出錯誤
   */
  constructor(max, maxQueue = Infinity) {
    this._max      = max;
    this._maxQueue = maxQueue;
    this._current  = 0;
    this._queue    = [];
  }

  acquire() {
    return new Promise((resolve, reject) => {
      if (this._current < this._max) {
        this._current++;
        resolve();
        return;
      }

      // 佇列已滿時直接拒絕，而非無限等待
      if (this._queue.length >= this._maxQueue) {
        reject(new Error(`[Semaphore] 佇列已滿 (max=${this._maxQueue})，拒絕新請求`));
        return;
      }

      this._queue.push(resolve);
    });
  }

  release() {
    if (this._current > 0) this._current--;

    if (this._queue.length > 0 && this._current < this._max) {
      this._current++;
      this._queue.shift()();
    }
  }

  /** 目前等待中的請求數（供監控使用） */
  get queueLength() {
    return this._queue.length;
  }
}

const owwSemaphore = new Semaphore(OWW_MAX_CONCURRENT, OWW_SEMAPHORE_QUEUE_MAX);

// ── 帶連線池的 axios instance ───────────────────────────
const owwAgent = new http.Agent({ maxSockets: OWW_MAX_SOCKETS, keepAlive: true });
const owwAxios = axios.create({ httpAgent: owwAgent, timeout: 3000 });

// ══════════════════════════════════════════════════════════
// 工具函式
// ══════════════════════════════════════════════════════════
function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// 啟動時清理 temp 目錄中超過指定時間的殘留 .wav 檔案，
// 防止程序異常退出（SIGKILL）後磁碟空間逐漸耗盡。
function cleanupStaleTempFiles(maxAgeMs = 10 * 60 * 1000) {
  try {
    if (!fs.existsSync(TEMP_DIR)) return;
    const now   = Date.now();
    const files = fs.readdirSync(TEMP_DIR);
    let   count = 0;

    for (const f of files) {
      if (!f.endsWith('.wav')) continue;
      const fullPath = path.join(TEMP_DIR, f);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fullPath);
          count++;
        }
      } catch {}
    }

    if (count > 0) {
      console.log(`[STT] 🧹 清理殘留 temp 檔案：${count} 個`);
    }
  } catch (err) {
    console.warn(`[STT] temp 清理失敗：${err.message}`);
  }
}

function safeUnlink(f) {
  try { fs.unlinkSync(f); } catch {}
}

async function writeWav(filename, pcmBuffer) {
  const sampleRate    = 16000;
  const numChannels   = 1;
  const bitsPerSample = 16;
  const byteRate      = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign    = numChannels * bitsPerSample / 8;
  const dataSize      = pcmBuffer.length;
  const header        = Buffer.alloc(44);

  header.write('RIFF',                0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE',                8);
  header.write('fmt ',               12);
  header.writeUInt32LE(16,           16);
  header.writeUInt16LE(1,            20);
  header.writeUInt16LE(numChannels,  22);
  header.writeUInt32LE(sampleRate,   24);
  header.writeUInt32LE(byteRate,     28);
  header.writeUInt16LE(blockAlign,   32);
  header.writeUInt16LE(bitsPerSample,34);
  header.write('data',               36);
  header.writeUInt32LE(dataSize,     40);

  await fs.promises.writeFile(filename, Buffer.concat([header, pcmBuffer]));
}

function calcRMS(pcmBuffer) {
  const samples = pcmBuffer.length / 2;
  if (samples === 0) return 0;

  let sumSq = 0;
  for (let i = 0; i < pcmBuffer.length; i += 2) {
    const sample = pcmBuffer.readInt16LE(i);
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / samples);
}

function calcVoiceRatio(pcmBuffer) {
  const totalFrames = Math.floor(pcmBuffer.length / VAD_FRAME_BYTES);
  if (totalFrames === 0) return 0;

  let voiceFrames = 0;
  for (let i = 0; i < totalFrames; i++) {
    const start = i * VAD_FRAME_BYTES;
    const frame = pcmBuffer.slice(start, start + VAD_FRAME_BYTES);
    let ampSum = 0;
    for (let j = 0; j < frame.length; j += 2) {
      ampSum += Math.abs(frame.readInt16LE(j));
    }
    if (ampSum / (frame.length / 2) > VAD_AMP_THRESHOLD) voiceFrames++;
  }
  return voiceFrames / totalFrames;
}

function calcDurationMs(pcmBuffer) {
  return (pcmBuffer.length / 2 / SAMPLE_RATE) * 1000;
}

const HALLUCINATION_PATTERNS = [
  '请不吝点赞', '订阅', '明镜与点点', 'Amara.org',
  '字幕由', '感謝收看', '請訂閱', '敬请订阅',
];

function isHallucination(text) {
  return HALLUCINATION_PATTERNS.some(p => text.includes(p));
}

// ── OWW HTTP 偵測（含 Semaphore）────────────────────────
async function detectWakeword(guildId, userId, pcmBuffer) {
  // 可能因佇列已滿而拋出錯誤，呼叫端需自行捕獲
  await owwSemaphore.acquire();
  try {
    const sessionId = `${guildId}_${userId}`;
    const response  = await owwAxios.post(
      `${OWW_HTTP_URL}/detect?session_id=${sessionId}`,
      pcmBuffer,
      { headers: { 'Content-Type': 'application/octet-stream' } },
    );
    return response.data;
  } catch (err) {
    console.error(`[STT] OWW 偵測失敗 (${userId}): ${err.message}`);
    return { detected: false };
  } finally {
    owwSemaphore.release();
  }
}

module.exports = {
  WAKEUP_VOICE_PATH,
  TEMP_DIR,
  OWW_HTTP_URL,
  RECORD_MAX_MS,
  RECORD_SILENCE_MS,
  WAKEUP_COOLDOWN_MS,
  RMS_THRESHOLD,
  DETECT_WINDOW_MS,
  DETECT_INTERVAL_MS,
  DETECT_MAX_BYTES,
  MAX_DETECT_CHUNKS,
  MAX_RECORD_BYTES,
  VAD_VOICE_RATIO_MIN,
  MIN_AUDIO_DURATION_MS,
  START_DELAY_MS,
  NO_SPEECH_THRESHOLD,
  STT_USER_IDLE_MS,
  STT_USER_CLEANUP_INTERVAL_MS,
  SILENCE_CHECK_MS,
  SAMPLE_RATE,
  ensureTempDir,
  cleanupStaleTempFiles,
  safeUnlink,
  writeWav,
  calcRMS,
  calcVoiceRatio,
  calcDurationMs,
  isHallucination,
  detectWakeword,
};
