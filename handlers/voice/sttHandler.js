// handlers/voice/sttHandler.js — Multi-User Architecture
const { EndBehaviorType, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const prism = require('prism-media');
const fs    = require('fs');
const path  = require('path');
const WebSocket = require('ws');
const Groq  = require('groq-sdk');

// ── 設定（純環境變數）────────────────────────────────────
const OWW_WS_URL         = process.env.OWW_WS_URL;
const OWW_HTTP_URL       = process.env.OWW_HTTP_URL;
const WAKEUP_VOICE_PATH  = path.join(__dirname, 'sttwakeupvoice.wav');
const TEMP_DIR           = path.join(__dirname, '../../temp');
const RECORD_DURATION_MS = parseInt(process.env.STT_RECORD_MS);
const WAKEUP_COOLDOWN_MS = parseInt(process.env.STT_COOLDOWN_MS);
const RMS_THRESHOLD      = parseFloat(process.env.STT_RMS_THRESHOLD);

// ── [新增] VAD / 長度 設定 ───────────────────────────────
const VAD_FRAME_SIZE_MS    = 20;                                        // 每幀 20ms
const VAD_SAMPLE_RATE      = 16000;                                     // 16kHz
const VAD_FRAME_SAMPLES    = (VAD_SAMPLE_RATE * VAD_FRAME_SIZE_MS) / 1000; // 320 samples
const VAD_FRAME_BYTES      = VAD_FRAME_SAMPLES * 2;                    // 640 bytes (Int16)
const VAD_AMP_THRESHOLD    = parseFloat(process.env.STT_VAD_THRESHOLD)  || 600;  // 幀平均振幅閾值
const VAD_VOICE_RATIO_MIN  = parseFloat(process.env.STT_VAD_RATIO_MIN)  || 0.15; // 最低有聲幀比例
const MIN_AUDIO_DURATION_MS = parseInt(process.env.STT_MIN_DURATION_MS) || 800;  // 最短音訊長度

// ── [新增] no_speech_prob 閾值 ───────────────────────────
const NO_SPEECH_THRESHOLD  = parseFloat(process.env.STT_NO_SPEECH_PROB) || 0.6;

// ── Groq 客戶端 ─────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Guild 狀態 Map ───────────────────────────────────────
const guildStates = new Map();

// ── 工具 ────────────────────────────────────────────────
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

// ────────────────────────────────────────────────────────
// [保留] calcRMS — 仍作為第一道快速過濾
// ────────────────────────────────────────────────────────
function calcRMS(pcmBuffer) {
  const samples = pcmBuffer.length / 2;
  let sumSq = 0;
  for (let i = 0; i < pcmBuffer.length; i += 2) {
    const sample = pcmBuffer.readInt16LE(i);
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / samples);
}

// ────────────────────────────────────────────────────────
// [新增 1] VAD — 計算有聲幀比例
//   原理：將 PCM 切成 20ms 幀，計算每幀平均振幅，
//         超過 VAD_AMP_THRESHOLD 視為「有聲幀」，
//         最後回傳有聲幀佔總幀數的比例（0.0 ~ 1.0）
// ────────────────────────────────────────────────────────
function calcVoiceRatio(pcmBuffer) {
  const totalFrames = Math.floor(pcmBuffer.length / VAD_FRAME_BYTES);
  if (totalFrames === 0) return 0;

  let voiceFrames = 0;

  for (let i = 0; i < totalFrames; i++) {
    const start = i * VAD_FRAME_BYTES;
    const end   = start + VAD_FRAME_BYTES;
    const frame = pcmBuffer.slice(start, end);

    let ampSum = 0;
    for (let j = 0; j < frame.length; j += 2) {
      ampSum += Math.abs(frame.readInt16LE(j));
    }
    const avgAmp = ampSum / (frame.length / 2);

    if (avgAmp > VAD_AMP_THRESHOLD) voiceFrames++;
  }

  const ratio = voiceFrames / totalFrames;
  return ratio;
}

// ────────────────────────────────────────────────────────
// [新增 2] 音訊長度（ms）計算
// ────────────────────────────────────────────────────────
function calcDurationMs(pcmBuffer) {
  // PCM 16-bit mono 16kHz：每秒 = 16000 samples * 2 bytes = 32000 bytes
  return (pcmBuffer.length / 2 / VAD_SAMPLE_RATE) * 1000;
}

const HALLUCINATION_PATTERNS = [
  '请不吝点赞', '订阅', '明镜与点点', 'Amara.org',
  '字幕由', '感謝收看', '請訂閱', '敬请订阅',
];

function isHallucination(text) {
  return HALLUCINATION_PATTERNS.some((p) => text.includes(p));
}

// ══════════════════════════════════════════════════════════
// Per-User OWW WebSocket 管理
// ══════════════════════════════════════════════════════════

function createUserOWWConnection(guildId, userId) {
  const state = guildStates.get(guildId);
  if (!state) return;

  const userState = state.users.get(userId);
  if (!userState) return;

  const wsUrl = `${OWW_WS_URL}/?session_id=${guildId}_${userId}`;
  const ws = new WebSocket(wsUrl);
  userState.owwWs = ws;
  userState.owwReady = false;

  ws.on('open', () => {
    console.log(`[STT] 🔗 OWW WS 已連線 User: ${userId} (Guild: ${guildId})`);
    ws.send(JSON.stringify({ session_id: `${guildId}_${userId}` }));
    ws.send('reset');
    userState.owwReady = true;
  });

  ws.on('message', (data) => {
    if (!state.active) return;

    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { return; }

    if (msg.event === 'reset_ok') {
      console.log(`[STT] ✅ OWW reset 確認 User: ${userId}`);
      return;
    }

    if (msg.event === 'resumed') {
      console.log(`[STT] ▶️ OWW resume 確認 User: ${userId}`);
      return;
    }

    if (msg.event === 'inference' && msg.detected) {
      const now = Date.now();

      if (state.isExclusive) return;
      if (now < userState.cooldownUntil) return;

      console.log(`[STT] ✅ 喚醒詞觸發 User: ${userId}, prob: ${msg.prob_score}`);

      handleWakeup(guildId, userId, userState.member).catch((err) => {
        console.error('[STT] handleWakeup 錯誤:', err.message);
      });
    }
  });

  ws.on('close', () => {
    console.warn(`[STT] ⚠️ OWW WS 斷線 User: ${userId}`);
    userState.owwReady = false;

    if (state.active && state.users.has(userId)) {
      setTimeout(() => {
        if (state.active && state.users.has(userId)) {
          console.log(`[STT] 🔄 重連 OWW WS User: ${userId}`);
          createUserOWWConnection(guildId, userId);
        }
      }, 2000);
    }
  });

  ws.on('error', (err) => {
    console.error(`[STT] OWW WS 錯誤 User: ${userId}:`, err.message);
  });
}

function pauseAllOWW(guildId, exceptUserId = null) {
  const state = guildStates.get(guildId);
  if (!state) return;

  for (const [uid, userState] of state.users.entries()) {
    if (uid === exceptUserId) continue;
    if (userState.owwWs && userState.owwWs.readyState === WebSocket.OPEN) {
      userState.owwWs.send(JSON.stringify({ command: 'pause' }));
    }
    userState.owwPaused = true;
  }
}

function resumeAllOWW(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;

  for (const [uid, userState] of state.users.entries()) {
    if (userState.owwWs && userState.owwWs.readyState === WebSocket.OPEN) {
      userState.owwWs.send(JSON.stringify({ command: 'resume' }));
    }
    userState.owwPaused = false;
    userState.pendingChunks = [];
  }
}

function sendPCMToUserOWW(userState, chunk) {
  if (userState.owwPaused) return;
  if (!userState.owwReady || !userState.owwWs || userState.owwWs.readyState !== WebSocket.OPEN) {
    userState.pendingChunks.push(chunk);
    const maxPending = Math.ceil(16000 * 2 / chunk.length);
    while (userState.pendingChunks.length > maxPending) userState.pendingChunks.shift();
    return;
  }

  if (userState.pendingChunks.length > 0) {
    const merged = Buffer.concat(userState.pendingChunks);
    userState.pendingChunks = [];
    userState.owwWs.send(merged);
  }

  userState.owwWs.send(chunk);
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
    owwWs:         null,
    owwReady:      false,
    owwPaused:     false,
    pendingChunks: [],
    recordChunks:  [],
    stream:        null,
    cooldownUntil: 0,
  };
  state.users.set(userId, userState);

  createUserOWWConnection(guildId, userId);

  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual },
  });

  const pcmStream = opusStream.pipe(
    new prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 960 })
  );
  userState.stream = pcmStream;

  pcmStream.on('data', (chunk) => {
    if (!state.active) return;

    if (state.isExclusive) {
      if (userId === state.exclusiveUserId && state.isRecording) {
        userState.recordChunks.push(chunk);
      }
      return;
    }

    sendPCMToUserOWW(userState, chunk);
  });

  pcmStream.on('error', (err) => {
    console.error(`[STT] PCM stream 錯誤 [${userId}]:`, err.message);
  });

  console.log(`[STT] 🎧 開始監聽使用者：${member?.displayName || userId}`);
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

// ────────────────────────────────────────────────────────
// [新增 3] Groq 轉文字 — verbose_json + no_speech_prob
// ────────────────────────────────────────────────────────
async function transcribeWithGroq(wavFilePath) {
  const transcription = await groq.audio.transcriptions.create({
    file:            fs.createReadStream(wavFilePath),
    model:           'whisper-large-v3',
    language:        'zh',
    response_format: 'verbose_json',   // ← 取得 segments 資訊
    prompt:          '以下是使用者對語音助理說的指令。',
  });

  // ── no_speech_prob 過濾 ──────────────────────────────
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
  state.isExclusive = true;
  state.exclusiveUserId = userId;
  state.isRecording = false;

  console.log(`[STT] 🔒 進入獨佔模式 User: ${member?.displayName || userId}`);

  pauseAllOWW(guildId);
  for (const us of state.users.values()) us.recordChunks = [];

  // ── 2. 播放喚醒音效 + 提示 ──
  const wakeupName = member?.displayName || '使用者';
  textChannel.send(`🎙️ "**${wakeupName}**" 說吧，我在聽`).catch(() => {});
  await playWakeupSound(connection).catch(() => {});

  // ── 3. 獨佔錄音 ──
  state.isRecording = true;

  await new Promise((resolve) => {
    state.recordTimer = setTimeout(() => {
      state.isRecording = false;
      state.recordTimer = null;
      resolve();
    }, RECORD_DURATION_MS);
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

  // ── [新增 2] 音訊長度下限檢查 ──────────────────────────
  const durationMs = calcDurationMs(pcmBuffer);
  console.log(`[STT] ⏱️ 音訊長度：${durationMs.toFixed(0)}ms（下限：${MIN_AUDIO_DURATION_MS}ms）`);

  if (durationMs < MIN_AUDIO_DURATION_MS) {
    console.warn(`[STT] ⚠️ 音訊過短（${durationMs.toFixed(0)}ms），跳過`);
    await textChannel.send('❌ 沒有偵測到語音，請再試一次').catch(() => {});
    exitExclusiveMode(guildId);
    return;
  }

  // ── [新增 1] VAD 有聲幀比例檢查（取代純 RMS）──────────
  const voiceRatio = calcVoiceRatio(pcmBuffer);
  console.log(`[STT] 🎙️ VAD 有聲幀比例：${(voiceRatio * 100).toFixed(1)}%（下限：${(VAD_VOICE_RATIO_MIN * 100).toFixed(0)}%）`);

  if (voiceRatio < VAD_VOICE_RATIO_MIN) {
    // 有聲幀不足，但仍做 RMS 二次確認（避免誤殺短促語音）
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
    text = await transcribeWithGroq(wavFile);  // 內含 no_speech_prob 過濾
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

  // ── 6. 退出獨佔模式（在 callback 之前）──
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

  resumeAllOWW(guildId);
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

  // 訂閱目前在頻道內的所有使用者
  const voiceChannel = guild.channels.cache.get(connection.joinConfig.channelId);
  if (voiceChannel) {
    for (const [memberId, member] of voiceChannel.members) {
      if (!member.user.bot) {
        subscribeUser(guildId, memberId, member);
      }
    }
  }

  // 監聽新加入的使用者
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
    if (userState.owwWs) {
      try { userState.owwWs.close(); } catch {}
    }
    if (userState.stream) {
      try { userState.stream.destroy(); } catch {}
    }
  }

  guildStates.delete(guildId);
  console.log(`[STT] ⏹️ 停止監聽 Guild: ${guildId}`);
}

module.exports = { startSTTListening, stopSTTListening };