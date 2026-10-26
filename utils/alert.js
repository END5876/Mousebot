// utils/alert.js
// 把「需要有人處理」的事件送到 Discord webhook（例如維運用的私人頻道）。
//
// 只用在少數真正需要人介入的狀況：AI 全體每日預算用完、管理面板登入被鎖定。
// 沒設定 ALERT_WEBHOOK_URL 時完全不做事（也不記 log），行為和沒有這個模組一樣。
//
// 同一個 key 在冷卻時間內只送一次（預設 1 小時），避免同一件事洗版；送不出去只記一行 warn，
// 絕不丟例外、不阻塞呼叫端。
//
// 環境變數：
//   ALERT_WEBHOOK_URL   Discord webhook 網址（頻道設定 → 整合 → Webhook）；未設定＝停用
//   ALERT_NAME          訊息開頭顯示的服務名稱（預設 mousebot）

const logger = require('./logger');

const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';
const NAME = process.env.ALERT_NAME || 'mousebot';
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
const SEND_TIMEOUT_MS = 5000;

const lastSent = new Map(); // key -> 上次送出的時間

function isEnabled() {
  return !!WEBHOOK_URL;
}

/**
 * @param {string} key 事件種類（冷卻以它為單位）
 * @param {string} text 給人看的說明
 * @param {{ cooldownMs?: number }} [opts]
 * @returns {Promise<boolean>} 是否真的送出
 */
async function alert(key, text, { cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  if (!WEBHOOK_URL) return false;
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < cooldownMs) return false;
  lastSent.set(key, now);
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // allowed_mentions 清空：訊息內容裡就算有 @everyone 也不會真的提及
      body: JSON.stringify({ content: `🚨 **${NAME}**：${text}`.slice(0, 1900), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (err) {
    logger.warn('Alert', `告警送出失敗（${key}）：${err.message}`);
    return false;
  }
}

module.exports = { alert, isEnabled, _reset: () => lastSent.clear() };
