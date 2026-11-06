const { USER_MODE_OVERRIDES, DEFAULT_MODE } = require('./aiSettings');
const promptStore = require('./promptStore');
const logger = require('../../utils/logger');
const { readJson, writeJsonAtomic } = require('../../utils/jsonStore');
const { dataPath } = require('../../utils/dataDir');

// ════════════════════════════════════════════════════════
//  常數
// ════════════════════════════════════════════════════════
// 資料目錄可用 MOUSEBOT_DATA_DIR 覆寫（測試不讀寫正式的 data/）
const MODES_FILE_PATH = dataPath('userModes.json');

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
 * 所有使用者的動態模式設定 { userId: mode }（管理面板用）
 */
function listUserModes() {
    return Object.fromEntries(userModeOverride);
}

/**
 * 根據用戶 ID 選擇適當的模式
 * 優先順序：動態覆蓋 > AI_USER_MODE_OVERRIDES > 預設
 * 覆蓋或固定人格的模式檔若不存在，就略過往下判斷
 */
function selectMode(userId, content) {
    const override = userModeOverride.get(userId);
    if (override && promptStore.getMode(override)) return override;

    const fixed = USER_MODE_OVERRIDES[userId];
    if (fixed) {
        if (promptStore.getMode(fixed)) return fixed;
        warnMissingFixedMode(fixed);
    }

    return DEFAULT_MODE;
}

// 固定人格的模式檔不存在時，每個代號只警告一次（不印使用者 ID）
const warnedMissingFixed = new Set();
function warnMissingFixedMode(mode) {
    if (warnedMissingFixed.has(mode)) return;
    warnedMissingFixed.add(mode);
    logger.warn('ModeSelector', `AI_USER_MODE_OVERRIDES 指定的人格 ${mode} 不存在，改用 ${DEFAULT_MODE}（之後不再重複提示）`);
}

/**
 * AI_USER_MODE_OVERRIDES 指定的固定人格 { userId: mode }（管理面板用；回傳複本）
 */
function listFixedUserModes() {
    return { ...USER_MODE_OVERRIDES };
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
    listUserModes,
    listFixedUserModes,
    getAvailableModes,
};
