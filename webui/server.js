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
 *     startWebApi({ port: process.env.PORT || process.env.SPLITBILL_WEB_PORT || 3000 });
 *   });
 *
 * 需要先安裝 express： npm install express
 *
 * 環境變數：
 *   SPLITBILL_API_KEY   （建議設定）保護 API 的簡單金鑰，前端要填相同的值
 *   PORT                部分 PaaS（如 Zeabur）會自動注入這個變數指定監聽埠，
 *                       優先權高於 SPLITBILL_WEB_PORT
 *   SPLITBILL_WEB_PORT  監聽的埠號，沒有 PORT 時使用，預設 3000
 *   GEMINI_API_KEY      帳單照片辨識功能需要，見 lib/receiptScan.js
 *
 * ── 本檔案已拆分成多個子模組，方便維護（對外行為與拆分前完全相同）──
 *   lib/fxRates.js        即時匯率查詢與快取
 *   lib/sse.js             SSE 訂閱表、換票機制、廣播
 *   lib/receiptScan.js     帳單照片辨識（Gemini）
 *   lib/auth.js            API Key 中介層 / 分享連結權限判斷
 *   routes/trips.js        伺服器清單、行程本體讀寫
 *   routes/shareLinks.js   分享連結管理（擁有者專用）
 *   routes/sharedTrip.js   分享連結訪客的讀寫端點
 *   routes/sse.js           SSE 換票與事件串流端點
 *   routes/utility.js       即時匯率／帳單辨識端點
 * 這個檔案本身只負責：建立 app、掛中介層、組裝 ctx、把各個 router 掛上去、
 * 監聽埠號。
 */

const path = require('path');
const express = require('express');

// ⚠️ 依你實際的專案結構調整這行路徑（本檔預期放在 repo 根目錄的 webui/ 資料夾）
const storage = require('../handlers/splitbill/utils/storage');

const { getFxRatesFor } = require('./lib/fxRates');
const { genAI, extractJsonObject, sanitizeReceiptResponse, recognizeReceipt } = require('./lib/receiptScan');
const { createApiKeyMiddleware, createAuthHelpers } = require('./lib/auth');
const { createSseHub, attachTripEventBroadcast } = require('./lib/sse');

const createTripsRouter = require('./routes/trips');
const createShareLinksRouter = require('./routes/shareLinks');
const createSharedTripRouter = require('./routes/sharedTrip');
const createSseRouter = require('./routes/sse');
const createUtilityRouter = require('./routes/utility');

function startWebApi(options = {}) {
  const port = options.port || process.env.PORT || process.env.SPLITBILL_WEB_PORT || 3000;
  const apiKey = options.apiKey || process.env.SPLITBILL_API_KEY || '';

  const app = express();
  app.use(express.json({ limit: '12mb' })); // 帳單照片辨識會傳一張壓縮過的 base64 圖片，2mb 太小

  // 提供前端靜態頁面（public/index.html），同源存取可避免 CORS 問題
  app.use(express.static(path.join(__dirname, 'public')));

  // ---- 金鑰驗證（僅保護 /api/* 路由，細節見 lib/auth.js） ----
  app.use('/api', createApiKeyMiddleware(apiKey));

  // ---- 🆕 [即時同步] 掛上 SSE 廣播：任何一條寫入路徑呼叫 storage.touchTrip()
  // 時，都會自動推播給該行程目前所有開著的 SSE 連線（見 lib/sse.js）。
  const sseHub = createSseHub();
  attachTripEventBroadcast(storage, sseHub);

  // ---- 組裝共用的 ctx，各個 router 依需要挑選使用 ----
  const auth = createAuthHelpers({ storage, apiKey });
  const ctx = {
    storage,
    apiKey,
    ...auth,       // authorizeTripAccess, requireOwner, hasShareableCredential
    ...sseHub,      // sseTickets, pruneSseTickets, SSE_TICKET_TTL_MS, openTripSseStream, ...
    getFxRatesFor,
    genAI,
    recognizeReceipt,
  };

  app.use('/api', createSseRouter(ctx));
  app.use('/api', createTripsRouter(ctx));
  app.use('/api', createShareLinksRouter(ctx));
  app.use('/api', createSharedTripRouter(ctx));
  app.use('/api', createUtilityRouter(ctx));

  app.listen(port, () => {
    console.log(`[splitbill-web] 網頁記帳介面已啟動： http://0.0.0.0:${port}`);
    if (!apiKey) {
      console.warn('[splitbill-web] ⚠️ 尚未設定 SPLITBILL_API_KEY，任何能連到這個埠的人都能讀寫帳本資料，建議至少設定一組金鑰或只在內網／VPN 開放。');
    }
  });
}

// 保留原本的對外匯出介面：startWebApi 以外，extractJsonObject / sanitizeReceiptResponse /
// getFxRatesFor 過去可能被其他檔案（例如測試）直接 require 使用，拆分後繼續原樣匯出。
module.exports = { startWebApi, extractJsonObject, sanitizeReceiptResponse, getFxRatesFor };
