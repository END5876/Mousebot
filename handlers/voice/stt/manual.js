// handlers/voice/stt/manual.js
// 職責：手動模式 — 初始化 Session、手動單次錄音

const { WAKEUP_COOLDOWN_MS } = require('../sttConfig');
const {
  guildStates,
  resetAllRecordBuffers,
  unsubscribeUser,
  subscribeUser,
  startUserIdleCleanup,
  createGuildState,
  exitExclusiveMode,
} = require('../sttSession');

const { playWakeupSound } = require('./wakeup');
const { waitForRecordEnd } = require('./record');
const { processPCMToText } = require('./transcribe');

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
    exitExclusiveMode(guildId);
    if (wasNewlySubscribed) unsubscribeUser(guildId, userId);
    throw err;
  } finally {
    // exitExclusiveMode 可能已在 catch 中呼叫，此處呼叫為冪等操作（安全）
    exitExclusiveMode(guildId);
  }
}

module.exports = { ensureManualSession, manualRecordOnce };
