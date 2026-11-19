'use strict';
// 禁言辱罵者的名單（moderation.js 用）：環境變數＋管理面板兩個來源合併。
//
//   AI_TIMEOUT_USERS=id1,id2     環境變數的名單，唯讀（面板只顯示，改了要重啟）
//   data/aiTimeoutUsers.json     管理面板新增／移除的名單（["id", ...]），立即生效
//
// 兩邊都沒有任何人＝功能關閉。

const logger = require('../../../utils/logger');
const { readJson, writeJsonAtomic } = require('../../../utils/jsonStore');
const { dataPath } = require('../../../utils/dataDir');

const FILE = dataPath('aiTimeoutUsers.json');
const SNOWFLAKE_RE = /^\d{17,20}$/;

/** @type {Set<string>|null} 面板名單；第一次用到才讀檔 */
let panelIds = null;

function panel() {
    if (!panelIds) {
        const data = readJson(FILE, []);
        panelIds = new Set(Array.isArray(data) ? data.map(String).filter(id => SNOWFLAKE_RE.test(id)) : []);
    }
    return panelIds;
}

/** 環境變數的名單每次重新讀（很便宜，測試也能直接改 env） */
function envIds() {
    return new Set((process.env.AI_TIMEOUT_USERS || '').split(',').map(s => s.trim()).filter(Boolean));
}

function save() {
    try {
        writeJsonAtomic(FILE, [...panel()]);
    } catch (err) {
        logger.error('AITimeout', `名單儲存失敗：${err.message}`);
        throw err;
    }
}

const has = (userId) => userId != null && (envIds().has(String(userId)) || panel().has(String(userId)));
const isEmpty = () => envIds().size === 0 && panel().size === 0;

/** { env: [id...], panel: [id...] }（面板名單不重複列出環境變數已有的人） */
function list() {
    const env = envIds();
    return { env: [...env], panel: [...panel()].filter(id => !env.has(id)) };
}

/** 加入面板名單；回傳 false 代表本來就在名單上（環境變數或面板） */
function add(userId) {
    const id = String(userId);
    if (!SNOWFLAKE_RE.test(id)) throw new Error('使用者 ID 格式不正確');
    if (has(id)) return false;
    panel().add(id);
    save();
    return true;
}

/** 從面板名單移除；環境變數裡的人移除不了（回傳 'env'），本來就不在名單回傳 false */
function remove(userId) {
    const id = String(userId);
    if (envIds().has(id)) return 'env';
    if (!panel().delete(id)) return false;
    save();
    return true;
}

module.exports = { has, isEmpty, list, add, remove, _reset: () => { panelIds = null; } };
