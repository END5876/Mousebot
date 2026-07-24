// handlers/voice/stt/auto.js
// 職責：喚醒後流程（自動模式）— 播放喚醒音、錄音、STT、AI 回覆 + TTS

const { WAKEUP_COOLDOWN_MS } = require('../sttConfig');
const { guildStates, resetAllRecordBuffers, exitExclusiveMode } = require('../sttSession');
const { getGeminiResponseVoice } = require('../../ai/aiHandler');
const { playTTS } = require('../ttsHandler');

const { playWakeupSound } = require('./wakeup');
const { waitForRecordEnd } = require('./record');
const { processPCMToText } = require('./transcribe');

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

    // [修正 JS-11] 在非同步操作後重新取得 state，防止 stopSTTListening 已被呼叫
    const currentState = guildStates.get(guildId);
    if (!currentState?.active) return;

    const finalName = currentState.guild.members.cache.get(userId)?.displayName || '使用者';
    console.log(`[STT] 📝 ${finalName}：${sttResult.text}`);
    await textChannel?.send(`🗣️ "**${finalName}**" ：${sttResult.text}`).catch(() => {});

    userState.cooldownUntil = Date.now() + WAKEUP_COOLDOWN_MS;
    userState.lastActive    = Date.now();

    try {
      const aiReply = await getGeminiResponseVoice(userId, sttResult.text);
      if (aiReply) {
        // AI 回覆後再次確認 state 仍有效
        if (!guildStates.get(guildId)?.active) return;
        await textChannel?.send(aiReply).catch(() => {});
        // playTTS 已在頂層 require，此處直接使用
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

module.exports = { handleWakeup };
