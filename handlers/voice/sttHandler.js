// handlers/voice/sttHandler.js
const { EndBehaviorType, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const prism = require('prism-media');
const fs    = require('fs');
const path  = require('path');
const WebSocket = require('ws');
const Groq  = require('groq-sdk');

// ── 設定 ────────────────────────────────────────────────
const OWW_WS_URL         = process.env.OWW_WS_URL;
const OWW_THRESHOLD      = parseFloat(process.env.OWW_THRESHOLD);

const WAKEUP_VOICE_PATH  = path.join(__dirname, 'sttwakeupvoice.wav');
const TEMP_DIR           = path.join(__dirname, '../../temp');

const RECORD_DURATION_MS = parseInt(process.env.STT_RECORD_MS);
const WAKEUP_COOLDOWN_MS = parseInt(process.env.STT_COOLDOWN_MS);
const RMS_THRESHOLD      = parseFloat(process.env.STT_RMS_THRESHOLD);

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

// ── RMS 計算 ─────────────────────────────────────────────
function calcRMS(pcmBuffer) {
  const samples = pcmBuffer.length / 2;
  let sumSq = 0;
  for (let i = 0; i < pcmBuffer.length; i += 2) {
    const sample = pcmBuffer.readInt16LE(i);
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / samples);
}

// ── 幻覺黑名單 ───────────────────────────────────────────
const HALLUCINATION_PATTERNS = [
  '请不吝点赞', '订阅', '明镜与点点', 'Amara.org',
  '字幕由', '感謝收看', '請訂閱', '敬请订阅',
];

function isHallucination(text) {
  return HALLUCINATION_PATTERNS.some((p) => text.includes(p));
}

// ── OWW 送出工具 ─────────────────────────────────────────
function owwSend(state, data) {
  if (!state.owwWs || state.owwWs.readyState !== WebSocket.OPEN) return;
  state.owwWs.send(data);
}

// ══════════════════════════════════════════════════════════
// WebSocket 連線管理
// ══════════════════════════════════════════════════════════

function createOWWConnection(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;

  const ws = new WebSocket(OWW_WS_URL);
  state.owwWs   = ws;
  state.owwReady = false;

  ws.on('open', () => {
    console.log(`[STT] 🔗 OWW WebSocket 已連線 (Guild: ${guildId})`);
    // 連線後先送 reset，確保模型乾淨
    ws.send('reset');
    state.owwReady = true;
  });

    ws.on('message', (data) => {
    if (!state.active) return;

    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { return; }

    if (msg.event === 'detected') {
      const triggerUserId = msg.userId;

      // 【關鍵邏輯】：如果系統已經在錄音，或已經鎖定某人，則忽略其他人的喚醒
      if (state.isRecording || state.lockedUserId) return;

      console.log(`[STT] ✅ 喚醒詞觸發，使用者：${triggerUserId}，分數：${msg.score}`);

      // 鎖定該使用者
      state.lockedUserId = triggerUserId;
      state.isRecording = true;

      const receiver = state.receivers.get(triggerUserId);
      const triggerMember = receiver ? receiver.member : null;

      handleWakeup(guildId, triggerUserId, triggerMember).catch((err) => {
        console.error('[STT] handleWakeup 錯誤:', err.message);
        // 發生錯誤時提早解鎖
        state.lockedUserId = null;
        state.isRecording = false;
      });
    }
  });


  ws.on('close', () => {
    console.warn(`[STT] ⚠️ OWW WebSocket 斷線 (Guild: ${guildId})`);
    state.owwReady = false;

    if (state.active) {
      setTimeout(() => {
        if (state.active) {
          console.log('[STT] 🔄 嘗試重連 OWW WebSocket...');
          createOWWConnection(guildId);
        }
      }, 2000);
    }
  });

  ws.on('error', (err) => {
    console.error('[STT] OWW WebSocket 錯誤:', err.message);
  });
}

// ══════════════════════════════════════════════════════════
// 即時送出 PCM 到 OWW
// ══════════════════════════════════════════════════════════

function sendPCMToOWW(state, userId, chunk) {
  if (!state.owwReady || !state.owwWs || state.owwWs.readyState !== WebSocket.OPEN) {
    return; // 簡化處理，未連線時直接丟棄，避免記憶體堆積
  }

  const base64Data = chunk.toString('base64');
  state.owwWs.send(JSON.stringify({
    event: 'audio',
    userId: userId,
    data: base64Data
  }));

  if (!state.owwReady || !state.owwWs || state.owwWs.readyState !== WebSocket.OPEN) {
    state.pendingChunks.push(chunk);
    const maxPending = Math.ceil(16000 * 2 / chunk.length);
    while (state.pendingChunks.length > maxPending) state.pendingChunks.shift();
    return;
  }

  if (state.pendingChunks.length > 0) {
    const merged = Buffer.concat(state.pendingChunks);
    state.pendingChunks = [];
    state.owwWs.send(merged);
  }

  state.owwWs.send(chunk);
}

// ══════════════════════════════════════════════════════════
// 訂閱使用者音訊
// ══════════════════════════════════════════════════════════

function subscribeUser(guildId, userId, member) {
  const state = guildStates.get(guildId);
  if (!state || state.receivers.has(userId)) return;

  const { connection } = state;

  const receiverState = {
    recordChunks:   [],
    stream:         null,
    member:         member,
    lastActiveTime: 0,
  };
  state.receivers.set(userId, receiverState);

  const opusStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual },
  });

  const pcmStream = opusStream.pipe(
    new prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 960 })
  );
  receiverState.stream = pcmStream;

    pcmStream.on('data', (chunk) => {
    if (!state.active) return;

    // 【排他鎖】：如果已經鎖定某人，且說話的不是被鎖定的人，直接丟棄音訊 (不錄音也不送喚醒)
    if (state.lockedUserId && state.lockedUserId !== userId) {
      return; 
    }

    const now = Date.now();
    receiverState.lastActiveTime = now;

    if (state.isRecording) {
      // 只有被鎖定的人的聲音會被錄下來
      if (state.lockedUserId === userId) {
        receiverState.recordChunks.push(chunk);
      }
      return;
    }

    if (now < state.cooldownUntil) return;

    // 傳送給 OWW 時帶上 userId
    sendPCMToOWW(state, userId, chunk);
  });


  pcmStream.on('error', (err) => {
    console.error(`[STT] PCM stream 錯誤 [${userId}]:`, err.message);
  });

  console.log(`[STT] 👂 開始監聽使用者：${member?.displayName || userId}`);
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
      player.on(AudioPlayerStatus.Playing, resolve);
      player.on('error', (err) => {
        console.error('[STT] 喚醒音效錯誤:', err.message);
        resolve();
      });
      setTimeout(resolve, 1000);
    } catch (err) {
      console.error('[STT] 播放失敗:', err.message);
      resolve();
    }
  });
}

function releaseSTTLock(guildId) {
  const state = guildStates.get(guildId);
  if (state) {
    state.lockedUserId = null;
    state.isRecording = false;
    state.cooldownUntil = Date.now() + 1000; // 給 1 秒的緩衝冷卻
    console.log(`[STT] 🔓 已解除鎖定，恢復監聽所有人 (Guild: ${guildId})`);
  }
}

module.exports = {
  startSTTListening,
  stopSTTListening,
  releaseSTTLock // 匯出這個新函式
};

// ── Groq 轉文字 ──────────────────────────────────────────
async function transcribeWithGroq(wavFilePath) {
  const transcription = await groq.audio.transcriptions.create({
    file:            fs.createReadStream(wavFilePath),
    model:           'whisper-large-v3',
    language:        'zh',
    response_format: 'json',
    prompt:          '以下是使用者對語音助理說的指令。',
  });
  return transcription.text?.trim() || '';
}

// ── 喚醒後流程 ───────────────────────────────────────────
async function handleWakeup(guildId, userId, member) {
  const state = guildStates.get(guildId);
  if (!state) return;

  const { connection, textChannel, onWakeup } = state;

  for (const rs of state.receivers.values()) rs.recordChunks = [];
  
  // 清空待發送的舊音訊，避免冷卻結束後發送導致重複喚醒
  state.pendingChunks = [];
  
  state.isRecording = true;

  playWakeupSound(connection).catch(() => {});
  const wakeupName = member?.displayName || '使用者';
  textChannel.send(`🎙️ "**${wakeupName}**" 說吧，我在聽`).catch(() => {});

  // 等待錄製結束
  await new Promise((resolve) => {
    state.recordTimer = setTimeout(() => {
      state.isRecording = false;
      state.recordTimer = null;
      resolve();
    }, RECORD_DURATION_MS);
  });

  // 🔑 冷卻結束後才送 reset，解除 Python 靜默期
  //    此時距離喚醒已過了 RECORD_DURATION_MS(5s)
  //    冷卻還剩 WAKEUP_COOLDOWN_MS - RECORD_DURATION_MS(3s)
  //    等冷卻完全結束再解除，確保不會提早觸發
  const remainingCooldown = state.cooldownUntil - Date.now();
  setTimeout(() => {
    if (state.active) {
      owwSend(state, 'reset');
      console.log('[STT] 🔓 冷卻結束，解除 OWW 靜默期');
    }
  }, remainingCooldown > 0 ? remainingCooldown : 0);

  // ── 找出說話最多的使用者 ─────────────────────────────
  let bestUserId = userId;
  let bestLength = 0;

  for (const [uid, rs] of state.receivers.entries()) {
    const len = rs.recordChunks.reduce((a, b) => a + b.length, 0);
    if (len > bestLength) { bestLength = len; bestUserId = uid; }
  }

  const bestReceiver   = state.receivers.get(bestUserId);
  const recordedChunks = bestReceiver?.recordChunks?.splice(0) || [];
  for (const rs of state.receivers.values()) rs.recordChunks = [];

  if (recordedChunks.length === 0) {
    console.warn('[STT] ⚠️ 錄製到空音訊');
    await textChannel.send('❌ 沒有偵測到語音，請再試一次').catch(() => {});
    return;
  }

  const pcmBuffer = Buffer.concat(recordedChunks);
  console.log(`[STT] 📼 錄製完成：${pcmBuffer.length} bytes`);

  // ── RMS 靜音過濾 ─────────────────────────────────────
  const rms = calcRMS(pcmBuffer);
  console.log(`[STT] 🔊 RMS 音量：${rms.toFixed(1)}（閾值：${RMS_THRESHOLD}）`);

  if (rms < RMS_THRESHOLD) {
    console.warn('[STT] ⚠️ 音量過低，視為靜音，跳過 Groq');
    await textChannel.send('❌ 沒有偵測到語音，請再試一次').catch(() => {});
    return;
  }

  // ── 寫入 WAV ─────────────────────────────────────────
  ensureTempDir();
  const wavFile = path.join(TEMP_DIR, `stt_${guildId}_${bestUserId}_${Date.now()}.wav`);
  writeWav(wavFile, pcmBuffer);

  // ── Groq Whisper 轉文字 ──────────────────────────────
  let text = '';
  try {
    text = await transcribeWithGroq(wavFile);
    console.log(`[STT] 📝 辨識結果：「${text}」`);
  } catch (err) {
    console.error('[STT] Groq 轉文字失敗:', err.message);
    await textChannel.send('❌ 語音辨識失敗，請再試一次').catch(() => {});
    safeUnlink(wavFile);
    return;
  } finally {
    safeUnlink(wavFile);
  }

  // ── 幻覺過濾 ─────────────────────────────────────────
  if (!text || isHallucination(text)) {
    console.warn(`[STT] 🚫 幻覺輸出已過濾：「${text}」`);
    await textChannel.send('❌ 無法辨識語音內容').catch(() => {});
    return;
  }

  const speakerMember = state.guild.members.cache.get(bestUserId);
  const finalName = speakerMember?.displayName || '使用者';
  await textChannel.send(
    `🗣️ "**${finalName}**" ：${text}`
  ).catch(() => {});

  try {
    await onWakeup(bestUserId, speakerMember, text, textChannel);
  } catch (err) {
    console.error('[STT] Callback 執行失敗:', err.message);
  }
}

// ── 啟動 STT 監聽 ────────────────────────────────────────
function startSTTListening(connection, guild, textChannel, onWakeup) {
  if (guildStates.has(guild.id)) {
    console.warn(`[STT] Guild ${guild.id} 已在監聽中`);
    return;
  }

  const state = {
    connection,
    guild,
    textChannel,
    onWakeup,
    receivers:     new Map(),
    active:        true,
    isRecording:   false,
    cooldownUntil: 0,
    recordTimer:   null,
    owwWs:         null,
    owwReady:      false,
    pendingChunks: [],
    currentSpeaker: null,  // 當前鎖定的發言者
    speakerTimeout: null,  // 釋放鎖定的計時器
  };
  guildStates.set(guild.id, state);

  createOWWConnection(guild.id);

  const channelId = connection.joinConfig.channelId;
  const channel   = guild.channels.cache.get(channelId);
  if (channel) {
    channel.members.forEach((member) => {
      if (!member.user.bot) subscribeUser(guild.id, member.id, member);
    });
  }

  connection.receiver.speaking.on('start', (userId) => {
    if (!state.active) return;
    const member = guild.members.cache.get(userId);
    if (member?.user.bot) return;
    subscribeUser(guild.id, userId, member);
  });

  console.log(`[STT] ✅ 開始監聽 Guild: ${guild.name}，頻道: ${channel?.name || channelId}`);
}

// ── 停止 STT 監聽 ────────────────────────────────────────
function stopSTTListening(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;

  state.active = false;
  if (state.recordTimer) clearTimeout(state.recordTimer);
  if (state.speakerTimeout) clearTimeout(state.speakerTimeout); // 清除發言者鎖定計時器

  if (state.owwWs) {
    try { state.owwWs.close(); } catch {}
    state.owwWs = null;
  }

  for (const [, rs] of state.receivers) {
    try { rs.stream?.destroy(); } catch {}
  }

  state.receivers.clear();
  guildStates.delete(guildId);
  console.log(`[STT] ⏹️ 停止監聽 Guild: ${guildId}`);
}

module.exports = { startSTTListening, stopSTTListening };
