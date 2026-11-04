// handlers/ai/aiMessageLog.js
// AI 回覆紀錄：記下每則 AI 回覆訊息是「用哪個人格、回給誰」，存在 data/aiMessageLog.json。
// 過去 botMessageCache 只存在記憶體，Bot 重啟後查不到紀錄，人格隔離就退化成只看 reply reference，
// 而 @ 回覆都是 channel.send（沒有 reference），重啟後別的人格說的話會混進歷史。
//
// 每筆：{ mode, userId, userName, kind?, scopeKey?, askText?, ts }
//   kind／scopeKey：單一人格模式用來區分範圍（多人格的呼叫端不傳，維持原本行為）
//   askText：/ai ask 的問題原文（最多 300 字），群組歷史會拿來補上問題
// 上限 3000 筆、保留 7 天；寫入用一個 debounced writer（5 秒）合併。
//
// 注意：不要 require aiUtils（會連帶載入 ttsHandler 與 sharp），aiUtils 反過來 re-export 這裡的函式。
// 第一次用到時才讀檔（lazy），require 本模組不會碰到任何檔案。

const { readJson, createDebouncedWriter } = require('../../utils/jsonStore');
const { dataPath } = require('../../utils/dataDir');

const FILE_NAME = 'aiMessageLog.json';
const MAX_ENTRIES = 3000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ASK_TEXT_MAX = 300;
const WRITE_DEBOUNCE_MS = 5000;

let log = null;        // Map<messageId, entry>，依寫入順序（最舊在前）
let writer = null;
let writerPath = null;

function isValidEntry(e) {
    return e && typeof e === 'object' && typeof e.mode === 'string' && e.mode && Number.isFinite(e.ts);
}

function ensureWriter(file) {
    // 每個 createDebouncedWriter 都會註冊一個 exit listener：同一個檔只建一次
    if (writer && writerPath === file) return;
    writer = createDebouncedWriter(file, () => Object.fromEntries(log ?? []), {
        debounceMs: WRITE_DEBOUNCE_MS, pretty: false, label: 'AI',
    });
    writerPath = file;
}

function load() {
    if (log) return log;
    const file = dataPath(FILE_NAME);
    const raw = readJson(file, {});
    const now = Date.now();
    const entries = Object.entries(raw && typeof raw === 'object' ? raw : {})
        .filter(([, e]) => isValidEntry(e) && now - e.ts <= RETENTION_MS)
        .sort((a, b) => a[1].ts - b[1].ts)
        .slice(-MAX_ENTRIES);
    log = new Map(entries);
    ensureWriter(file);
    return log;
}

function prune(map, now) {
    // Map 依插入順序，最舊的在前面：先淘汰過期的，再淘汰超過上限的
    for (const [id, e] of map) {
        if (now - e.ts <= RETENTION_MS && map.size < MAX_ENTRIES) break;
        map.delete(id);
    }
}

/**
 * @param {string} messageId
 * @param {string} mode
 * @param {string} userId
 * @param {string} userName
 * @param {{ kind?: 'multi'|'single', scopeKey?: string|null, askText?: string|null }} [extra]
 */
function recordBotMessageContext(messageId, mode, userId, userName, extra = {}) {
    if (!messageId || !mode) return;
    // 預設值只在 undefined 時生效；呼叫端傳 null 或非物件時也不能在回覆路徑上拋錯
    const ex = extra && typeof extra === 'object' ? extra : {};
    const map = load();
    const now = Date.now();
    const entry = { mode, userId, userName, ts: now };
    if (ex.kind) entry.kind = ex.kind;
    if (ex.scopeKey) entry.scopeKey = ex.scopeKey;
    if (typeof ex.askText === 'string' && ex.askText.trim()) {
        entry.askText = ex.askText.trim().slice(0, ASK_TEXT_MAX);
    }
    map.delete(messageId);   // 重新插入到最後，維持時間順序
    prune(map, now);
    map.set(messageId, entry);
    writer.schedule();
}

function getBotMessageContext(messageId) {
    if (!messageId) return undefined;
    const entry = load().get(messageId);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > RETENTION_MS) return undefined;
    return entry;
}

/** 測試用：立即寫出 */
function _flush() {
    if (log) writer?.flush();
}

/** 測試用：寫出後丟掉記憶體內的紀錄，下次呼叫重新讀檔（模擬重啟） */
function _reset() {
    if (log) writer?.flush();
    log = null;
}

module.exports = {
    recordBotMessageContext, getBotMessageContext,
    MAX_ENTRIES, RETENTION_MS, ASK_TEXT_MAX,
    _flush, _reset,
};
