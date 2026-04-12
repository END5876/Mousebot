// handlers/voice/sttHandler.js — Speaking-Triggered Architecture
const { EndBehaviorType, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const prism = require('prism-media');
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const Groq  = require('groq-sdk');
const { getGeminiResponseVoice } = require('../../handlers/ai/aiHandler');

// ── 設定（純環境變數）────────────────────────────────────
const OWW_HTTP_URL        = process.env.OWW_HTTP_URL;
const WAKEUP_VOICE_PATH   = path.join(__dirname, 'sttwakeupvoice.wav');
const TEMP_DIR            = path.join(__dirname, '../../temp');
const RECORD_MAX_MS       = parseInt(process.env.STT_RECORD_MS);
const RECORD_SILENCE_MS   = parseInt(process.env.STT_SILENCE_MS) || 1000;
const WAKEUP_COOLDOWN_MS  = parseInt(process.env.STT_COOLDOWN_MS);
const RMS_THRESHOLD       = parseFloat(process.env.STT_RMS_THRESHOLD);

// ── 喚醒偵測緩衝設定 ────────────────────────────────────
const DETECT_WINDOW_MS  = parseInt(process.env.STT_DETECT_WINDOW_MS) || 2000;
const SAMPLE_RATE       = 16000;
const DETECT_MAX_BYTES  = SAMPLE_RATE * (DETECT_WINDOW_MS / 1000) * 2;

// ── VAD / 長度 設定 ─────────────────────────────────────
const VAD_FRAME_SIZE_MS     = 20;
const VAD_FRAME_SAMPLES     = (SAMPLE_RATE * VAD_FRAME_SIZE_MS) / 1000;
const VAD_FRAME_BYTES       = VAD_FRAME_SAMPLES * 2;
const VAD_AMP_THRESHOLD     = parseFloat(process.env.STT_VAD_THRESHOLD)  || 600;
const VAD_VOICE_RATIO_MIN   = parseFloat(process.env.STT_VAD_RATIO_MIN)  || 0.15;
const MIN_AUDIO_DURATION_MS = parseInt(process.env.STT_MIN_DURATION_MS)  || 800;

// ── 靜音偵測設定 ────────────────────────────────────────
const SILENCE_CHECK_MS  = 100;

// ── no_speech_prob 閾值 ──────────────────────────────────
const NO_SPEECH_THRESHOLD = parseFloat(process.env.STT_NO_SPEECH_PROB) || 0.6;

// ── Groq 客戶端 ─────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Guild 狀態 Map ───────────────────────────────────────
const guildStates = new Map();

// ══════════════════════════════════════════════════════════
// 工具函式
// ══════════════════════════════════════════════════════════
function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function safeUnlink(f) { try { fs.unlinkSync(f); } catch {} }

function writeWav(filename, pcmBuffer) {
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

  fs.writeFileSync(filename, Buffer.concat([header, pcmBuffer]));
}

function calcRMS(pcmBuffer) {
  const samples = pcmBuffer.length / 2;
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
  return HALLUCINATION_PATTERNS.some((p) => text.includes(p));
}

// ══════════════════════════════════════════════════════════
// HTTP 單次偵測
// ══════════════════════════════════════════════════════════
async function detectWakeword(guildId, userId, pcmBuffer) {
  try {
    const sessionId = `${guildId}_${userId}`;
    const response  = await axios.post(
      `${OWW_HTTP_URL}/detect?session_id=${sessionId}`,
      pcmBuffer,
      {
        headers: { 'Content-Type': 'application/octet-stream' },
        timeout: 3000,
      }
    );
    return response.data;
  } catch (err) {
    console.error(`[STT] OWW 偵測失敗 (${userId}): ${err.message}`);
    return { detected: false };
  }
}

// ══════════════════════════════════════════════════════════
// 訂閱使用者音訊
// ══════════════════════════════════════════════════════════
function subscribeUser(guildId, userId, member) {
  const state = guildStates.get(guildId);
  if (!state || state.users.has(userId)) return;

  const { connection } = state;

  const userState = {
    member,
    detectChunks:  [],
    detectBytes:   0,
    recordChunks:  [],
    stream:        null,
    cooldownUntil: 0,
    isDetecting:   false,
    detectTimer:   null,
  };
  state.users.set(userId, userState);

  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual },
  });

  const pcmStream = opusStream.pipe(
    new prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 960 })
  );
  userState.stream = pcmStream;

  // ── 說話開始：啟動偵測視窗 ──
  connection.receiver.speaking.on('start', (speakingUserId) => {
    if (speakingUserId !== userId) return;
    if (!state.active) return;
    if (state.isExclusive) return;
    if (userState.isDetecting) return;

    userState.isDetecting  = true;
    userState.detectChunks = [];
    userState.detectBytes  = 0;

    userState.detectTimer = setTimeout(() => {
      triggerDetection(guildId, userId);
    }, DETECT_WINDOW_MS);
  });

  // ── 說話結束：提前送出偵測 ──
  connection.receiver.speaking.on('end', (speakingUserId) => {
    if (speakingUserId !== userId) return;
    if (!state.active) return;
    if (!userState.isDetecting) return;

    if (userState.detectTimer) {
      clearTimeout(userState.detectTimer);
      userState.detectTimer = null;
    }
    triggerDetection(guildId, userId);
  });

  // ── PCM 資料流 ──
  pcmStream.on('data', (chunk) => {
    if (!state.active) return;

    if (state.isExclusive) {
      if (userId === state.exclusiveUserId && state.isRecording) {
        userState.recordChunks.push(chunk);
      }
      return;
    }

    if (userState.isDetecting) {
      userState.detectChunks.push(chunk);
      userState.detectBytes += chunk.length;

      while (userState.detectBytes > DETECT_MAX_BYTES && userState.detectChunks.length > 0) {
        const dropped = userState.detectChunks.shift();
        userState.detectBytes -= dropped.length;
      }
    }
  });

  pcmStream.on('error', (err) => {
    console.error(`[STT] PCM 錯誤 [${userId}]: ${err.message}`);
  });

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

  handleWakeup(guildId, userId, userState.member).catch((err) => {
    console.error(`[STT] handleWakeup 錯誤: ${err.message}`);
  });
}

// ── 播放喚醒音效 ─────────────────────────────────────────
function playWakeupSound(connection) {
  return new Promise((resolve) => {
    if (!fs.existsSync(WAKEUP_VOICE_PATH)) return resolve();
    try {
      const player   = createAudioPlayer();
      const resource = createAudioResource(WAKEUP_VOICE_PATH);
      player.play(resource);
      connection.subscribe(player);
      player.on(AudioPlayerStatus.Idle, resolve);
      player.on('error', () => resolve());
      setTimeout(resolve, 3000);
    } catch {
      resolve();
    }
  });
}

// ── Groq 轉文字 ──────────────────────────────────────────
async function transcribeWithGroq(wavFilePath) {
  const transcription = await groq.audio.transcriptions.create({
    file:            fs.createReadStream(wavFilePath),
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

  // ── 1. 進入獨佔模式 ──
  state.isExclusive     = true;
  state.exclusiveUserId = userId;
  state.isRecording     = false;

  for (const us of state.users.values()) us.recordChunks = [];

  // ── 2. 提示 + 開始錄音 + 播音效 ──
  const wakeupName = member?.displayName || '使用者';
  textChannel.send(`🎙️ "**${wakeupName}**" 說吧，我在聽`).catch(() => {});

  state.isRecording = true;
  await playWakeupSound(connection).catch(() => {});

  // ── 3. 錄音：靜音自動截止 + 最長上限 ──
  await new Promise((resolve) => {
    let silenceAccumMs = 0;
    let totalElapsedMs = 0;
    const START_DELAY_MS = parseInt(process.env.STT_START_DELAY_MS); // 開口緩衝

    state.recordTimer = setTimeout(() => {
      clearInterval(silenceChecker);
      state.isRecording = false;
      state.recordTimer = null;
      console.log(`[STT] ⏱️ 錄音上限到 (${RECORD_MAX_MS}ms)`);
      resolve();
    }, RECORD_MAX_MS);

    const silenceChecker = setInterval(() => {
      totalElapsedMs += SILENCE_CHECK_MS;

      if (totalElapsedMs <= START_DELAY_MS) return;

      const recentBuf = userState.recordChunks.length > 0
        ? Buffer.concat(userState.recordChunks.slice(-2))
        : null;

      if (!recentBuf || calcRMS(recentBuf) < RMS_THRESHOLD) {
        silenceAccumMs += SILENCE_CHECK_MS;
      } else {
        silenceAccumMs = 0;
      }

      if (silenceAccumMs >= RECORD_SILENCE_MS && totalElapsedMs >= MIN_AUDIO_DURATION_MS) {
        clearTimeout(state.recordTimer);
        clearInterval(silenceChecker);
        state.isRecording = false;
        state.recordTimer = null;
        console.log(`[STT] 🔇 靜音截止 (${totalElapsedMs}ms)`);
        resolve();
      }
    }, SILENCE_CHECK_MS);
  });


  // ── 4. 取出錄音資料 ──
  const recordedChunks = userState.recordChunks.splice(0);
  for (const us of state.users.values()) us.recordChunks = [];

  if (recordedChunks.length === 0) {
    await textChannel.send('❌ 沒有偵測到語音，請再試一次').catch(() => {});
    exitExclusiveMode(guildId);
    return;
  }

  const pcmBuffer = Buffer.concat(recordedChunks);
  const durationMs = calcDurationMs(pcmBuffer);

  // ── 長度下限 ──
  if (durationMs < MIN_AUDIO_DURATION_MS) {
    await textChannel.send('❌ 沒有偵測到語音，請再試一次').catch(() => {});
    exitExclusiveMode(guildId);
    return;
  }

  // ── VAD 檢查 ──
  const voiceRatio = calcVoiceRatio(pcmBuffer);
  if (voiceRatio < VAD_VOICE_RATIO_MIN) {
    if (calcRMS(pcmBuffer) < RMS_THRESHOLD) {
      await textChannel.send('❌ 沒有偵測到語音，請再試一次').catch(() => {});
      exitExclusiveMode(guildId);
      return;
    }
  }

  // ── 5. 寫入 WAV 並送 Groq ──
  ensureTempDir();
  const wavFile = path.join(TEMP_DIR, `stt_${guildId}_${userId}_${Date.now()}.wav`);
  writeWav(wavFile, pcmBuffer);

  let text = '';
  try {
    text = await transcribeWithGroq(wavFile);
  } catch (err) {
    console.error(`[STT] Groq 失敗: ${err.message}`);
    await textChannel.send('❌ 語音辨識失敗，請再試一次').catch(() => {});
    exitExclusiveMode(guildId);
    return;
  } finally {
    safeUnlink(wavFile);
  }

  if (!text || isHallucination(text)) {
    await textChannel.send('❌ 無法辨識語音內容').catch(() => {});
    exitExclusiveMode(guildId);
    return;
  }

  const finalName = state.guild.members.cache.get(userId)?.displayName || '使用者';
  console.log(`[STT] 📝 ${finalName}：${text}`);
  await textChannel.send(`🗣️ "**${finalName}**" ：${text}`).catch(() => {});

  // ── 6. 退出獨佔模式 + 冷卻 ──
  exitExclusiveMode(guildId);
  userState.cooldownUntil = Date.now() + WAKEUP_COOLDOWN_MS;

  // ── 7. 🎙️ 呼叫語音專用 AI 回覆 ──
  try {
    const aiReply = await getGeminiResponseVoice(userId, text);
    if (aiReply) {
      // 文字頻道顯示回覆
      await textChannel.send(aiReply).catch(() => {});

      // TTS 朗讀（直接用 guildId 呼叫，不需要 message 物件）
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
// 公開 API
// ══════════════════════════════════════════════════════════
function startSTTListening(connection, guild, textChannel, onWakeup) {
  const guildId = guild.id;

  if (guildStates.has(guildId)) {
    console.warn(`[STT] ${guildId} 已在監聽中`);
    return;
  }

  const state = {
    active:          true,
    connection,
    guild,
    textChannel,
    onWakeup,
    users:           new Map(),
    isExclusive:     false,
    exclusiveUserId: null,
    isRecording:     false,
    recordTimer:     null,
  };
  guildStates.set(guildId, state);

  const voiceChannel = guild.channels.cache.get(connection.joinConfig.channelId);
  if (voiceChannel) {
    for (const [memberId, member] of voiceChannel.members) {
      if (!member.user.bot) subscribeUser(guildId, memberId, member);
    }
  }

  connection.receiver.speaking.on('start', (userId) => {
    if (!state.active) return;
    const member = guild.members.cache.get(userId);
    if (member && !member.user.bot) subscribeUser(guildId, userId, member);
  });

  console.log(`[STT] 開始監聽：${guild.name}`);
}

function stopSTTListening(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;

  state.active = false;

  if (state.recordTimer) {
    clearTimeout(state.recordTimer);
    state.recordTimer = null;
  }

  for (const [, userState] of state.users.entries()) {
    if (userState.detectTimer) clearTimeout(userState.detectTimer);
    if (userState.stream) try { userState.stream.destroy(); } catch {}
  }

  guildStates.delete(guildId);
  console.log(`[STT] 停止監聽：${guildId}`);
}

module.exports = { startSTTListening, stopSTTListening };
