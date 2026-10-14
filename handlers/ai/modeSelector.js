const path = require('path');
const { LOVER_MODE_USER_IDS, DEVELOPER_MODE_USER_IDS } = require('./aiSettings');
const promptStore = require('./promptStore');
const logger = require('../../utils/logger');
const { readJson, writeJsonAtomic } = require('../../utils/jsonStore');

// ════════════════════════════════════════════════════════
//  常數
// ════════════════════════════════════════════════════════
const MODES_FILE_PATH = path.resolve(__dirname, '../../data/userModes.json');

// ════════════════════════════════════════════════════════
//  JSON 持久化
// ════════════════════════════════════════════════════════

/** 從 JSON 載入模式表，回傳 Map */
function loadModes() {
    const obj = readJson(MODES_FILE_PATH, {});
    return new Map(Object.entries(obj && typeof obj === 'object' ? obj : {}));
}

/** 將 Map 寫回 JSON */
function saveModes(map) {
    try {
        writeJsonAtomic(MODES_FILE_PATH, Object.fromEntries(map));
    } catch (err) {
        logger.error('ModeSelector', `寫入 userModes.json 失敗：${err.message}`);
    }
}

// 啟動時載入
const userModeOverride = loadModes();
logger.debug('ModeSelector', `已載入 ${userModeOverride.size} 筆使用者模式設定`);

// ════════════════════════════════════════════════════════
//  模式操作
// ════════════════════════════════════════════════════════

/**
 * 設定使用者的動態模式（同時寫入 JSON）
 * @param {string} userId
 * @param {string|null} mode - 傳 null 代表清除覆蓋（回到預設）
 */
function setUserMode(userId, mode) {
    if (mode === null) {
        userModeOverride.delete(userId);
    } else {
        userModeOverride.set(userId, mode);
    }
    saveModes(userModeOverride);
    logger.info('ModeSelector', `已更新 ${userId} -> ${mode ?? '(預設)'}`);
}

/**
 * 取得使用者目前設定的動態模式（沒有則回傳 null）
 */
function getUserModeOverride(userId) {
    return userModeOverride.get(userId) ?? null;
}

/**
 * 根據用戶 ID 選擇適當的模式
 * 優先順序：動態覆蓋 > 特殊身份 > 預設
 * 覆蓋的模式檔若已被刪除，就略過覆蓋往下判斷
 */
function selectMode(userId, content) {
    const override = userModeOverride.get(userId);
    if (override && promptStore.getMode(override)) return override;

    if (LOVER_MODE_USER_IDS.includes(userId)) return 'lover';
    if (DEVELOPER_MODE_USER_IDS.includes(userId)) return 'developer';

    return 'loss';
}

/**
 * 獲取模式的顯示名稱（取自模式檔 front matter 的 name）
 */
function getModeName(mode) {
    return promptStore.getMode(mode)?.name ?? mode;
}

/**
 * 目前所有可用模式（即 data/prompts/modes/ 底下的檔案）
 */
function getAvailableModes() {
    return promptStore.listModes();
}

module.exports = {
    selectMode,
    getModeName,
    setUserMode,
    getUserModeOverride,
    getAvailableModes,
};
