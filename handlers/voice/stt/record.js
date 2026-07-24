// handlers/voice/stt/record.js
// 職責：共用錄音等待邏輯（Promise），供自動喚醒與手動錄音共用

const { RECORD_MAX_MS, RECORD_SILENCE_MS, START_DELAY_MS, MIN_AUDIO_DURATION_MS, SILENCE_CHECK_MS, RMS_THRESHOLD } = require('../sttConfig');
const { getCachedRecentRMS } = require('../sttSession');

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

module.exports = { waitForRecordEnd };
