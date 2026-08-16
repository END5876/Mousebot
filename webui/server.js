'use strict';
/**
 * Splitbill Web UI 橋接伺服器
 * -----------------------------------------------------------------
 * 用途：讓 splitbill.html 前端可以直接讀寫 Bot 正在使用的 data/splitbill.json，
 * 而不用手動複製貼上 JSON。
 *
 * 重要：這個檔案要「跟 Bot 主程式在同一個 Node process 裡啟動」，
 * 也就是在你的 index.js（或 bot 進入點）裡 require 並呼叫 startWebApi()，
 * 而不是另外用 `node webui/server.js` 開一個獨立的 process。
 * 原因：handlers/splitbill/utils/storage.js 內部用一個模組層級的
 * in-memory cache 快取整份資料，只有「同一個 process、同一份被 require
 * 的模組實例」才會共用這個 cache。分開跑兩個 process 會導致 Bot 的即時
 * 操作跟網頁看到的資料互相看不到對方最新的變更（甚至互相覆蓋）。
 *
 * 使用方式（在你的 bot 主程式，例如 index.js 裡）：
 *
 *   const { startWebApi } = require('./webui/server');
 *   client.once('ready', () => {
 *     startWebApi({ port: process.env.SPLITBILL_WEB_PORT || 3000 });
 *   });
 *
 * 需要先安裝 express： npm install express
 *
 * 環境變數：
 *   SPLITBILL_API_KEY   （建議設定）保護 API 的簡單金鑰，前端要填相同的值
 *   SPLITBILL_WEB_PORT  監聽的埠號，預設 3000
 */

const path = require('path');
const express = require('express');

// ⚠️ 依你實際的專案結構調整這行路徑（本檔預期放在 repo 根目錄的 webui/ 資料夾）
const storage = require('../handlers/splitbill/utils/storage');

function startWebApi(options = {}) {
  const port = options.port || process.env.SPLITBILL_WEB_PORT || 3000;
  const apiKey = options.apiKey || process.env.SPLITBILL_API_KEY || '';

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // 提供前端靜態頁面（public/index.html），同源存取可避免 CORS 問題
  app.use(express.static(path.join(__dirname, 'public')));

  // ---- 簡單金鑰驗證（僅保護 /api/* 路由） ----
  app.use('/api', (req, res, next) => {
    if (!apiKey) return next(); // 沒設定金鑰就不驗證（僅建議在受信任的內網／VPN 環境這樣用）
    const provided = req.get('x-api-key');
    if (provided !== apiKey) {
      return res.status(401).json({ error: '缺少或錯誤的 API Key' });
    }
    next();
  });

  // ---- GET /api/guilds：列出所有伺服器與底下的行程（給前端下拉選單用） ----
  app.get('/api/guilds', (req, res) => {
    try {
      const all = storage.loadAll();
      const result = Object.entries(all).map(([guildId, guild]) => ({
        guildId,
        defaultTripId: guild.defaultTripId || null,
        trips: Object.values(guild.trips || {}).map(t => ({
          id: t.id,
          name: t.name,
          archived: !!t.archived,
        })),
      }));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- GET /api/trip/:guildId/:tripId：取得單一行程完整資料 ----
  app.get('/api/trip/:guildId/:tripId', (req, res) => {
    try {
      const guild = storage.getGuild(req.params.guildId);
      const trip = guild.trips[req.params.tripId];
      if (!trip) return res.status(404).json({ error: '找不到這個行程' });
      res.json(trip);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- PUT /api/trip/:guildId/:tripId：覆蓋寫入單一行程 ----
  app.put('/api/trip/:guildId/:tripId', (req, res) => {
    try {
      const guild = storage.getGuild(req.params.guildId);
      const incoming = req.body || {};
      const repaired = storage.repairTrip({ ...incoming, id: req.params.tripId });
      guild.trips[req.params.tripId] = repaired;
      storage.persist();
      res.json(repaired);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(port, () => {
    console.log(`[splitbill-web] 網頁記帳介面已啟動： http://0.0.0.0:${port}`);
    if (!apiKey) {
      console.warn('[splitbill-web] ⚠️ 尚未設定 SPLITBILL_API_KEY，任何能連到這個埠的人都能讀寫帳本資料，建議至少設定一組金鑰或只在內網／VPN 開放。');
    }
  });
}

module.exports = { startWebApi };
