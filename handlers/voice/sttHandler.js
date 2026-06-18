// handlers/voice/sttHandler.js — Speaking-Triggered Architecture (RAM-safe)
// 核心流程：喚醒偵測、錄音、Groq STT、AI 回覆 + 公開 API

const { createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const fs   = require('fs');
const path = require('path');
const Groq = require('groq-sdk');
const { getGeminiResponseVoice } = require('../../handlers/ai/aiHandler');

const {
  WAKEUP_VOICE_PATH, TEMP_DIR,
  RECORD_MAX_MS, RECORD_SILENCE_MS, WAKEUP_COOLDOWN_MS,
  RMS_THRESHOLD, DETECT_WINDOW_MS, DETECT_INTERVAL_MS,
  VAD_VOICE_RATIO_MIN, MIN_AUDIO_DURATION_MS, START_DELAY_MS,
  NO_SPEECH_THRESHOLD, SILENCE_CHECK_MS,
  ensureTempDir, safeUnlink, writeWav,
  calcRMS, calcVoiceRatio, calcDurationMs,
  isHallucination, detectWakeword,
} = require('./sttConfig');

const {
  guildStates,
  getCachedRecentRMS,
  resetAllRecordBuffers,
  unsubscribeUser,
  subscribeUser,
  startUserIdleCleanup,
  createGuildState,
  exitExclusiveMode,
} = require('./sttSession');

// ── Groq 客戶端 ─────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ══════════════════════════════════════════════════════════
// 播放喚醒音效
// ══════════════════════════════════════════════════════════
function playWakeupSound(connection) {
  return new Promise((resolve) => {
    if (!connection || !fs.existsSync(WAKEUP_VOICE_PATH)) return resolve();

    let done = false;
    let player = null;

    const finish = () => {
      if (done) return;
      done = true;
      try { player?.stop(); player?.removeAllListeners(); } catch {}
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

// ══════════════════════════════════════════════════════════
// Groq 語音轉文字
// ══════════════════════════════════════════════════════════
async function transcribeWithGroq(wavFilePath) {
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
    try { fileStream.destroy(); } catch {}
  }
}

// ══════════════════════════════════════════════════════════
// 共用錄音等待邏輯（Promise）
// ══════════════════════════════════════════════════════════
function waitForRecordEnd(state, userState, label = '') {
  return new Promise((resolve) => {
    let silenceAccumMs = 0;
    let totalElapsedMs = 0;

    state.recordTimer = setTimeout(() => {
      if (silenceChecker) clearInterval(silenceChecker);
      state.isRecording = false;
      state.recordTimer = null;
      console.log(`[STT]${label} ⏱️ 錄音上限到 (${RECORD_MAX_MS}ms)`);
      resolve();
    }, RECORD_MAX_MS);

    const silenceChecker = setInterval(() => {
      totalElapsedMs += SILENCE_CHECK_MS;
      if (totalElapsedMs <= START_DELAY_MS) return;

      const rms = getCachedRecentRMS(userState);

      if (rms < RMS_THRESHOLD) {
        silenceAccumMs += SILENCE_CHECK_MS;
      } else {
        silenceAccumMs = 0;
      }

      if (silenceAccumMs >= RECORD_SILENCE_MS && totalElapsedMs >= MIN_AUDIO_DURATION_MS) {
        if (state.recordTimer) clearTimeout(state.recordTimer);
        clearInterval(silenceChecker);
        state.isRecording = false;
        state.recordTimer = null;
        console.log(`[STT]${label} 🔇 靜音截止 (${totalElapsedMs}ms)`);
        resolve();
      }
    }, SILENCE_CHECK_MS);
  });
}

// ══════════════════════════════════════════════════════════
// 共用：PCM → STT 驗證 + Groq 轉文字
// ══════════════════════════════════════════════════════════
async function processPCMToText(guildId, userId, recordedChunks, textChannel) {
  if (recordedChunks.length === 0) {
    await textChannel?.send('❌ 沒有偵測到語音，請再試一次').catch(() => {});
    return { ok: false, reason: 'no_audio' };
  }

  const pcmBuffer  = Buffer.concat(recordedChunks);
  const durationMs = calcDurationMs(pcmBuffer);

  if (durationMs < MIN_AUDIO_DURATION_MS) {
    await textChannel?.send('❌ 音訊太短，請再試一次').catch(() => {});
    return { ok: false, reason: 'too_short' };
  }

  const voiceRatio = calcVoiceRatio(pcmBuffer);
  if (voiceRatio < VAD_VOICE_RATIO_MIN && calcRMS(pcmBuffer) < RMS_THRESHOLD) {
    await textChannel?.send('❌ 沒有偵測到有效語音，請再試一次').catch(() => {});
    return { ok: false, reason: 'low_voice' };
  }

  ensureTempDir();
  const wavFile = path.join(TEMP_DIR, `stt_${guildId}_${userId}_${Date.now()}.wav`);
  await writeWav(wavFile, pcmBuffer);

  let text = '';
  try {
    text = await transcribeWithGroq(wavFile);
  } catch (err) {
    console.error(`[STT] Groq 失敗: ${err.message}`);
    await textChannel?.send('❌ 語音辨識失敗，請稍後再試').catch(() => {});
    return { ok: false, reason: 'stt_failed' };
  } finally {
    safeUnlink(wavFile);
  }

  if (!text || isHallucination(text)) {
    await textChannel?.send('❌ 無法辨識語音內容').catch(() => {});
    return { ok: false, reason: 'empty_or_hallucination' };
  }

  return { ok: true, text, pcmBuffer };
}

// ══════════════════════════════════════════════════════════
// 觸發喚醒偵測 (滑動視窗非破壞性讀取)
// ══════════════════════════════════════════════════════════
async function triggerDetection(guildId, userId) {
  const state = guildStates.get(guildId);
  if (!state) return;

  const userState = state.users.get(userId);
  if (!userState) return;

  if (userState.isDetectingRequest) return;
  userState.isDetectingRequest = true;

  try {
    if (state.isExclusive) return;

    const now = Date.now();
    if (now < userState.cooldownUntil) return;

    // ⚠️ 複製一份 Buffer，不破壞原有的滑動視窗
    const chunks = [...userState.detectChunks];
    if (chunks.length === 0) return;

    const pcmBuffer = Buffer.concat(chunks);
    if (calcRMS(pcmBuffer) < RMS_THRESHOLD) return;

    const result = await detectWakeword(guildId, userId, pcmBuffer);
    if (!result.detected) return;

    // ✅ 成功喚醒後，清空滑動視窗，避免剛退出錄音模式又立刻被舊聲音觸發
    userState.detectChunks = [];
    userState.detectBytes = 0;

    const name = userState.member?.displayName || userId;
    console.log(`[STT] ✅ 喚醒 ${name} (prob=${result.prob_score?.toFixed(3)})`);

    await handleWakeup(guildId, userId, userState.member);
  } catch (err) {
    console.error(`[STT] triggerDetection 錯誤: ${err.message}`);
  } finally {
    const latestUserState = guildStates.get(guildId)?.users?.get(userId);
    if (latestUserState) latestUserState.isDetectingRequest = false;
  }
}

// ══════════════════════════════════════════════════════════
// 喚醒後流程（自動模式）
// ══════════════════════════════════════════════════════════
async function handleWakeup(guildId, userId, member) {
  const state = guildStates.get(guildId);
  if (!state || state.isExclusive) return;

  const { connection, textChannel } = state;
  const userState = state.users.get(userId);
  if (!userState) return;

  try {
    state.isExclusive     = true;
    state.exclusiveUserId = userId;
    state.isRecording     = false;

    resetAllRecordBuffers(state);

    const wakeupName = member?.displayName || '使用者';
    textChannel?.send(`🎤 "**${wakeupName}**" 說吧，我在聽`).catch(() => {});

    state.isRecording = true;
    await playWakeupSound(connection).catch(() => {});
    await waitForRecordEnd(state, userState);

    const recordedChunks = userState.recordChunks.splice(0);
    userState.recordBytes = 0;
    userState._lastSilenceChunksLen = -1;
    userState._lastSilenceRMS       = 0;
    resetAllRecordBuffers(state);

    const sttResult = await processPCMToText(guildId, userId, recordedChunks, textChannel);
    if (!sttResult.ok) return;

    const finalName = state.guild.members.cache.get(userId)?.displayName || '使用者';
    console.log(`[STT] 📝 ${finalName}：${sttResult.text}`);
    await textChannel?.send(`🗣️ "**${finalName}**" ：${sttResult.text}`).catch(() => {});

    userState.cooldownUntil = Date.now() + WAKEUP_COOLDOWN_MS;
    userState.lastActive    = Date.now();

    try {
      const aiReply = await getGeminiResponseVoice(userId, sttResult.text);
      if (aiReply) {
        await textChannel?.send(aiReply).catch(() => {});
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
      await textChannel?.send('❌ AI 回覆失敗').catch(() => {});
    }
  } finally {
    exitExclusiveMode(guildId);
  }
}

// ══════════════════════════════════════════════════════════
// 手動模式：初始化 Session
// ══════════════════════════════════════════════════════════
function ensureManualSession(connection, guild, textChannel, onWakeup) {
  const guildId = guild.id;
  let state = guildStates.get(guildId);

  if (!state) {
    state = createGuildState(connection, guild, textChannel, onWakeup, { manualOnly: true });
    guildStates.set(guildId, state);
    startUserIdleCleanup(guildId, state);
    console.log(`[STT][manual] 建立手動 Session：${guild.name}`);
  } else {
    state.active      = true;
    state.connection  = connection  || state.connection;
    state.guild       = guild       || state.guild;
    state.textChannel = textChannel || state.textChannel;
    if (onWakeup) state.onWakeup = onWakeup;
    startUserIdleCleanup(guildId, state);
  }

  return state;
}

// ══════════════════════════════════════════════════════════
// 手動單次錄音
// ══════════════════════════════════════════════════════════
async function manualRecordOnce(guildId, userId, member, textChannel, onWakeupOverride) {
  const state = guildStates.get(guildId);
  if (!state || !state.active) throw new Error('STT Session 不存在，請先 ensureManualSession');

  const userMember = member || state.guild?.members?.cache?.get(userId);
  if (!userMember || userMember.user?.bot) throw new Error('無效的使用者');

  const wasNewlySubscribed = !state.users.has(userId);
  if (wasNewlySubscribed) subscribeUser(guildId, userId, userMember);

  const userState = state.users.get(userId);
  if (!userState) throw new Error('建立使用者音訊訂閱失敗');

  userState.lastActive = Date.now();

  if (state.isExclusive) {
    if (wasNewlySubscribed) unsubscribeUser(guildId, userId);
    throw new Error('目前已有錄音流程進行中，請稍後');
  }

  const targetTextChannel = textChannel || state.textChannel;

  try {
    state.isExclusive     = true;
    state.exclusiveUserId = userId;
    state.isRecording     = false;

    resetAllRecordBuffers(state);

    const wakeupName = userMember?.displayName || '使用者';
    await targetTextChannel?.send(`🎤 "**${wakeupName}**" 手動錄音已開始，請說話`).catch(() => {});

    state.isRecording = true;
    await playWakeupSound(state.connection).catch(() => {});
    await waitForRecordEnd(state, userState, '[manual]');

    const recordedChunks = userState.recordChunks.splice(0);
    userState.recordBytes = 0;
    userState._lastSilenceChunksLen = -1;
    userState._lastSilenceRMS       = 0;
    resetAllRecordBuffers(state);

    const sttResult = await processPCMToText(guildId, userId, recordedChunks, targetTextChannel);
    if (!sttResult.ok) return sttResult;

    const finalName =
      state.guild.members.cache.get(userId)?.displayName ||
      userMember.displayName || '使用者';

    await targetTextChannel?.send(`🗣️ "**${finalName}**"：${sttResult.text}`).catch(() => {});

    userState.cooldownUntil = Date.now() + WAKEUP_COOLDOWN_MS;
    userState.lastActive    = Date.now();

    const cb = onWakeupOverride || state.onWakeup;
    if (typeof cb === 'function') {
      await cb(userId, userMember, sttResult.text, targetTextChannel);
    }

    return { ok: true, text: sttResult.text };
  } catch (err) {
    if (!state.isExclusive && wasNewlySubscribed) unsubscribeUser(guildId, userId);
    throw err;
  } finally {
    exitExclusiveMode(guildId);
  }
}

// ══════════════════════════════════════════════════════════
// 公開 API：startSTTListening
// ══════════════════════════════════════════════════════════
function startSTTListening(connection, guild, textChannel, onWakeup) {
  const guildId = guild.id;

  if (guildStates.has(guildId)) {
    const existing = guildStates.get(guildId);

    if (existing.active) {
      if (existing.connection === connection) {
        existing.textChannel = textChannel || existing.textChannel;
        if (onWakeup) existing.onWakeup = onWakeup;
        startUserIdleCleanup(guildId, existing);
        console.log(`[STT] ${guildId} 已在監聽中（已更新 textChannel）`);
        return;
      }
      console.log(`[STT] ${guildId} 偵測到新 connection，先停止舊監聽再重新建立`);
      stopSTTListening(guildId);
    } else {
      guildStates.delete(guildId);
    }
  }

  const state = createGuildState(connection, guild, textChannel, onWakeup);
  guildStates.set(guildId, state);
  startUserIdleCleanup(guildId, state);

  // 訂閱頻道內現有成員
  const voiceChannel = guild.channels.cache.get(connection.joinConfig.channelId);
  if (voiceChannel) {
    for (const [memberId, member] of voiceChannel.members) {
      if (!member.user.bot) subscribeUser(guildId, memberId, member);
    }
  }

  // Speaking 事件
  const onSpeakingStart = (userId) => {
    if (!state.active) return;

    const member = guild.members.cache.get(userId);
    if (member && !member.user.bot) subscribeUser(guildId, userId, member);

    const userState = state.users.get(userId);
    if (userState) userState.lastActive = Date.now();

    if (state.isExclusive) return;
    if (!userState || userState.isDetecting) return;

    userState.isDetecting = true;
    
    // ⚠️ 週期性觸發檢測 (每 DETECT_INTERVAL_MS 毫秒檢查一次滑動視窗)
    userState.detectTimer = setInterval(() => {
      triggerDetection(guildId, userId);
    }, DETECT_INTERVAL_MS);
  };

  const onSpeakingEnd = (userId) => {
    if (!state.active) return;

    const userState = state.users.get(userId);
    if (!userState || !userState.isDetecting) return;

    userState.lastActive = Date.now();
    userState.isDetecting = false;

    if (userState.detectTimer) {
      clearInterval(userState.detectTimer);
      userState.detectTimer = null;
    }

    // 結束說話時，做最後一次檢查
    triggerDetection(guildId, userId);
  };

  connection.receiver.speaking.on('start', onSpeakingStart);
  connection.receiver.speaking.on('end',   onSpeakingEnd);

  state._onSpeakingStart = onSpeakingStart;
  state._onSpeakingEnd   = onSpeakingEnd;

  // 記憶體監控（可選）
  if (process.env.STT_DEBUG_MEM === '1') {
    state._memTimer = setInterval(() => {
      const m = process.memoryUsage();
      console.log(
        `[MEM][${guildId}] ` +
        `rss=${(m.rss / 1024 / 1024).toFixed(1)}MB ` +
        `heap=${(m.heapUsed / 1024 / 1024).toFixed(1)}MB ` +
        `ext=${(m.external / 1024 / 1024).toFixed(1)}MB ` +
        `users=${state.users.size}`
      );
    }, 30000);
  }

  console.log(`[STT] 開始監聽：${guild.name}`);
}

// ══════════════════════════════════════════════════════════
// 公開 API：stopSTTListening
// ══════════════════════════════════════════════════════════
function stopSTTListening(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;

  state.active = false;

  if (state._onSpeakingStart) {
    try { state.connection.receiver.speaking.removeListener('start', state._onSpeakingStart); } catch {}
    state._onSpeakingStart = null;
  }

  if (state._onSpeakingEnd) {
    try { state.connection.receiver.speaking.removeListener('end', state._onSpeakingEnd); } catch {}
    state._onSpeakingEnd = null;
  }

  if (state.recordTimer)      { clearTimeout(state.recordTimer);          state.recordTimer = null; }
  if (state._memTimer)        { clearInterval(state._memTimer);           state._memTimer   = null; }
  if (state._userCleanupTimer){ clearInterval(state._userCleanupTimer);   state._userCleanupTimer = null; }

  for (const userId of Array.from(state.users.keys())) {
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