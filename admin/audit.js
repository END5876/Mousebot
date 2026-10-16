'use strict';
// admin/audit.js
// ─────────────────────────────────────────────────────────────
// 管理面板的操作紀錄：誰（來源 IP）在什麼時候做了什麼，存在 data/adminAudit.json（保留最近 1000 筆）。
// API 處理函式呼叫 ctx.audit('…') 描述這次的操作；請求成功完成後才會寫入，失敗的操作不記錄。

const path = require('path');
const logger = require('../utils/logger');
const { readJson, createDebouncedWriter } = require('../utils/jsonStore');

// ADMIN_AUDIT_FILE：改放到別的位置（給測試用，避免寫進真正的 data/）
const AUDIT_PATH = process.env.ADMIN_AUDIT_FILE || path.join(__dirname, '..', 'data', 'adminAudit.json');
const MAX_ENTRIES = 1000;

let entries = (() => {
  const saved = readJson(AUDIT_PATH, []);
  return Array.isArray(saved) ? saved.filter((e) => e && typeof e.ts === 'number' && typeof e.action === 'string') : [];
})();
let seq = entries.reduce((max, e) => Math.max(max, e.id ?? 0), 0);

const writer = createDebouncedWriter(AUDIT_PATH, () => entries, { debounceMs: 2000, label: 'Admin' });

/**
 * @param {string} action 給人看的描述，例如「新增自訂回應「欸」」
 * @param {{ source?: string, level?: 'info'|'warn' }} [opts]
 */
function record(action, { source = null, level = 'info' } = {}) {
  entries.push({ id: ++seq, ts: Date.now(), action, source, level });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  writer.schedule();
  logger[level === 'warn' ? 'warn' : 'info']('Admin', `📝 ${action}${source ? `（${source}）` : ''}`);
}

/**
 * 由新到舊列出
 * @param {{ before?: number, limit?: number }} [opts] before：只列出 id 比它小的（往前翻頁）
 */
function list({ before = Infinity, limit = 100 } = {}) {
  const out = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    if (entries[i].id < before) out.push(entries[i]);
  }
  return out;
}

module.exports = { record, list };
