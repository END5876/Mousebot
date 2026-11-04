// handlers/ai/aiMemoryState.js
// 「清除對話記憶的時間點」，存在 data/aiMemoryState.json。
// 過去 memoryClearedAt 只存在記憶體，Bot 重啟後 /ai clear 就失效（舊對話又流回歷史）。
// 寫入頻率很低（只有 /ai clear、管理面板），直接用 writeJsonAtomic 整份寫回。
//
// 注意：不要 require aiUtils（會連帶載入 ttsHandler 與 sharp），aiUtils 反過來 re-export 這裡的函式。
// 第一次用到時才讀檔（lazy），require 本模組不會碰到任何檔案。

const logger = require('../../utils/logger');
const { readJson, writeJsonAtomic } = require('../../utils/jsonStore');
const { dataPath } = require('../../utils/dataDir');

const FILE_NAME = 'aiMemoryState.json';

let state = null;   // { userClears, channelClears, userInChannel }
let filePath = null;

function asTimeMap(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [k, v] of Object.entries(raw)) {
        if (Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
}

function load() {
    if (state) return state;
    filePath = dataPath(FILE_NAME);
    const raw = readJson(filePath, {});
    state = {
        userClears: asTimeMap(raw?.userClears),
        channelClears: asTimeMap(raw?.channelClears),
        userInChannel: asTimeMap(raw?.userInChannel),
    };
    return state;
}

function save() {
    try {
        writeJsonAtomic(filePath, state);
    } catch (err) {
        logger.warn('Memory', `儲存 ${FILE_NAME} 失敗：${err.message}`);
    }
}

// ── 使用者（Mode A 的 /ai clear，跨頻道）──
function clearUserMemory(userId, at = Date.now()) {
    load().userClears[userId] = at;
    save();
    logger.debug('Memory', `已清除使用者 ${userId} 的對話記憶`);
}

function getMemoryClearTime(userId) {
    return load().userClears[userId] ?? 0;
}

// ── 整個頻道（Mode B 管理員清除）──
function clearChannelMemory(channelId, at = Date.now()) {
    load().channelClears[channelId] = at;
    save();
    logger.debug('Memory', `已清除頻道 ${channelId} 的對話記憶`);
}

function getChannelClearTime(channelId) {
    return load().channelClears[channelId] ?? 0;
}

// ── 某成員在某頻道（Mode B 一般成員的 /ai clear：只讓自己的發言退出群組歷史）──
function clearUserInChannel(channelId, userId, at = Date.now()) {
    load().userInChannel[`${channelId}:${userId}`] = at;
    save();
    logger.debug('Memory', `已清除使用者 ${userId} 在頻道 ${channelId} 的對話記憶`);
}

function getUserInChannelClearTime(channelId, userId) {
    return load().userInChannel[`${channelId}:${userId}`] ?? 0;
}

/** 測試用：丟掉記憶體內的狀態，下次呼叫重新讀檔（模擬重啟） */
function _reset() {
    state = null;
    filePath = null;
}

module.exports = {
    clearUserMemory, getMemoryClearTime,
    clearChannelMemory, getChannelClearTime,
    clearUserInChannel, getUserInChannelClearTime,
    _reset,
};
