// handlers/voice/sttHandler.js — Speaking-Triggered Architecture (RAM-safe)
const { EndBehaviorType, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const prism = require('prism-media');
const fs    = require('fs');
const http  = require('http');  // ✅ 修復 3：匯入 http 以建立自訂 Agent
const path  = require('path');
const axios = require('axios');
const Groq  = require('groq-sdk');
const { getGeminiResponseVoice } = require('../../handlers/ai/aiHandler');

// ── 設定（純環境變數）────────────────────────────────────
const OWW_HTTP_URL        = process.env.OWW_HTTP_URL;
const WAKEUP_VOICE_PATH   = path.join(__dirname, 'sttwakeupvoice.wav');
const TEMP_DIR            = path.join(__dirname, '../../temp');
const RECORD_MAX_MS       = parseInt(process.env.STT_RECORD_MS, 10);
const RECORD_SILENCE_MS   = parseInt(process.env.STT_SILENCE_MS, 10);
const WAKEUP_COOLDOWN_MS  = parseInt(process.env.STT_COOLDOWN_MS, 10);
const RMS_THRESHOLD       = parseFloat(process.env.STT_RMS_THRESHOLD);

// ── 喚醒偵測緩衝設定 ────────────────────────────────────
const DETECT_WINDOW_MS  = parseInt(process.env.STT_DETECT_WINDOW_MS, 10);
const SAMPLE_RATE       = 16000;
const DETECT_MAX_BYTES  = SAMPLE_RATE * (DETECT_WINDOW_MS / 1000) * 2;

// 硬上限，避免 Buffer 暴衝
const MAX_DETECT_CHUNKS = parseInt(process.env.STT_MAX_DETECT_CHUNKS, 10);
const MAX_RECORD_BYTES  = parseInt(process.env.STT_MAX_RECORD_BYTES, 10);

// ── VAD / 長度 設定 ─────────────────────────────────────
const VAD_FRAME_SIZE_MS     = 20;
const VAD_FRAME_SAMPLES     = (SAMPLE_RATE * VAD_FRAME_SIZE_MS) / 1000;
const VAD_FRAME_BYTES       = VAD_FRAME_SAMPLES * 2;
const VAD_AMP_THRESHOLD     = parseFloat(process.env.STT_VAD_THRESHOLD);
const VAD_VOICE_RATIO_MIN   = parseFloat(process.env.STT_VAD_RATIO_MIN);
const MIN_AUDIO_DURATION_MS = parseInt(process.env.STT_MIN_DURATION_MS, 10);
const START_DELAY_MS        = parseInt(process.env.STT_START_DELAY_MS, 10);

// ── 靜音偵測設定 ────────────────────────────────────────
const SILENCE_CHECK_MS = 100;

// ── no_speech_prob 閾值 ──────────────────────────────────
const NO_SPEECH_THRESHOLD = parseFloat(process.env.STT_NO_SPEECH_PROB);

// ── ✅ 修復 3：OWW 並發控制設定 ─────────────────────────
// 限制同時送往 OWW server 的 HTTP 請求數，避免多人同時說話時暴衝
const OWW_MAX_SOCKETS    = parseInt(process.env.STT_OWW_MAX_SOCKETS  || '8',  10);
const OWW_MAX_CONCURRENT = parseInt(process.env.STT_OWW_MAX_CONCURRENT || '4', 10);

// ── 環境變數檢查區塊 ────────────────────────────────────
const requiredEnvVars = [
  'OWW_HTTP_URL', 'STT_RECORD_MS', 'STT_SILENCE_MS', 'STT_COOLDOWN_MS',
  'STT_RMS_THRESHOLD', 'STT_DETECT_WINDOW_MS', 'STT_MAX_DETECT_CHUNKS',
  'STT_MAX_RECORD_BYTES', 'STT_VAD_THRESHOLD', 'STT_VAD_RATIO_MIN',
  'STT_MIN_DURATION_MS', 'STT_START_DELAY_MS', 'STT_NO_SPEECH_PROB',
  'GROQ_API_KEY'
];

const missingVars = requiredEnvVars.filter(v => process.env[v] === undefined);

if (missingVars.length > 0) {
  console.error(`[STT 錯誤] 缺少以下環境變數，請檢查 .env 檔案: ${missingVars.join(', ')}`);
} else {
  console.log('[STT] ✅ 所有環境變數載入成功');
}
// ────────────────────────────────────────────────────────

// ── Groq 客戶端 ─────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Guild 狀態 Map ───────────────────────────────────────
const guildStates = new Map();

// ── ✅ 修復 3：帶連線池的 axios instance ─────────────────
// 透過自訂 http.Agent 限制 socket 數量，防止 OWW 請求暴衝
const owwAgent = new http.Agent({ maxSockets: OWW_MAX_SOCKETS, keepAlive: true });
const owwAxios = axios.create({
  httpAgent: owwAgent,
  timeout:   3000,
});

// ── ✅ 修復 3：全局 OWW 並發 Semaphore ───────────────────
// 不依賴 socket 層，在應用層額外限制同時進行中的偵測請求數
class Semaphore {
  constructor(max) {
    this._max     = max;
    this._current = 0;
    this._queue   = [];
  }
  acquire() {
    return new Promise(resolve => {
      if (this._current < this._max) { this._current++; resolve(); }
      else { this._queue.push(resolve); }
    });
  }
  release() {
    this._current--;
    if (this._queue.length > 0) {
      this._current++;
      this._queue.shift()();
    }
  }
}
const owwSemaphore = new Semaphore(OWW_MAX_CONCURRENT);

// ══════════════════════════════════════════════════════════
// 工具函式
// ══════════════════════════════════════════════════════════
function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}
function safeUnlink(f) { try { fs.unlinkSync(f); } catch {} }

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
    for (let j = 0; j < frame.length; j += 2) ampSum += Math.abs(frame.readInt16LE(j));
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
  return HALLUCINATION_PATTERNS.some((p) => text.includes(p));
}

// ══════════════════════════════════════════════════════════
// ✅ 修復 3：HTTP 單次偵測（加入 Semaphore）
// ══════════════════════════════════════════════════════════
async function detectWakeword(guildId, userId, pcmBuffer) {
  // 在應用層限制並發數，超過上限時排隊等候，不直接送出 HTTP
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

// ══════════════════════════════════════════════════════════
// 訂閱 / 退訂使用者音訊（完整釋放）
// ══════════════════════════════════════════════════════════
function unsubscribeUser(guildId, userId) {
  const state = guildStates.get(guildId);
  if (!state) return;
  const userState = state.users.get(userId);
  if (!userState) return;

  if (userState.detectTimer) {
    clearTimeout(userState.detectTimer);
    userState.detectTimer = null;
  }

  userState.isDetecting          = false;
  userState.isDetectingRequest   = false;
  userState.detectChunks         = [];
  userState.recordChunks         = [];
  userState.detectBytes          = 0;
  userState.recordBytes          = 0;
  // ✅ 修復 2：清除快取的靜音偵測狀態
  userState._lastSilenceChunksLen = -1;
  userState._lastSilenceRMS       = 0;

  try { userState.stream?.removeAllListeners(); } catch {}
  try { userState.stream?.destroy(); } catch {}
  try { userState.opusStream?.removeAllListeners(); } catch {}
  try { userState.opusStream?.destroy(); } catch {}

  state.users.delete(userId);
}

function subscribeUser(guildId, userId, member) {
  const state = guildStates.get(guildId);
  if (!state || state.users.has(userId)) return;

  const { connection } = state;

  const userState = {
    member,
    detectChunks:  [],
    detectBytes:   0,
    recordChunks:  [],
    recordBytes:   0,
    stream:        null,
    opusStream:    null,
    cooldownUntil: 0,
    isDetecting:   false,
    isDetectingRequest: false,
    detectTimer:   null,
    // ✅ 修復 2：靜音偵測用快取欄位，避免 setInterval 每次 concat
    _lastSilenceChunksLen: -1,
    _lastSilenceRMS:        0,
  };
  state.users.set(userId, userState);

  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual },
  });
  userState.opusStream = opusStream;

  const pcmStream = opusStream.pipe(
    new prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 960 })
  );
  userState.stream = pcmStream;

  pcmStream.on('data', (chunk) => {
    if (!state.active) return;

    if (state.isExclusive) {
      if (userId === state.exclusiveUserId && state.isRecording) {
        userState.recordChunks.push(chunk);
        userState.recordBytes += chunk.length;

        while (userState.recordBytes > MAX_RECORD_BYTES && userState.recordChunks.length > 0) {
          const dropped = userState.recordChunks.shift();
          userState.recordBytes -= dropped.length;
        }
        // ✅ 修復 2：有新 chunk 時，讓快取失效以便靜音偵測重算
        userState._lastSilenceChunksLen = -1;
      }
      return;
    }

    if (userState.isDetecting) {
      userState.detectChunks.push(chunk);
      userState.detectBytes += chunk.length;

      while (
        (userState.detectBytes > DETECT_MAX_BYTES || userState.detectChunks.length > MAX_DETECT_CHUNKS) &&
        userState.detectChunks.length > 0
      ) {
        const dropped = userState.detectChunks.shift();
        userState.detectBytes -= dropped.length;
      }
    }
  });

  pcmStream.on('error', (err) => {
    console.error(`[STT] PCM 錯誤 [${userId}]: ${err.message}`);
  });

  const onEndLike = () => unsubscribeUser(guildId, userId);
  opusStream.on('end',   onEndLike);
  opusStream.on('close', onEndLike);
  opusStream.on('error', () => onEndLike());

  console.log(`[STT] 監聽：${member?.displayName || userId}`);
}

// ══════════════════════════════════════════════════════════
// 觸發偵測
// ══════════════════════════════════════════════════════════
async function triggerDetection(guildId, userId) {
  const state = guildStates.get(guildId);
  if (!state) return;

  const userState = state.users.get(userId);
  if (!userState) return;

  if (userState.isDetectingRequest) return;
  userState.isDetectingRequest = true;

  try {
    userState.isDetecting = false;
    if (userState.detectTimer) {
      clearTimeout(userState.detectTimer);
      userState.detectTimer = null;
    }

    if (state.isExclusive) return;

    const now = Date.now();
    if (now < userState.cooldownUntil) return;

    const chunks = userState.detectChunks.splice(0);
    userState.detectBytes = 0;
    if (chunks.length === 0) return;

    const pcmBuffer = Buffer.concat(chunks);
    if (calcRMS(pcmBuffer) < RMS_THRESHOLD) return;

    const result = await detectWakeword(guildId, userId, pcmBuffer);
    if (!result.detected) return;

    const name = userState.member?.displayName || userId;
    console.log(`[STT] ✅ 喚醒 ${name} (prob=${result.prob_score?.toFixed(3)})`);

    await handleWakeup(guildId, userId, userState.member);
  } catch (err) {
    console.error(`[STT] triggerDetection 錯誤: ${err.message}`);
  } finally {
    userState.isDetectingRequest = false;
  }
}

// ── 播放喚醒音效（清 listener）─────────────────────────────
function playWakeupSound(connection) {
  return new Promise((resolve) => {
    if (!fs.existsSync(WAKEUP_VOICE_PATH)) return resolve();

    let done = false;
    let player = null;

    const finish = () => {
      if (done) return;
      done = true;
      try {
        player?.stop();
        player?.removeAllListeners();
      } catch {}
      resolve();
    };

    try {
      player = createAudioPlayer();
      const resource = createAudioResource(WAKEUP_VOICE_PATH);
      player.play(resource);
      connection.subscribe(player);
      player.once(AudioPlayerStatus.Idle, finish);
      player.once('error', finish);
      setTimeout(finish, 3000);
    } catch {
      finish();
    }
  });
}

// ── ✅ 修復 4：Groq 轉文字（明確關閉 ReadStream）──────────
async function transcribeWithGroq(wavFilePath) {
  // 先建立 stream，以便在 finally 中可靠地 destroy
  const fileStream = fs.createReadStream(wavFilePath);
  try {
    const transcription = await groq.audio.transcriptions.create({
      file:            fileStream,
      model:           'whisper-large-v3',
      language:        'zh',
      response_format: 'verbose_json',
      prompt:          '以下是使用者對語音助理說的指令。',
    });

    if (transcription.segments?.length > 0) {
      const avgNoSpeech = transcription.segments.reduce(
        (sum, seg) => sum + (seg.no_speech_prob ?? 0), 0
      ) / transcription.segments.length;

      if (avgNoSpeech > NO_SPEECH_THRESHOLD) {
        console.warn(`[STT] 幻覺過濾 (no_speech=${avgNoSpeech.toFixed(2)})`);
        return '';
      }
    }

    return transcription.text?.trim() || '';
  } finally {
    // 無論 API 成功或失敗，確保 file descriptor 被釋放
    try { fileStream.destroy(); } catch {}
  }
}

// ══════════════════════════════════════════════════════════
// ✅ 修復 2：建立靜音偵測輔助函式（帶快取）
// 只有當 recordChunks 有變動時才重新 concat + calcRMS，
// 否則沿用上次結果，避免 setInterval 每 100ms 無謂分配 Buffer
// ══════════════════════════════════════════════════════════
function getCachedRecentRMS(userState) {
  const currentLen = userState.recordChunks.length;
  if (currentLen === 0) {
    userState._lastSilenceChunksLen = 0;
    userState._lastSilenceRMS       = 0;
    return 0;
  }
  // chunks 數量沒變，直接回傳快取值（isRecording 期間每次 push 會重置為 -1）
  if (currentLen === userState._lastSilenceChunksLen) {
    return userState._lastSilenceRMS;
  }
  const recentBuf = Buffer.concat(userState.recordChunks.slice(-2));
  const rms       = calcRMS(recentBuf);
  userState._lastSilenceChunksLen = currentLen;
  userState._lastSilenceRMS       = rms;
  return rms;
}

// ══════════════════════════════════════════════════════════
// 喚醒後流程（獨佔模式）
// ══════════════════════════════════════════════════════════
async function handleWakeup(guildId, userId, member) {
  const state = guildStates.get(guildId);
  if (!state || state.isExclusive) return;

  const { connection, textChannel } = state;
  const userState = state.users.get(userId);
  if (!userState) return;

  let silenceChecker = null;

  try {
    state.isExclusive     = true;
    state.exclusiveUserId = userId;
    state.isRecording     = false;

    for (const us of state.users.values()) {
      us.recordChunks         = [];
      us.recordBytes          = 0;
      us._lastSilenceChunksLen = -1;  // ✅ 修復 2：重置快取
      us._lastSilenceRMS      = 0;
    }

    const wakeupName = member?.displayName || '使用者';
    textChannel.send(`🎤 "**${wakeupName}**" 說吧，我在聽`).catch(() => {});

    state.isRecording = true;
    await playWakeupSound(connection).catch(() => {});

    // ✅ 修復 2：使用帶快取的 RMS 計算取代每次 concat
    await new Promise((resolve) => {
      let silenceAccumMs = 0;
      let totalElapsedMs = 0;

      state.recordTimer = setTimeout(() => {
        if (silenceChecker) clearInterval(silenceChecker);
        state.isRecording = false;
        state.recordTimer = null;
        console.log(`[STT] ⏱️ 錄音上限到 (${RECORD_MAX_MS}ms)`);
        resolve();
      }, RECORD_MAX_MS);

      silenceChecker = setInterval(() => {
        totalElapsedMs += SILENCE_CHECK_MS;
        if (totalElapsedMs <= START_DELAY_MS) return;

        // ✅ 修復 2：使用快取版 RMS，避免每 100ms 分配 Buffer
        const rms = getCachedRecentRMS(userState);

        if (rms < RMS_THRESHOLD) {
          silenceAccumMs += SILENCE_CHECK_MS;
        } else {
          silenceAccumMs = 0;
        }

        if (silenceAccumMs >= RECORD_SILENCE_MS && totalElapsedMs >= MIN_AUDIO_DURATION_MS) {
          if (state.recordTimer) clearTimeout(state.recordTimer);
          if (silenceChecker)    clearInterval(silenceChecker);
          state.isRecording = false;
          state.recordTimer = null;
          console.log(`[STT] 🔇 靜音截止 (${totalElapsedMs}ms)`);
          resolve();
        }
      }, SILENCE_CHECK_MS);
    });

    const recordedChunks = userState.recordChunks.splice(0);
    userState.recordBytes          = 0;
    userState._lastSilenceChunksLen = -1;
    userState._lastSilenceRMS       = 0;

    for (const us of state.users.values()) {
      us.recordChunks          = [];
      us.recordBytes           = 0;
      us._lastSilenceChunksLen = -1;
      us._lastSilenceRMS       = 0;
    }

    if (recordedChunks.length === 0) {
      await textChannel.send('❌ 沒有偵測到語音，請再試一次').catch(() => {});
      return;
    }

    const pcmBuffer  = Buffer.concat(recordedChunks);
    const durationMs = calcDurationMs(pcmBuffer);

    if (durationMs < MIN_AUDIO_DURATION_MS) {
      await textChannel.send('❌ 沒有偵測到語音，請再試一次').catch(() => {});
      return;
    }

    const voiceRatio = calcVoiceRatio(pcmBuffer);
    if (voiceRatio < VAD_VOICE_RATIO_MIN && calcRMS(pcmBuffer) < RMS_THRESHOLD) {
      await textChannel.send('❌ 沒有偵測到語音，請再試一次').catch(() => {});
      return;
    }

    ensureTempDir();
    const wavFile = path.join(TEMP_DIR, `stt_${guildId}_${userId}_${Date.now()}.wav`);
    await writeWav(wavFile, pcmBuffer);

    let text = '';
    try {
      text = await transcribeWithGroq(wavFile);  // ✅ 修復 4：stream 已在內部 destroy
    } catch (err) {
      console.error(`[STT] Groq 失敗: ${err.message}`);
      await textChannel.send('❌ 語音辨識失敗，請再試一次').catch(() => {});
      return;
    } finally {
      safeUnlink(wavFile);
    }

    if (!text || isHallucination(text)) {
      await textChannel.send('❌ 無法辨識語音內容').catch(() => {});
      return;
    }

    const finalName = state.guild.members.cache.get(userId)?.displayName || '使用者';
    console.log(`[STT] 📝 ${finalName}：${text}`);
    await textChannel.send(`🗣️ "**${finalName}**" ：${text}`).catch(() => {});

    userState.cooldownUntil = Date.now() + WAKEUP_COOLDOWN_MS;

    try {
      const aiReply = await getGeminiResponseVoice(userId, text);
      if (aiReply) {
        await textChannel.send(aiReply).catch(() => {});
        const { playTTS } = require('../ttsHandler');
        const ttsResult = await playTTS(guildId, aiReply);
        if (ttsResult.success) {
          console.log(`🔊 [STT→TTS] 朗讀中 (engine: ${ttsResult.engine}, queued: ${ttsResult.queued})`);
        } else {
          console.warn(`⚠️ [STT→TTS] 朗讀失敗 (reason: ${ttsResult.reason})`);
        }
      }
    } catch (err) {
      console.error(`[STT] AI 回覆錯誤: ${err.message}`);
      await textChannel.send('❌ AI 回覆失敗').catch(() => {});
    }
  } finally {
    if (silenceChecker) clearInterval(silenceChecker);
    exitExclusiveMode(guildId);
  }
}

// ── 退出獨佔模式 ─────────────────────────────────────────
function exitExclusiveMode(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;

  state.isExclusive     = false;
  state.exclusiveUserId = null;
  state.isRecording     = false;

  if (state.recordTimer) {
    clearTimeout(state.recordTimer);
    state.recordTimer = null;
  }
}

// ══════════════════════════════════════════════════════════
// 手動模式：初始化 Session（不需 /stt start）
// ══════════════════════════════════════════════════════════
function ensureManualSession(connection, guild, textChannel, onWakeup) {
  const guildId = guild.id;
  let state = guildStates.get(guildId);

  if (!state) {
    state = {
      active:           true,
      connection,
      guild,
      textChannel,
      onWakeup,
      users:            new Map(),
      isExclusive:      false,
      exclusiveUserId:  null,
      isRecording:      false,
      recordTimer:      null,
      _onSpeakingStart: null,
      _onSpeakingEnd:   null,
      _memTimer:        null,
      manualOnly:       true,
    };
    guildStates.set(guildId, state);
    console.log(`[STT][manual] 建立手動 Session：${guild.name}`);
  } else {
    state.active      = true;
    state.connection  = connection || state.connection;
    state.guild       = guild       || state.guild;
    state.textChannel = textChannel || state.textChannel;
    if (onWakeup) state.onWakeup = onWakeup;
  }

  return state;
}

// ══════════════════════════════════════════════════════════
// 手動單次錄音：錄音 -> STT -> callback(AI/TTS 由外部處理)
// ══════════════════════════════════════════════════════════
async function manualRecordOnce(guildId, userId, member, textChannel, onWakeupOverride) {
  const state = guildStates.get(guildId);
  if (!state || !state.active) {
    throw new Error('STT Session 不存在，請先 ensureManualSession');
  }

  const userMember = member || state.guild?.members?.cache?.get(userId);
  if (!userMember || userMember.user?.bot) {
    throw new Error('無效的使用者');
  }

  // ✅ 修復 1：追蹤此次呼叫是否為新訂閱，用於異常路徑的清理判斷
  const wasNewlySubscribed = !state.users.has(userId);
  if (wasNewlySubscribed) {
    subscribeUser(guildId, userId, userMember);
  }

  const userState = state.users.get(userId);
  if (!userState) throw new Error('建立使用者音訊訂閱失敗');

  if (state.isExclusive) {
    // ✅ 修復 1：若因衝突提早返回且是此次新訂閱，需同步清理
    // 注意：opusStream 'end'/'close' 最終也會清理，但立即清理可更快釋放資源
    if (wasNewlySubscribed) unsubscribeUser(guildId, userId);
    throw new Error('目前已有錄音流程進行中，請稍後');
  }

  let silenceChecker    = null;
  let recordingStarted  = false;  // ✅ 修復 1：標記是否已進入獨佔錄音流程
  const targetTextChannel = textChannel || state.textChannel;

  try {
    state.isExclusive     = true;
    state.exclusiveUserId = userId;
    state.isRecording     = false;
    recordingStarted      = true;

    for (const us of state.users.values()) {
      us.recordChunks          = [];
      us.recordBytes           = 0;
      us._lastSilenceChunksLen = -1;  // ✅ 修復 2：重置快取
      us._lastSilenceRMS       = 0;
    }

    const wakeupName = userMember?.displayName || '使用者';
    await targetTextChannel?.send(`🎤 "**${wakeupName}**" 手動錄音已開始，請說話`).catch(() => {});
    state.isRecording = true;
    await playWakeupSound(state.connection).catch(() => {});

    // ✅ 修復 2：使用帶快取的 RMS 計算
    await new Promise((resolve) => {
      let silenceAccumMs = 0;
      let totalElapsedMs = 0;

      state.recordTimer = setTimeout(() => {
        if (silenceChecker) clearInterval(silenceChecker);
        state.isRecording = false;
        state.recordTimer = null;
        console.log(`[STT][manual] ⏱️ 錄音上限到 (${RECORD_MAX_MS}ms)`);
        resolve();
      }, RECORD_MAX_MS);

      silenceChecker = setInterval(() => {
        totalElapsedMs += SILENCE_CHECK_MS;
        if (totalElapsedMs <= START_DELAY_MS) return;

        // ✅ 修復 2：使用快取版 RMS
        const rms = getCachedRecentRMS(userState);

        if (rms < RMS_THRESHOLD) {
          silenceAccumMs += SILENCE_CHECK_MS;
        } else {
          silenceAccumMs = 0;
        }

        if (silenceAccumMs >= RECORD_SILENCE_MS && totalElapsedMs >= MIN_AUDIO_DURATION_MS) {
          if (state.recordTimer) clearTimeout(state.recordTimer);
          if (silenceChecker)    clearInterval(silenceChecker);
          state.isRecording = false;
          state.recordTimer = null;
          console.log(`[STT][manual] 🔇 靜音截止 (${totalElapsedMs}ms)`);
          resolve();
        }
      }, SILENCE_CHECK_MS);
    });

    const recordedChunks = userState.recordChunks.splice(0);
    userState.recordBytes          = 0;
    userState._lastSilenceChunksLen = -1;
    userState._lastSilenceRMS       = 0;

    for (const us of state.users.values()) {
      us.recordChunks          = [];
      us.recordBytes           = 0;
      us._lastSilenceChunksLen = -1;
      us._lastSilenceRMS       = 0;
    }

    if (recordedChunks.length === 0) {
      await targetTextChannel?.send('❌ 沒有偵測到語音，請再試一次').catch(() => {});
      return { ok: false, reason: 'no_audio' };
    }

    const pcmBuffer  = Buffer.concat(recordedChunks);
    const durationMs = calcDurationMs(pcmBuffer);
    if (durationMs < MIN_AUDIO_DURATION_MS) {
      await targetTextChannel?.send('❌ 音訊太短，請再試一次').catch(() => {});
      return { ok: false, reason: 'too_short' };
    }

    const voiceRatio = calcVoiceRatio(pcmBuffer);
    if (voiceRatio < VAD_VOICE_RATIO_MIN && calcRMS(pcmBuffer) < RMS_THRESHOLD) {
      await targetTextChannel?.send('❌ 沒有偵測到有效語音，請再試一次').catch(() => {});
      return { ok: false, reason: 'low_voice' };
    }

    ensureTempDir();
    const wavFile = path.join(TEMP_DIR, `manual_${guildId}_${userId}_${Date.now()}.wav`);
    await writeWav(wavFile, pcmBuffer);

    let text = '';
    try {
      text = await transcribeWithGroq(wavFile);  // ✅ 修復 4：stream 已在內部 destroy
    } catch (err) {
      console.error(`[STT][manual] Groq 失敗: ${err.message}`);
      await targetTextChannel?.send('❌ 語音辨識失敗，請稍後再試').catch(() => {});
      return { ok: false, reason: 'stt_failed' };
    } finally {
      safeUnlink(wavFile);
    }

    if (!text || isHallucination(text)) {
      await targetTextChannel?.send('❌ 無法辨識語音內容').catch(() => {});
      return { ok: false, reason: 'empty_or_hallucination' };
    }

    const finalName = state.guild.members.cache.get(userId)?.displayName || userMember.displayName || '使用者';
    await targetTextChannel?.send(`🗣️ "**${finalName}**"：${text}`).catch(() => {});

    userState.cooldownUntil = Date.now() + WAKEUP_COOLDOWN_MS;

    const cb = onWakeupOverride || state.onWakeup;
    if (typeof cb === 'function') {
      await cb(userId, userMember, text, targetTextChannel);
    }

    return { ok: true, text };
  } catch (err) {
    // ✅ 修復 1：若錄音流程尚未開始（進入 exclusive 之前拋出），且是此次新訂閱，
    // 立即清理 stream 以避免訂閱殘留到下一個事件
    if (!recordingStarted && wasNewlySubscribed) {
      unsubscribeUser(guildId, userId);
    }
    throw err;
  } finally {
    if (silenceChecker) clearInterval(silenceChecker);
    exitExclusiveMode(guildId);
  }
}

// ══════════════════════════════════════════════════════════
// 公開 API
// ══════════════════════════════════════════════════════════

// ✅ 修復 5：startSTTListening 在 guild 已存在時更新 state 而非直接返回
// 原先的 early return 會讓舊 connection 引用永久殘留（例如 Bot 重新加入頻道後）
function startSTTListening(connection, guild, textChannel, onWakeup) {
  const guildId = guild.id;

  if (guildStates.has(guildId)) {
    const existing = guildStates.get(guildId);
    if (existing.active) {
      // 若為同一 connection，只更新 channel 引用即可
      if (existing.connection === connection) {
        existing.textChannel = textChannel || existing.textChannel;
        if (onWakeup) existing.onWakeup = onWakeup;
        console.log(`[STT] ${guildId} 已在監聽中（已更新 textChannel）`);
        return;
      }
      // ✅ connection 已更換（Bot 重連 / 切換頻道），先完整停止再重建
      console.log(`[STT] ${guildId} 偵測到新 connection，先停止舊監聽再重新建立`);
      stopSTTListening(guildId);
    } else {
      // state 存在但 active=false（已停止但未被清除），直接刪除重建
      guildStates.delete(guildId);
    }
  }

  const state = {
    active:           true,
    connection,
    guild,
    textChannel,
    onWakeup,
    users:            new Map(),
    isExclusive:      false,
    exclusiveUserId:  null,
    isRecording:      false,
    recordTimer:      null,
    _onSpeakingStart: null,
    _onSpeakingEnd:   null,
    _memTimer:        null,
  };
  guildStates.set(guildId, state);

  const voiceChannel = guild.channels.cache.get(connection.joinConfig.channelId);
  if (voiceChannel) {
    for (const [memberId, member] of voiceChannel.members) {
      if (!member.user.bot) subscribeUser(guildId, memberId, member);
    }
  }

  const onSpeakingStart = (userId) => {
    if (!state.active) return;

    const member = guild.members.cache.get(userId);
    if (member && !member.user.bot) subscribeUser(guildId, userId, member);

    if (state.isExclusive) return;

    const userState = state.users.get(userId);
    if (!userState || userState.isDetecting) return;

    userState.isDetecting  = true;
    userState.detectChunks = [];
    userState.detectBytes  = 0;

    userState.detectTimer = setTimeout(() => {
      triggerDetection(guildId, userId);
    }, DETECT_WINDOW_MS);
  };

  const onSpeakingEnd = (userId) => {
    if (!state.active) return;

    const userState = state.users.get(userId);
    if (!userState || !userState.isDetecting) return;

    if (userState.detectTimer) {
      clearTimeout(userState.detectTimer);
      userState.detectTimer = null;
    }
    triggerDetection(guildId, userId);
  };

  connection.receiver.speaking.on('start', onSpeakingStart);
  connection.receiver.speaking.on('end',   onSpeakingEnd);

  state._onSpeakingStart = onSpeakingStart;
  state._onSpeakingEnd   = onSpeakingEnd;

  if (process.env.STT_DEBUG_MEM === '1') {
    state._memTimer = setInterval(() => {
      const m = process.memoryUsage();
      console.log(`[MEM][${guildId}] rss=${(m.rss/1024/1024).toFixed(1)}MB heap=${(m.heapUsed/1024/1024).toFixed(1)}MB ext=${(m.external/1024/1024).toFixed(1)}MB users=${state.users.size}`);
    }, 30000);
  }

  console.log(`[STT] 開始監聽：${guild.name}`);
}

function stopSTTListening(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;

  state.active = false;

  if (state._onSpeakingStart) {
    state.connection.receiver.speaking.removeListener('start', state._onSpeakingStart);
    state._onSpeakingStart = null;
  }
  if (state._onSpeakingEnd) {
    state.connection.receiver.speaking.removeListener('end', state._onSpeakingEnd);
    state._onSpeakingEnd = null;
  }

  if (state.recordTimer) {
    clearTimeout(state.recordTimer);
    state.recordTimer = null;
  }

  if (state._memTimer) {
    clearInterval(state._memTimer);
    state._memTimer = null;
  }

  for (const userId of state.users.keys()) {
    unsubscribeUser(guildId, userId);
  }

  guildStates.delete(guildId);
  console.log(`[STT] 停止監聽：${guildId}`);
}

module.exports = {
  startSTTListening,
  stopSTTListening,
  ensureManualSession,
  manualRecordOnce,
  unsubscribeUser,
};