// handlers/voice/stt/listen.js
// 職責：公開 API startSTTListening / stopSTTListening —
//       建立/清除 guild 監聽狀態、註冊 speaking 事件、驅動喚醒偵測

const { DETECT_INTERVAL_MS } = require('../sttConfig');
const {
  guildStates,
  unsubscribeUser,
  subscribeUser,
  startUserIdleCleanup,
  createGuildState,
} = require('../sttSession');

const { triggerDetection } = require('./detect');

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

    // 週期性觸發檢測（每 DETECT_INTERVAL_MS 毫秒檢查一次滑動視窗）
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

  // 先將 active 設為 false，讓所有進行中的非同步操作
  // 在下一個 await 點後能透過 state.active 檢查提早退出
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

module.exports = { startSTTListening, stopSTTListening };
