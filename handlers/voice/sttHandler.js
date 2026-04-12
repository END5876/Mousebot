// handlers/voice/sttHandler.js — Speaking-Triggered Architecture
const { EndBehaviorType, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const prism = require('prism-media');
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const Groq  = require('groq-sdk');

// ── 設定（純環境變數）────────────────────────────────────
const OWW_HTTP_URL        = process.env.OWW_HTTP_URL;
const WAKEUP_VOICE_PATH   = path.join(__dirname, 'sttwakeupvoice.wav');
const TEMP_DIR            = path.join(__dirname, '../../temp');
const RECORD_MAX_MS       = parseInt(process.env.STT_RECORD_MS);         // 最長錄音上限
const RECORD_SILENCE_MS   = parseInt(process.env.STT_SILENCE_MS) || 1000; // 靜音多久後自動截止
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
const SILENCE_CHECK_MS  = 100;   // 每 100ms 檢查一次靜音

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
    console.error(`[STT] OWW HTTP 偵測失敗 (${userId}):`, err.message);
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
    console.error(`[STT] PCM stream 錯誤 [${userId}]:`, err.message);
  });

  console.log(`[STT] 🎧 開始監聽使用者：${member?.displayName || userId}`);
}

// ══════════════════════════════════════════════════════════
// 觸發偵測（說話結束 or 2 秒到期）
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

  const rms = calcRMS(pcmBuffer);
  if (rms < RMS_THRESHOLD) return;

  console.log(`[STT] 🔍 送出偵測 User: ${userState.member?.displayName || userId} (${calcDurationMs(pcmBuffer).toFixed(0)}ms, RMS: ${rms.toFixed(0)})`);

  const result = await detectWakeword(guildId, userId, pcmBuffer);

  if (!result.detected) {
    if (result.prob_score !== undefined) {
      console.log(`[STT] ❌ 未偵測到喚醒詞 prob=${result.prob_score?.toFixed(4)} User: ${userId}`);
    }
    return;
  }

  console.log(`[STT] ✅ 喚醒詞觸發 User: ${userId}, prob: ${result.prob_score}`);

  handleWakeup(guildId, userId, userState.member).catch((err) => {
    console.error('[STT] handleWakeup 錯誤:', err.message);
  });
}

// ── 播放喚醒音效 ─────────────────────────────────────────
function playWakeupSound(connection) {
  return new Promise((resolve) => {
    if (!fs.existsSync(WAKEUP_VOICE_PATH)) {
      console.warn('[STT] ⚠️ 找不到喚醒音效');
      return resolve();
    }
    try {
      const player   = createAudioPlayer();
      const resource = createAudioResource(WAKEUP_VOICE_PATH);
      player.play(resource);
      connection.subscribe(player);
      player.on(AudioPlayerStatus.Idle, resolve);
      player.on('error', (err) => {
        console.error('[STT] 喚醒音效錯誤:', err.message);
        resolve();
      });
      setTimeout(resolve, 3000);
    } catch (err) {
      console.error('[STT] 播放失敗:', err.message);
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

  if (transcription.segments && transcription.segments.length > 0) {
    const avgNoSpeech = transcription.segments.reduce(
      (sum, seg) => sum + (seg.no_speech_prob ?? 0), 0
    ) / transcription.segments.length;

    console.log(`[STT] 🔇 no_speech_prob avg: ${avgNoSpeech.toFixed(3)} (閾值: ${NO_SPEECH_THRESHOLD})`);

    if (avgNoSpeech > NO_SPEECH_THRESHOLD) {
      console.warn(`[STT] 🚫 幻覺風險高（no_speech_prob=${avgNoSpeech.toFixed(3)}），丟棄結果`);
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
  if (!state) return;
  if (state.isExclusive) return;

  const { connection, textChannel, onWakeup } = state;
  const userState = state.users.get(userId);
  if (!userState) return;

  // ── 1. 進入獨佔模式 ──
  state.isExclusive     = true;
  state.exclusiveUserId = userId;
  state.isRecording     = false;

  console.log(`[STT] 🔒 進入獨佔模式 User: ${member?.displayName || userId}`);
  for (const us of state.users.values()) us.recordChunks = [];

  // ── 2. 提示文字 + 立刻開始錄音 + 播音效 ──
  const wakeupName = member?.displayName || '使用者';
  textChannel.send(`🎙️ "**${wakeupName}**" 說吧，我在聽`).catch(() => {});

  state.isRecording = true;   // 音效播出同時開始收音

  await playWakeupSound(connection).catch(() => {});

  // ── 3. 錄音：靜音自動截止 + 最長上限 ──────────────────
  //
  //   每 SILENCE_CHECK_MS(100ms) 檢查最近收到的 chunk RMS
  //   若連續靜音超過 RECORD_SILENCE_MS → 提前截止
  //   若超過 RECORD_MAX_MS → 強制截止
  //
  await new Promise((resolve) => {
    let silenceAccumMs = 0;
    let totalElapsedMs = 0;

    // 最長上限保底計時器
    state.recordTimer = setTimeout(() => {
      clearInterval(silenceChecker);
      state.isRecording = false;
      state.recordTimer = null;
      console.log(`[STT] ⏱️ 達到最長錄音上限 (${RECORD_MAX_MS}ms)，截止`);
      resolve();
    }, RECORD_MAX_MS);

    // 每 100ms 檢查靜音
    const silenceChecker = setInterval(() => {
      totalElapsedMs += SILENCE_CHECK_MS;

      // 取最近約 100ms 的 chunks（960 samples/chunk @16kHz ≈ 60ms，取最後 2 個約 120ms）
      const recentChunks = userState.recordChunks.slice(-2);

      if (recentChunks.length === 0) {
        // 完全沒有任何資料，視為靜音
        silenceAccumMs += SILENCE_CHECK_MS;
      } else {
        const recentBuf = Buffer.concat(recentChunks);
        const rms = calcRMS(recentBuf);

        if (rms < RMS_THRESHOLD) {
          silenceAccumMs += SILENCE_CHECK_MS;
        } else {
          silenceAccumMs = 0;   // 有聲音，重置靜音計數
        }
      }

      // 靜音超過閾值 且 已錄超過最短長度 → 提前截止
      if (silenceAccumMs >= RECORD_SILENCE_MS && totalElapsedMs >= MIN_AUDIO_DURATION_MS) {
        clearTimeout(state.recordTimer);
        clearInterval(silenceChecker);
        state.isRecording = false;
        state.recordTimer = null;
        console.log(`[STT] 🔇 靜音 ${silenceAccumMs}ms，提前截止（共錄 ${totalElapsedMs}ms）`);
        resolve();
      }
    }, SILENCE_CHECK_MS);
  });

  // ── 4. 取出錄音資料 ──
  const recordedChunks = userState.recordChunks.splice(0);
  for (const us of state.users.values()) us.recordChunks = [];

  if (recordedChunks.length === 0) {
    console.warn('[STT] ⚠️ 錄製到空音訊');
    await textChannel.send('❌ 沒有偵測到語音，請再試一次').catch(() => {});
    exitExclusiveMode(guildId);
    return;
  }

  const pcmBuffer = Buffer.concat(recordedChunks);

  // ── 音訊長度下限檢查 ──
  const durationMs = calcDurationMs(pcmBuffer);
  console.log(`[STT] ⏱️ 音訊長度：${durationMs.toFixed(0)}ms（下限：${MIN_AUDIO_DURATION_MS}ms）`);

  if (durationMs < MIN_AUDIO_DURATION_MS) {
    console.warn(`[STT] ⚠️ 音訊過短（${durationMs.toFixed(0)}ms），跳過`);
    await textChannel.send('❌ 沒有偵測到語音，請再試一次').catch(() => {});
    exitExclusiveMode(guildId);
    return;
  }

  // ── VAD 有聲幀比例檢查 ──
  const voiceRatio = calcVoiceRatio(pcmBuffer);
  console.log(`[STT] 🎙️ VAD 有聲幀比例：${(voiceRatio * 100).toFixed(1)}%（下限：${(VAD_VOICE_RATIO_MIN * 100).toFixed(0)}%）`);

  if (voiceRatio < VAD_VOICE_RATIO_MIN) {
    const rms = calcRMS(pcmBuffer);
    console.log(`[STT] 🔊 VAD 不足，RMS 二次確認：${rms.toFixed(1)}（閾值：${RMS_THRESHOLD}）`);
    if (rms < RMS_THRESHOLD) {
      console.warn('[STT] ⚠️ VAD + RMS 均不足，視為靜音');
      await textChannel.send('❌ 沒有偵測到語音，請再試一次').catch(() => {});
      exitExclusiveMode(guildId);
      return;
    }
    console.log('[STT] ℹ️ RMS 通過，繼續處理（短促語音）');
  }

  // ── 5. 寫入 WAV 並送 Groq ──
  ensureTempDir();
  const wavFile = path.join(TEMP_DIR, `stt_${guildId}_${userId}_${Date.now()}.wav`);
  writeWav(wavFile, pcmBuffer);

  let text = '';
  try {
    text = await transcribeWithGroq(wavFile);
    console.log(`[STT] 📝 辨識結果：「${text}」 (User: ${userId})`);
  } catch (err) {
    console.error('[STT] Groq 轉文字失敗:', err.message);
    await textChannel.send('❌ 語音辨識失敗，請再試一次').catch(() => {});
    exitExclusiveMode(guildId);
    return;
  } finally {
    safeUnlink(wavFile);
  }

  if (!text || isHallucination(text)) {
    console.warn(`[STT] 🚫 幻覺輸出已過濾：「${text}」`);
    await textChannel.send('❌ 無法辨識語音內容').catch(() => {});
    exitExclusiveMode(guildId);
    return;
  }

  const speakerMember = state.guild.members.cache.get(userId);
  const finalName = speakerMember?.displayName || '使用者';
  await textChannel.send(`🗣️ "**${finalName}**" ：${text}`).catch(() => {});

  // ── 6. 退出獨佔模式 ──
  exitExclusiveMode(guildId);

  // ── 7. 設定冷卻 ──
  if (userState) {
    userState.cooldownUntil = Date.now() + WAKEUP_COOLDOWN_MS;
  }

  // ── 8. 觸發 callback ──
  if (typeof onWakeup === 'function') {
    try {
      await onWakeup(userId, member, text, textChannel);
    } catch (err) {
      console.error('[STT] onWakeup callback 錯誤:', err.message);
    }
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

  console.log(`[STT] 🔓 已退出獨佔模式 (Guild: ${guildId})`);
}

// ══════════════════════════════════════════════════════════
// 公開 API
// ══════════════════════════════════════════════════════════
function startSTTListening(connection, guild, textChannel, onWakeup) {
  const guildId = guild.id;

  if (guildStates.has(guildId)) {
    console.warn(`[STT] Guild ${guildId} 已在監聽中`);
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
      if (!member.user.bot) {
        subscribeUser(guildId, memberId, member);
      }
    }
  }

  connection.receiver.speaking.on('start', (userId) => {
    if (!state.active) return;
    const member = guild.members.cache.get(userId);
    if (member && !member.user.bot) {
      subscribeUser(guildId, userId, member);
    }
  });

  console.log(`[STT] ▶️ 開始監聽 Guild: ${guild.name}`);
}

function stopSTTListening(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;

  state.active = false;

  if (state.recordTimer) {
    clearTimeout(state.recordTimer);
    state.recordTimer = null;
  }

  for (const [userId, userState] of state.users.entries()) {
    if (userState.detectTimer) {
      clearTimeout(userState.detectTimer);
    }
    if (userState.stream) {
      try { userState.stream.destroy(); } catch {}
    }
  }

  guildStates.delete(guildId);
  console.log(`[STT] ⏹️ 停止監聽 Guild: ${guildId}`);
}

module.exports = { startSTTListening, stopSTTListening };