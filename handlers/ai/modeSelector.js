const path = require('path');
const fs   = require('fs');
const { LOVER_MODE_USER_IDS, DEVELOPER_MODE_USER_IDS } = require('./aiSettings');

// ════════════════════════════════════════════════════════
//  常數
// ════════════════════════════════════════════════════════
const MODES_FILE_PATH = path.resolve(__dirname, '../../data/userModes.json');

const AVAILABLE_MODES = ['loss', 'mambaMentor', 'mygo', 'inmu', 'lover', 'developer', 'gugu', 'mesugaki', 'china'];

// ════════════════════════════════════════════════════════
//  JSON 持久化
// ════════════════════════════════════════════════════════

/** 從 JSON 載入模式表，回傳 Map */
function loadModes() {
    try {
        if (!fs.existsSync(MODES_FILE_PATH)) {
            fs.writeFileSync(MODES_FILE_PATH, '{}', 'utf-8');
            console.log('[ModeSelector] 已建立 userModes.json');
            return new Map();
        }
        const raw = fs.readFileSync(MODES_FILE_PATH, 'utf-8');
        const obj = JSON.parse(raw);
        return new Map(Object.entries(obj));
    } catch (err) {
        console.error('[ModeSelector] 載入 userModes.json 失敗：', err.message);
        return new Map();
    }
}

/** 將 Map 寫回 JSON */
function saveModes(map) {
    try {
        const obj = Object.fromEntries(map);
        fs.writeFileSync(MODES_FILE_PATH, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
        console.error('[ModeSelector] 寫入 userModes.json 失敗：', err.message);
    }
}

// 啟動時載入
const userModeOverride = loadModes();
console.log(`[ModeSelector] 已載入 ${userModeOverride.size} 筆使用者模式設定`);

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
    console.log(`[ModeSelector] 已更新 ${userId} -> ${mode ?? '(預設)'}`);
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
 */
function selectMode(userId, content) {
    const override = userModeOverride.get(userId);
    if (override) return override;

    if (LOVER_MODE_USER_IDS.includes(userId)) return 'lover';
    if (DEVELOPER_MODE_USER_IDS.includes(userId)) return 'developer';

    return 'loss';
}

/**
 * 獲取模式的顯示名稱（用於日誌）
 */
function getModeName(mode) {
    const names = {
        loss:        '損友模式',
        mambaMentor: '牢大模式',
        mygo:        'MyGO 模式',
        inmu:        '淫夢模式',
        lover:       '戀人模式',
        developer:   '開發者模式',
        gugu:        '咕咕模式',
        mesugaki:    '磁小鬼模式',
        china:       '中國模式',
    };
    return names[mode] ?? mode;
}

module.exports = {
    selectMode,
    getModeName,
    setUserMode,
    getUserModeOverride,
    AVAILABLE_MODES,
};