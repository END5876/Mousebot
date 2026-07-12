// handlers/notice/noticeService.js
// Steam / Epic 限免通知共用邏輯：
//   - 已通知清單 / 通知頻道清單的讀取、儲存
//   - HTTP GET（含 Retry）
//   - 定時檢查並推播的輪詢框架
// steamFreeHandler.js / epicFreeHandler.js 只需提供各自的
// getFreeGames() 與 buildMessage()，其餘由這裡統一處理。

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const MAX_AGE_DAYS = 90;

// ── 資料存檔設定 ──────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ════════════════════════════════════════════════════════
//  createNoticeService：建立單一平台（Steam / Epic）的
//  頻道管理 + 已通知清單服務
// ════════════════════════════════════════════════════════
function createNoticeService({ label, notifiedFileName, channelFileName }) {
  const NOTIFIED_FILE = path.join(DATA_DIR, notifiedFileName);
  const CONFIG_FILE   = path.join(DATA_DIR, channelFileName);

  let notifiedGames    = new Map();
  let notifyChannelIds = [];

  // ── 讀取已通知清單 ──────────────────────────────────────
  if (fs.existsSync(NOTIFIED_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(NOTIFIED_FILE, 'utf8'));
      if (Array.isArray(parsed) && Array.isArray(parsed[0])) {
        notifiedGames = new Map(parsed);
      } else if (Array.isArray(parsed)) {
        parsed.forEach(id => notifiedGames.set(id, Date.now()));
      }
      logger.debug(label, `已載入 ${notifiedGames.size} 筆通知記錄`);
    } catch (e) {
      logger.warn(label, `讀取已通知清單失敗: ${e.message}`);
    }
  }

  // ── 讀取頻道設定 ────────────────────────────────────────
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      // 兼容舊版單頻道格式 { channelId: "..." }
      if (Array.isArray(config.channelIds)) {
        notifyChannelIds = config.channelIds;
      } else if (config.channelId) {
        notifyChannelIds = [config.channelId];
      }
      if (notifyChannelIds.length > 0)
        logger.debug(label, `已載入 ${notifyChannelIds.length} 個通知頻道`);
    } catch (e) {
      logger.warn(label, `讀取頻道設定失敗: ${e.message}`);
    }
  }

  function saveChannelConfig() {
    fs.writeFile(CONFIG_FILE, JSON.stringify({ channelIds: notifyChannelIds }, null, 2), (e) => {
      if (e) console.error(`⚠️ [${label}] 儲存頻道設定失敗:`, e.message);
    });
  }

  function saveNotifiedGames() {
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    for (const [id, timestamp] of notifiedGames) {
      if (timestamp < cutoff) notifiedGames.delete(id);
    }
    fs.writeFile(NOTIFIED_FILE, JSON.stringify([...notifiedGames]), (e) => {
      if (e) console.error(`⚠️ [${label}] 儲存已通知清單失敗:`, e.message);
    });
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

    clearChannels() {
      const count = notifyChannelIds.length;
      notifyChannelIds = [];
      saveChannelConfig();
      return count;
    },

    // ── 已通知清單 ────────────────────────────────────────
    hasNotified(id) { return notifiedGames.has(id); },
    markNotified(id) { notifiedGames.set(id, Date.now()); },
    persistNotified() { saveNotifiedGames(); },
  };
}

// ════════════════════════════════════════════════════════
//  fetchJson：HTTP GET 封裝（含 Retry），跨平台共用
// ════════════════════════════════════════════════════════
async function fetchJson(url, { retries = 3, delayMs = 3000, label = 'Notice' } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'MouseBot/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      console.warn(`⚠️ [${label}] 請求失敗，${delayMs / 1000}s 後重試，剩餘 ${retries - i - 1} 次`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ════════════════════════════════════════════════════════
//  createPollingLoop：定時檢查並推播的通用輪詢框架
// ════════════════════════════════════════════════════════
function createPollingLoop({ client, service, getFreeGames, buildMessage, idField, checkIntervalMs, logIntervalMs }) {
  let lastLogTime = 0;

  async function checkAndNotify() {
    const channelIds = service.channelIds;
    if (channelIds.length === 0) return;

    const now = Date.now();
    if (now - lastLogTime >= logIntervalMs) {
      lastLogTime = now;
      console.log(`[${service.label}] 定時檢查中... (${new Date().toLocaleString('zh-TW')})`);
    }

    const channels = (
      await Promise.all(
        channelIds.map(id =>
          client.channels.cache.get(id) || client.channels.fetch(id).catch(() => null)
        )
      )
    ).filter(Boolean);

    if (channels.length === 0)
      return console.error(`⚠️ [${service.label}] 所有設定的頻道均無法存取，跳過本次檢查`);

    const games = await getFreeGames();
    const newGames = games.filter(game => !service.hasNotified(game[idField]));
    if (newGames.length === 0) return;

    console.log(`[${service.label}] 🎮 發現 ${newGames.length} 款新限免遊戲：${newGames.map(g => g.name).join('、')}`);

    for (const game of newGames) {
      service.markNotified(game[idField]);

      const results = await Promise.allSettled(
        channels.map(ch => ch.send(buildMessage(game)))
      );

      results.forEach((result, i) => {
        if (result.status === 'fulfilled') {
          console.log(`[${service.label}] ✅ 已通知 #${channels[i].name}：${game.name}`);
        } else {
          console.error(`⚠️ [${service.label}] 發送至 #${channels[i].name} 失敗:`, result.reason?.message);
        }
      });
    }

    service.persistNotified();
  }

  function start() {
    client.once('clientReady', () => {
      logger.debug(service.label, `Bot 啟動時間：${new Date().toLocaleString('zh-TW')}`);
      if (service.channelIds.length === 0) {
        logger.debug(service.label, '尚未設定通知頻道，請使用 /notify channel 新增。');
      } else {
        logger.debug(service.label, `限免通知已啟用（${service.channelIds.length} 個頻道，每 ${checkIntervalMs / 60000} 分鐘檢查）`);
      }
      checkAndNotify().catch(err => console.error(`⚠️ [${service.label}] 啟動時檢查失敗:`, err.message));
      setInterval(
        () => checkAndNotify().catch(err => console.error(`⚠️ [${service.label}] 定時任務發生錯誤:`, err.message)),
        checkIntervalMs
      );
    });
  }

  return { checkAndNotify, start };
}

module.exports = { createNoticeService, fetchJson, createPollingLoop };
