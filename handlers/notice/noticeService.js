// handlers/notice/noticeService.js
// Steam / Epic 限免通知共用邏輯：
//   - 已通知清單 / 通知頻道清單的讀取、儲存
//   - HTTP GET（含 Retry）
//   - 定時檢查並推播的輪詢框架
// steamFreeHandler.js / epicFreeHandler.js 只需提供各自的
// getFreeGames() 與 buildMessage()，其餘由這裡統一處理。

const path = require('path');
const logger = require('../../utils/logger');
const { readJson, writeJsonAtomic } = require('../../utils/jsonStore');

const MAX_AGE_DAYS = 90;

// ── 資料存檔設定 ──────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// ════════════════════════════════════════════════════════
//  createNoticeService：建立單一平台（Steam / Epic）的
//  頻道管理 + 已通知清單服務
// ════════════════════════════════════════════════════════
function createNoticeService({ label, notifiedFileName, channelFileName }) {
  const NOTIFIED_FILE = path.join(DATA_DIR, notifiedFileName);
  const CONFIG_FILE   = path.join(DATA_DIR, channelFileName);

  const notifiedGames  = new Map(); // id → 通知時間
  const notifiedNames  = new Map(); // id → 遊戲名稱（管理面板顯示用；舊紀錄沒有名稱）
  let notifyChannelIds = [];

  // ── 讀取已通知清單 ──────────────────────────────────────
  // 格式：[[id, 時間, 名稱?], ...]；更舊的版本是單純的 id 陣列
  const parsedNotified = readJson(NOTIFIED_FILE, []);
  if (Array.isArray(parsedNotified)) {
    for (const entry of parsedNotified) {
      if (Array.isArray(entry)) {
        notifiedGames.set(entry[0], entry[1]);
        if (entry[2]) notifiedNames.set(entry[0], entry[2]);
      } else {
        notifiedGames.set(entry, Date.now());
      }
    }
  }
  logger.debug(label, `已載入 ${notifiedGames.size} 筆通知記錄`);

  // ── 讀取頻道設定 ────────────────────────────────────────
  const config = readJson(CONFIG_FILE, {}) || {};
  // 兼容舊版單頻道格式 { channelId: "..." }
  if (Array.isArray(config.channelIds)) {
    notifyChannelIds = config.channelIds;
  } else if (config.channelId) {
    notifyChannelIds = [config.channelId];
  }
  if (notifyChannelIds.length > 0)
    logger.debug(label, `已載入 ${notifyChannelIds.length} 個通知頻道`);

  function saveChannelConfig() {
    try {
      writeJsonAtomic(CONFIG_FILE, { channelIds: notifyChannelIds });
    } catch (e) {
      logger.error(label, `儲存頻道設定失敗: ${e.message}`);
    }
  }

  function saveNotifiedGames() {
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const [id, timestamp] of notifiedGames) {
      if (timestamp < cutoff) {
        notifiedGames.delete(id);
        notifiedNames.delete(id);
      }
    }
    const entries = [...notifiedGames].map(([id, ts]) => (notifiedNames.has(id) ? [id, ts, notifiedNames.get(id)] : [id, ts]));
    try {
      writeJsonAtomic(NOTIFIED_FILE, entries, { pretty: false });
    } catch (e) {
      logger.error(label, `儲存已通知清單失敗: ${e.message}`);
    }
  }

  // id 可能是數字（Steam / GamerPower）或字串（Epic）；從網址傳進來的一律是字串，比對時統一轉字串
  function findNotifiedKey(id) {
    for (const key of notifiedGames.keys()) if (String(key) === String(id)) return key;
    return undefined;
  }

  return {
    label,

    // ── 頻道管理 ──────────────────────────────────────────
    get channelIds() { return notifyChannelIds; },

    addChannel(channelId) {
      if (notifyChannelIds.includes(channelId)) return false;
      notifyChannelIds.push(channelId);
      saveChannelConfig();
      return true;
    },

    removeChannel(channelId) {
      const index = notifyChannelIds.indexOf(channelId);
      if (index === -1) return false;
      notifyChannelIds.splice(index, 1);
      saveChannelConfig();
      return true;
    },

    listChannels() {
      return [...notifyChannelIds];
    },

    // shouldRemove：只清掉符合條件的頻道（/notify channel clear 只能清自己伺服器的）；不給就全部清除
    clearChannels(shouldRemove = () => true) {
      const kept = notifyChannelIds.filter(id => !shouldRemove(id));
      const count = notifyChannelIds.length - kept.length;
      if (count === 0) return 0;
      notifyChannelIds = kept;
      saveChannelConfig();
      return count;
    },

    // ── 已通知清單 ────────────────────────────────────────
    hasNotified(id) { return notifiedGames.has(id); },
    markNotified(id, name) {
      notifiedGames.set(id, Date.now());
      if (name) notifiedNames.set(id, name);
    },
    persistNotified() { saveNotifiedGames(); },

    /** 已通知過的遊戲（新到舊），管理面板用 */
    listNotified() {
      return [...notifiedGames]
        .map(([id, ts]) => ({ id: String(id), notifiedAt: ts, name: notifiedNames.get(id) ?? null }))
        .sort((a, b) => b.notifiedAt - a.notifiedAt);
    },

    /** 忘記某筆通知紀錄：下次檢查時若仍是限免，會再推播一次 */
    forgetNotified(id) {
      const key = findNotifiedKey(id);
      if (key === undefined) return false;
      notifiedGames.delete(key);
      notifiedNames.delete(key);
      saveNotifiedGames();
      return true;
    },
  };
}

// ════════════════════════════════════════════════════════
//  fetchJson：HTTP GET 封裝（含 Retry），跨平台共用
// ════════════════════════════════════════════════════════
async function fetchJson(url, { retries = 3, delayMs = 3000, label = 'Notice' } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'MouseBot/1.0' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      logger.warn(label, `請求失敗，${delayMs / 1000}s 後重試，剩餘 ${retries - i - 1} 次`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ════════════════════════════════════════════════════════
//  createPollingLoop：定時檢查並推播的通用輪詢框架
// ════════════════════════════════════════════════════════
function createPollingLoop({ client, service, getFreeGames, buildMessage, idField, checkIntervalMs, logIntervalMs }) {
  let lastLogTime = 0;
  let running = null;

  // 定時輪詢與管理面板的「立即檢查」可能同時觸發：兩邊都在 markNotified 之前算出「新遊戲」，
  // 同一款就會被推播兩次。正在檢查時直接沿用同一次的結果。
  function checkAndNotify() {
    running ??= runCheck().finally(() => { running = null; });
    return running;
  }

  /**
   * @returns {Promise<{ skipped?: string, found?: number, newGames?: string[], channels?: number, failed?: number }>}
   */
  async function runCheck() {
    const channelIds = service.channelIds;
    if (channelIds.length === 0) return { skipped: '尚未設定通知頻道' };

    const now = Date.now();
    if (now - lastLogTime >= logIntervalMs) {
      lastLogTime = now;
      logger.debug(service.label, `定時檢查中... (${new Date().toLocaleString('zh-TW')})`);
    }

    const channels = (
      await Promise.all(
        channelIds.map(id =>
          client.channels.cache.get(id) || client.channels.fetch(id).catch(() => null)
        )
      )
    ).filter(Boolean);

    if (channels.length === 0) {
      logger.error(service.label, `所有設定的頻道均無法存取，跳過本次檢查`);
      return { skipped: '所有設定的頻道都無法存取' };
    }

    // 查詢失敗要回報成失敗，不能當成「沒有新遊戲」（provider 已經記過 log）
    let games;
    try {
      games = await getFreeGames();
    } catch (e) {
      return { skipped: `查詢失敗：${e.message}` };
    }
    const newGames = games.filter(game => !service.hasNotified(game[idField]));
    if (newGames.length === 0) return { found: games.length, newGames: [], channels: channels.length, failed: 0 };

    logger.info(service.label, `🎮 發現 ${newGames.length} 款新限免遊戲：${newGames.map(g => g.name).join('、')}`);

    let failed = 0;
    for (const game of newGames) {
      // 先組訊息：資料有缺導致組訊息丟錯時只跳過這一款，不能讓後面的遊戲也跟著沒推播
      let message;
      try {
        message = buildMessage(game);
      } catch (e) {
        failed += channels.length;
        logger.error(service.label, `組合通知訊息失敗（${game.name}）:`, e.message);
        continue;
      }

      const results = await Promise.allSettled(
        channels.map(ch => ch.send(message))
      );

      let sent = 0;
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') {
          sent++;
          logger.success(service.label, `已通知 #${channels[i].name}：${game.name}`);
        } else {
          failed++;
          logger.error(service.label, `發送至 #${channels[i].name} 失敗:`, result.reason?.message);
        }
      });
      // 至少送出一個頻道才算通知過；全部失敗的話下次檢查會再試
      if (sent > 0) service.markNotified(game[idField], game.name);
    }

    service.persistNotified();
    return { found: games.length, newGames: newGames.map(g => g.name), channels: channels.length, failed };
  }

  function start() {
    client.once('clientReady', () => {
      logger.debug(service.label, `Bot 啟動時間：${new Date().toLocaleString('zh-TW')}`);
      if (service.channelIds.length === 0) {
        logger.debug(service.label, '尚未設定通知頻道，請使用 /notify channel 新增。');
      } else {
        logger.debug(service.label, `限免通知已啟用（${service.channelIds.length} 個頻道，每 ${checkIntervalMs / 60000} 分鐘檢查）`);
      }
      checkAndNotify().catch(err => logger.error(service.label, `啟動時檢查失敗:`, err.message));
      setInterval(
        () => checkAndNotify().catch(err => logger.error(service.label, `定時任務發生錯誤:`, err.message)),
        checkIntervalMs
      );
    });
  }

  return { checkAndNotify, start };
}

module.exports = { createNoticeService, fetchJson, createPollingLoop };
