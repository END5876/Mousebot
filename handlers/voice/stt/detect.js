// handlers/voice/stt/detect.js
// 職責：觸發喚醒偵測 (滑動視窗非破壞性讀取)

const { RMS_THRESHOLD, calcRMS, detectWakeword } = require('../sttConfig');
const { guildStates, clearDetectBuffer } = require('../sttSession');

// 延遲 require 避免 detect.js <-> auto.js 之間形成循環依賴問題
// （auto.js 目前不需要 detect.js，但保留延遲載入寫法讓依賴方向更清楚）
function _getHandleWakeup() {
  return require('./auto').handleWakeup;
}

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

    // 直接使用增量維護的 detectMergedBuffer，
    // 不再每次重新 Buffer.concat，消除高頻 GC 壓力
    const pcmBuffer = userState.detectMergedBuffer;
    if (!pcmBuffer || pcmBuffer.length === 0) return;

    if (calcRMS(pcmBuffer) < RMS_THRESHOLD) return;

    // detectWakeword 內的 Semaphore.acquire() 可能因佇列已滿而拋出，
    // 此處 catch 已涵蓋，不影響正常流程
    const result = await detectWakeword(guildId, userId, pcmBuffer);
    if (!result.detected) return;

    // 成功喚醒後，清空滑動視窗，避免剛退出錄音模式又立刻被舊聲音觸發
    // 改用 clearDetectBuffer 同步清空 detectMergedBuffer
    clearDetectBuffer(userState);

    const name = userState.member?.displayName || userId;
    console.log(`[STT] ✅ 喚醒 ${name} (prob=${result.prob_score?.toFixed(3)})`);

    await _getHandleWakeup()(guildId, userId, userState.member);
  } catch (err) {
    console.error(`[STT] triggerDetection 錯誤: ${err.message}`);
  } finally {
    const latestUserState = guildStates.get(guildId)?.users?.get(userId);
    if (latestUserState) latestUserState.isDetectingRequest = false;
  }
}

module.exports = { triggerDetection };
