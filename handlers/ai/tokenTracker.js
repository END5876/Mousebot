const path = require('path');
const logger = require('../../utils/logger');
const { readJson, createDebouncedWriter } = require('../../utils/jsonStore');

// ════════════════════════════════════════════════════════
//  路徑與設定
// ════════════════════════════════════════════════════════
const USAGE_PATH       = path.resolve(__dirname, '../../data/tokenUsage.json');
const RETENTION_DAYS   = 90;
const SAVE_DEBOUNCE_MS = 10 * 1000;

// 結構：
// {
//   "2026-10-10": {
//     total:    { calls, prompt, output, thoughts, cached, total },
//     bySource: { chat: {...}, short: {...}, voice: {...}, gugu: {...}, billScan: {...} },
//     byMode:   { loss: {...}, ... },
//     byUser:   { "<userId>": {...} },
//   }
// }
let usage = {};

// ════════════════════════════════════════════════════════
//  載入 / 儲存
// ════════════════════════════════════════════════════════
function load() {
    const data = readJson(USAGE_PATH, {});
    usage = data && typeof data === 'object' ? data : {};
    logger.debug('TokenTracker', `已載入 ${Object.keys(usage).length} 天的用量紀錄`);
}

function pruneOldDays() {
    const cutoff = dateKey(new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000));
    for (const day of Object.keys(usage)) {
        if (day < cutoff) delete usage[day];
    }
}

// 每次呼叫都寫檔太頻繁，累積一段時間再一次寫入（程序結束時自動補寫）
const writer = createDebouncedWriter(USAGE_PATH, () => {
    pruneOldDays();
    return usage;
}, { debounceMs: SAVE_DEBOUNCE_MS, label: 'TokenTracker' });

// ════════════════════════════════════════════════════════
//  累加
// ════════════════════════════════════════════════════════
// 使用本機時區的日期（sv-SE 格式剛好是 YYYY-MM-DD）
function dateKey(date = new Date()) {
    return date.toLocaleDateString('sv-SE');
}

function emptyBucket() {
    return { calls: 0, prompt: 0, output: 0, thoughts: 0, cached: 0, total: 0 };
}

function addTo(group, key, counts) {
    const bucket = group[key] ?? (group[key] = emptyBucket());
    for (const k of Object.keys(counts)) bucket[k] += counts[k];
    bucket.calls += 1;
}

/**
 * 記錄單次 Gemini 呼叫的 token 用量（同時印出 log 並累加進每日統計）
 * @param {string} source 呼叫來源：chat / short / voice / gugu / billScan
 * @param {object} response Gemini 的 result.response
 * @param {{ userId?: string, mode?: string }} [meta]
 */
function recordUsage(source, response, { userId = null, mode = null } = {}) {
    const meta = response?.usageMetadata;
    const label = [source, userId && `user:${userId}`, mode && `mode:${mode}`].filter(Boolean).join(' / ');
    if (!meta) {
        logger.warn('Token', `(${label}) 無法取得 usageMetadata`);
        return;
    }

    // thoughtsTokenCount（思考 token）不包含在 candidatesTokenCount 內，但同樣以輸出計費
    const counts = {
        prompt:   meta.promptTokenCount        ?? 0,
        output:   meta.candidatesTokenCount    ?? 0,
        thoughts: meta.thoughtsTokenCount      ?? 0,
        cached:   meta.cachedContentTokenCount ?? 0,
        total:    meta.totalTokenCount         ?? 0,
    };

    logger.debug('Token',
        `(${label}) 輸入: ${counts.prompt} (快取 ${counts.cached}) | 輸出: ${counts.output} | ` +
        `思考: ${counts.thoughts} | 總計: ${counts.total}`
    );

    const day = usage[dateKey()] ?? (usage[dateKey()] = { total: emptyBucket(), bySource: {}, byMode: {}, byUser: {} });
    addTo(day, 'total', counts);
    addTo(day.bySource, source, counts);
    if (mode)   addTo(day.byMode, mode, counts);
    if (userId) addTo(day.byUser, userId, counts);
    writer.schedule();
}

/** 今日全體已使用的 token 總數 */
function getTodayTotal() {
    return usage[dateKey()]?.total?.total ?? 0;
}

/** 今日指定使用者已使用的 token 總數 */
function getTodayUserTotal(userId) {
    return usage[dateKey()]?.byUser?.[userId]?.total ?? 0;
}

load();

module.exports = { recordUsage, getTodayTotal, getTodayUserTotal };
