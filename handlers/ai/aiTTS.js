// handlers/ai/aiTTS.js
// AI 回覆朗讀（/ai tts 與管理面板共用）：各伺服器的開關，以及把 AI 回覆交給 TTS 模組念出來。
// 從 aiUtils.js 拆出來，讓 aiUtils 不必依賴 TTS 模組；utils/features.js 把這裡登記成 hidden 模組 aiTts
// （需要 ai 和 tts），所以呼叫端一律透過 features.get('aiTts') 取得，TTS 停用時拿到 null。
// 注意：不可以在最上層呼叫 features.get()（見 utils/features.js 檔頭）。

const logger = require('../../utils/logger');
const features = require('../../utils/features');
const { readJson, writeJsonAtomic } = require('../../utils/jsonStore');
const { dataPath } = require('../../utils/dataDir');

const TTS_MAX_LENGTH = 1000;

// 各伺服器的 AI 回覆朗讀開關，存在 data/aiTTS.json（可用 MOUSEBOT_DATA_DIR 改目錄），重新啟動後保留
const AI_TTS_PATH = dataPath('aiTTS.json');
const aiTTSEnabled = (() => {
    const saved = readJson(AI_TTS_PATH, {});
    return new Map(Object.entries(saved && typeof saved === 'object' ? saved : {}).filter(([, v]) => typeof v === 'boolean'));
})();

// 沒切換過的伺服器看 AI_TTS_DEFAULT（預設開；設 0 預設關閉）。每次都重新讀 env，測試可以直接改
function isAITTSEnabled(guildId) {
    return aiTTSEnabled.get(guildId) ?? (process.env.AI_TTS_DEFAULT?.trim() !== '0');
}

function setAITTSEnabled(guildId, value) {
    aiTTSEnabled.set(guildId, value);
    try {
        writeJsonAtomic(AI_TTS_PATH, Object.fromEntries(aiTTSEnabled));
    } catch (err) {
        logger.warn('AI', `儲存 AI 朗讀開關失敗：${err.message}`);
    }
}

// ════════════════════════════════════════════════════════
//  TTS 播放
// ════════════════════════════════════════════════════════
async function speakWithTTS(source, text, guildId) {
    const tts = features.get('tts');
    if (!tts || !guildId || !isAITTSEnabled(guildId)) return;
    const voiceChannel = source.member?.voice?.channel;
    if (!voiceChannel) {
        logger.info('TTS', `🔇 使用者不在語音頻道，跳過朗讀`);
        return;
    }
    const ttsText = text.length > TTS_MAX_LENGTH ? text.slice(0, TTS_MAX_LENGTH) : text;
    try {
        const result = await tts.playTTS(guildId, ttsText);
        if (!result.success) {
            logger.warn('TTS', `朗讀失敗 (reason: ${result.reason})`);
        } else {
            logger.debug('TTS', `🔊 朗讀中 (engine: ${result.engine}, queued: ${result.queued})`);
        }
    } catch (err) {
        logger.error('TTS', '呼叫 playTTS 發生錯誤:', err.message);
    }
}

module.exports = { TTS_MAX_LENGTH, isAITTSEnabled, setAITTSEnabled, speakWithTTS };
