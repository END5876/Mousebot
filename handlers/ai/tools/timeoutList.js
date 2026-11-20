'use strict';
// 禁言辱罵者的名單與禁言時長（moderation.js 用）：環境變數＋管理面板兩個來源。
//
//   AI_TIMEOUT_USERS=id1,id2     環境變數的名單，唯讀（面板只顯示，改了要重啟）
//   data/aiTimeoutUsers.json     管理面板新增／移除的名單（["id", ...]），立即生效
//   兩邊都沒有任何人＝功能關閉。
//
//   AI_TIMEOUT_SECONDS=60        「最長」禁言時長的預設值（秒；10 秒～28 天，不合法時用 60）
//   data/aiTimeoutSettings.json  管理面板設定的最長時長（{ seconds }），優先於環境變數，立即生效
//   實際時長由 AI 依嚴重度決定（不超過最長），見 moderation.js 的 severityDuration

const logger = require('../../../utils/logger');
const { readJson, writeJsonAtomic } = require('../../../utils/jsonStore');
const { dataPath } = require('../../../utils/dataDir');

const FILE = dataPath('aiTimeoutUsers.json');
const SETTINGS_FILE = dataPath('aiTimeoutSettings.json');

const DEFAULT_SECONDS = 60;
const MIN_SECONDS = 10;
const MAX_SECONDS = 28 * 24 * 60 * 60; // Discord timeout 的上限
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

// ── 禁言時長 ─────────────────────────────────────────────
const validSeconds = (n) => Number.isInteger(n) && n >= MIN_SECONDS && n <= MAX_SECONDS;

/** @type {number|null|undefined} 面板設定的秒數；undefined＝還沒讀檔、null＝沒設定 */
let panelSeconds;

function panelDuration() {
    if (panelSeconds === undefined) {
        const n = readJson(SETTINGS_FILE, {})?.seconds;
        panelSeconds = validSeconds(n) ? n : null;
    }
    return panelSeconds;
}

/** 環境變數的秒數；沒設定或不合法時是 null */
function envDuration() {
    const raw = process.env.AI_TIMEOUT_SECONDS;
    if (raw == null || raw.trim() === '') return null;
    const n = Number(raw);
    return validSeconds(n) ? n : null;
}

/** 目前生效的時長：{ seconds, source: 'panel'|'env'|'default' } */
function getDuration() {
    const p = panelDuration();
    if (p != null) return { seconds: p, source: 'panel' };
    const e = envDuration();
    if (e != null) return { seconds: e, source: 'env' };
    return { seconds: DEFAULT_SECONDS, source: 'default' };
}

/** 面板設定時長；null＝清掉面板設定（回到環境變數或預設） */
function setDuration(seconds) {
    if (seconds !== null && !validSeconds(seconds)) {
        throw new Error(`禁言時長要是 ${MIN_SECONDS} 秒到 28 天之間的整數秒數`);
    }
    try {
        writeJsonAtomic(SETTINGS_FILE, seconds === null ? {} : { seconds });
    } catch (err) {
        logger.error('AITimeout', `時長儲存失敗：${err.message}`);
        throw err;
    }
    panelSeconds = seconds;
    return getDuration();
}

/** 秒數 → 「1 分鐘」「1 小時 30 分鐘」「2 天」 */
function formatDuration(seconds) {
    const units = [[86400, '天'], [3600, '小時'], [60, '分鐘'], [1, '秒']];
    const parts = [];
    let rest = seconds;
    for (const [size, name] of units) {
        const n = Math.floor(rest / size);
        if (n) { parts.push(`${n} ${name}`); rest -= n * size; }
    }
    return parts.join(' ') || '0 秒';
}

module.exports = {
    has, isEmpty, list, add, remove,
    getDuration, setDuration, formatDuration, DEFAULT_SECONDS, MIN_SECONDS, MAX_SECONDS,
    _reset: () => { panelIds = null; panelSeconds = undefined; },
};
