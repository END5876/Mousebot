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
 *   GEMINI_API_KEY      帳單照片辨識功能需要。這個專案的 /ai 指令
 *                       （handlers/ai/aiCore.js）已經在用同一把金鑰，
 *                       不用額外申請。沒設定的話帳單辨識功能會回傳清楚的
 *                       錯誤訊息，但不影響其他功能。
 */

const path = require('path');
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ⚠️ 依你實際的專案結構調整這行路徑（本檔預期放在 repo 根目錄的 webui/ 資料夾）
const storage = require('../handlers/splitbill/utils/storage');

// 跟專案既有 handlers/ai/aiCore.js 用同一顆模型，沿用已驗證可用的設定
const RECEIPT_MODEL_NAME = 'gemini-3.1-flash-lite';
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

const RECEIPT_PROMPT = `你是一個帳單／收據辨識助手。請仔細閱讀這張照片，只回傳一個 JSON 物件，不要有任何其他文字、不要用 markdown code block 包起來、不要加註解。

物件格式：
{
  "currency": "ISO 4217 三碼幣別代碼（例如 TWD、JPY、USD、KRW），看不出來就填 null",
  "serviceChargeRate": 數字（例如 0.1 代表 10% 服務費；完全沒有服務費就填 0）,
  "items": [
    {"name": "品項名稱", "price": 數字, "type": "item" 或 "fee"}
  ]
}

規則：
- "type":"item" 用於一般餐點／商品品項；price 是「加服務費前」的原始單價，不要自己在這裡加成
- "type":"fee" 用於訂金／訂位金、外送費、清潔費、開瓶費等跟服務費無關的固定雜費；折扣或優惠請用 "fee" 且 price 填負數
- 【重要】如果帳單上有服務費（不管是寫成百分比，或是直接列一筆服務費金額），絕對不要把它放進 items 陣列當成獨立項目；改成換算成比例填進最上層的 serviceChargeRate。如果看得到明確百分比（例如「服務費10%」「一成服務費」「Service Charge 10%」）就直接用該比例；如果只看到服務費的金額、沒寫百分比，用「服務費金額 ÷ 所有餐點品項小計」概算出比例
- price 一律是純數字，不要有貨幣符號、千分位逗號、百分比符號
- 如果同一品項的價格已經是含數量的小計（例如「奶茶 x2　$100」代表兩杯共 100 元），就填一行 100，不要拆成兩行
- 只回傳看得清楚的品項，看不清楚或無法判斷金額的部分不要瞎猜、不要編造
- 小計（subtotal）、總計（total）這種彙總列本身不算獨立品項，不要放進 items 裡（服務費要換算成 serviceChargeRate，不算在這條規則內）
- 如果整張圖片看起來不像帳單/收據，items 填空陣列 []`;

// 從模型回應中取出 JSON 物件文字，容忍模型偶爾還是包了 ```json 圍欄或前後贅字的情況
function extractJsonObject(text){
  if (!text) throw new Error('模型沒有回傳任何內容');
  let cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('回應內容裡找不到 JSON 物件');
  cleaned = cleaned.slice(start, end + 1);
  const parsed = JSON.parse(cleaned);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('解析結果不是物件');
  return parsed;
}

// 驗證並清理辨識結果，過濾掉格式不對的資料，避免壞資料流到前端
function sanitizeReceiptResponse(raw){
  const serviceChargeRate = (raw && typeof raw.serviceChargeRate === 'number'
    && Number.isFinite(raw.serviceChargeRate) && raw.serviceChargeRate >= 0 && raw.serviceChargeRate < 2)
    ? Math.round(raw.serviceChargeRate * 10000) / 10000
    : 0;
  const currency = (raw && typeof raw.currency === 'string' && /^[A-Za-z]{3}$/.test(raw.currency.trim()))
    ? raw.currency.trim().toUpperCase()
    : null;
  const rawItems = Array.isArray(raw && raw.items) ? raw.items : [];
  const items = rawItems
    .filter(it => it && typeof it.name === 'string' && typeof it.price === 'number' && Number.isFinite(it.price))
    .map(it => ({
      name: it.name.trim().slice(0, 120) || '未命名品項',
      price: Math.round(it.price * 100) / 100,
      type: it.type === 'fee' ? 'fee' : 'item',
    }));
  return { currency, serviceChargeRate, items };
}

function startWebApi(options = {}) {
  const port = options.port || process.env.PORT || process.env.SPLITBILL_WEB_PORT || 3000;
  const apiKey = options.apiKey || process.env.SPLITBILL_API_KEY || '';

  const app = express();
  app.use(express.json({ limit: '12mb' })); // 帳單照片辨識會傳一張壓縮過的 base64 圖片，2mb 太小

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

  // ---- POST /api/parse-receipt：上傳帳單照片，用 Gemini 的視覺能力辨識出品項、金額、
  // 服務費比例、幣別。跟專案既有 /ai 指令共用同一把 GEMINI_API_KEY。 ----
  // body: { image: '<純 base64，不含 data: 前綴>', mediaType: 'image/jpeg' }
  app.post('/api/parse-receipt', async (req, res) => {
    if (!genAI) {
      return res.status(500).json({ error: '伺服器尚未設定 GEMINI_API_KEY，無法使用帳單辨識功能' });
    }
    const { image, mediaType } = req.body || {};
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: '缺少圖片資料' });
    }
    try {
      const model = genAI.getGenerativeModel({
        model: RECEIPT_MODEL_NAME,
        generationConfig: {
          temperature: 0.1, // 辨識任務要穩定、不要有創意發揮
          responseMimeType: 'application/json',
        },
      });
      const result = await model.generateContent([
        { inlineData: { mimeType: mediaType || 'image/jpeg', data: image } },
        { text: RECEIPT_PROMPT },
      ]);
      const text = result.response.text();
      const parsed = extractJsonObject(text);
      const sanitized = sanitizeReceiptResponse(parsed);
      res.json(sanitized);
    } catch (err) {
      res.status(500).json({ error: '帳單辨識失敗：' + err.message });
    }
  });

  app.listen(port, () => {
    console.log(`[splitbill-web] 網頁記帳介面已啟動： http://0.0.0.0:${port}`);
    if (!apiKey) {
      console.warn('[splitbill-web] ⚠️ 尚未設定 SPLITBILL_API_KEY，任何能連到這個埠的人都能讀寫帳本資料，建議至少設定一組金鑰或只在內網／VPN 開放。');
    }
  });
}

module.exports = { startWebApi, extractJsonObject, sanitizeReceiptResponse };
