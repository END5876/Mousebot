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
 *
 * 即時匯率：非基準幣別的支出／轉帳，會先呼叫 /api/fx-rate 取得當下即時
 * 匯率換算 amountInBase（amount 仍然存原始幣值），不需要另外申請金鑰
 * ——用的是免費、不用金鑰的 open.er-api.com。伺服器端有做快取（同一個
 * 來源幣別 6 小時內重複查詢不會再打外部 API），即時匯率抓不到時會自動
 * 退回使用行程裡手動設定的匯率，不會擋住記帳。
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ⚠️ 依你實際的專案結構調整這行路徑（本檔預期放在 repo 根目錄的 webui/ 資料夾）
const storage = require('../handlers/splitbill/utils/storage');

// 跟專案既有 handlers/ai/aiCore.js 用同一顆模型，沿用已驗證可用的設定
const RECEIPT_MODEL_NAME = 'gemini-3.1-flash-lite';
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// ---- 即時匯率：免費、不用金鑰的 open.er-api.com，伺服器端記憶體快取 ----
const FX_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 小時；這個 API 本身也是一天更新一次，不用查太頻繁
const fxCache = new Map(); // baseCurrency -> { rates, fetchedAt, asOf }

async function getFxRatesFor(base){
  const cached = fxCache.get(base);
  if (cached && (Date.now() - cached.fetchedAt) < FX_CACHE_TTL_MS) return cached;
  const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.result !== 'success') {
    throw new Error((data && data['error-type']) || `匯率服務回應異常 (HTTP ${res.status})`);
  }
  const entry = { rates: data.rates, fetchedAt: Date.now(), asOf: data.time_last_update_utc || null };
  fxCache.set(base, entry);
  return entry;
}

// ════════════════════════════════════════════════════════════════
// 🆕 [即時同步] SSE（Server-Sent Events）：讓多個同時開著這個行程的分頁
// （包含 webui 彼此之間、以及 webui 與 Discord 面板之間）在資料被任一方
// 改動時互相即時同步，不用手動重新整理才會看到別人剛存的東西。
//
// 設計重點：
// - 廣播來源統一掛在 storage.tripEvents（見 storage.js 的 touchTrip()），
//   涵蓋所有寫入路徑，不用在每個 API 端點各自補播送邏輯。
// - 瀏覽器原生 EventSource 不支援自訂 header，因此無法沿用其餘 /api/*
//   路由靠 x-api-key header 驗證的方式。擁有者連線改用「短效、一次性
//   票券」：先用一般帶 header 的請求換票（POST /api/sse-ticket），
//   再用票券建立 SSE 連線，避免把長效的 SPLITBILL_API_KEY 直接放進
//   連線網址、留在伺服器存取紀錄裡。
// - 分享連結（/api/shared-trip/:token/events）沿用既有設計：token 本身
//   就是寫在路徑上的憑證（跟同檔案其他 /api/shared-trip/:token 端點一致），
//   不需要額外換票。
// ════════════════════════════════════════════════════════════════
const sseTickets = new Map(); // ticket -> { isOwner, providedKey, expiresAt }
const SSE_TICKET_TTL_MS = 30 * 1000; // 換票後 30 秒內沒拿去開 SSE 連線就作廢

function pruneSseTickets() {
  const now = Date.now();
  for (const [ticket, entry] of sseTickets) {
    if (entry.expiresAt < now) sseTickets.delete(ticket);
  }
}

// tripId -> Set<express.Response>，每個 res 都是一條保持開啟中的 SSE 連線
const tripSubscribers = new Map();

function addTripSubscriber(tripId, res) {
  if (!tripSubscribers.has(tripId)) tripSubscribers.set(tripId, new Set());
  tripSubscribers.get(tripId).add(res);
}
function removeTripSubscriber(tripId, res) {
  const set = tripSubscribers.get(tripId);
  if (!set) return;
  set.delete(res);
  if (!set.size) tripSubscribers.delete(tripId);
}

/**
 * 開啟一條 SSE 串流並掛進訂閱表。連線本身不主動關閉，靠使用者關閉分頁／
 * 網路中斷觸發 res 的 'close' 事件時清理；期間定期送出註解行當心跳，
 * 避免部分反向代理或 PaaS 因為連線閒置太久而主動斷開。
 */
function openTripSseStream(res, tripId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 避免 nginx 等反向代理把 SSE 資料流緩衝住不即時送出
  });
  res.write('event: connected\ndata: {}\n\n');

  addTripSubscriber(tripId, res);

  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);
  if (typeof keepAlive.unref === 'function') keepAlive.unref();

  res.on('close', () => {
    clearInterval(keepAlive);
    removeTripSubscriber(tripId, res);
  });
}

// 訂閱 storage 層的變更事件：不管是 webui 存檔，還是 Discord 面板操作，
// 只要呼叫過 storage.touchTrip()，這裡就會收到通知並廣播給該行程目前
// 所有開著的 SSE 連線。
storage.tripEvents.on('trip-updated', (tripId) => {
  const subscribers = tripSubscribers.get(tripId);
  if (!subscribers || !subscribers.size) return; // 沒有人在看這個行程，省下組資料的成本

  const found = storage.findTripById(tripId);
  if (!found) return; // 理論上不會發生（剛觸發過 touchTrip 代表行程存在），防呆用

  const payload = `event: trip-updated\ndata: ${JSON.stringify(found.trip)}\n\n`;
  for (const res of subscribers) {
    res.write(payload);
  }
});

// 🆕 [即時同步] 行程被刪除時（見 tripUI.js 的 trip_btn_delete_confirm）：
// 通知所有訂閱者一聲，然後直接把連線關掉——這個行程已經不存在了，之後
// 也不會再有任何 'trip-updated' 事件可以推播，繼續留著連線沒有意義，
// 不如讓伺服器跟前端都能立刻釋放資源。
storage.tripEvents.on('trip-deleted', (tripId) => {
  const subscribers = tripSubscribers.get(tripId);
  if (!subscribers || !subscribers.size) return;

  const payload = 'event: trip-deleted\ndata: {}\n\n';
  for (const res of subscribers) {
    res.write(payload);
    res.end();
  }
  tripSubscribers.delete(tripId);
});

const RECEIPT_PROMPT = `你是一個帳單／收據辨識助手。請仔細閱讀這張照片，只回傳一個 JSON 物件，不要有任何其他文字、不要用 markdown code block 包起來、不要加註解。

物件格式：
{
  "currency": "ISO 4217 三碼幣別代碼（例如 TWD、JPY、USD、KRW），看不出來就填 null",
  "language": "帳單上主要文字使用的語言，用簡短中文描述（例如：日文、韓文、泰文、英文、繁體中文、簡體中文），無法判斷則填「未知」",
  "serviceChargeRate": 數字（例如 0.1 代表 10% 服務費；完全沒有服務費就填 0）,
  "items": [
    {"name": "品項名稱（帳單原文語言）", "nameTranslated": "此品項名稱的繁體中文翻譯", "price": 數字, "type": "item" 或 "fee"}
  ]
}

規則：
- "type":"item" 用於一般餐點／商品品項；price 是「加服務費前」的原始單價，不要自己在這裡加成
- "type":"fee" 用於訂金／訂位金、外送費、清潔費、開瓶費等跟服務費無關的固定雜費；折扣或優惠請用 "fee" 且 price 填負數
- "name" 一律用帳單「原文」語言填寫，不要自己先翻譯；"nameTranslated" 才是翻譯欄位——把 name 翻譯成繁體中文。如果 name 本身已經是中文（繁體或簡體皆可），"nameTranslated" 請填空字串 ""，不要重複輸出原文
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

// 🆕 語言辨識 + 翻譯的保險機制：跟 billScanner.js（Discord 面板）用同一套邏輯——
// 只要 AI 判斷的語言標籤裡含有「中文」或 "chinese"，一律視為不需要翻譯，
// 避免簡體/繁體中文被誤判成需要轉換，跟原文重複顯示。
function isChineseLanguageLabel(lang){
  return /中文|chinese/i.test(lang || '');
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
  // 🆕 語言辨識：純粹給前端顯示用的提示文字（例如「偵測到日文，已附上翻譯」），
  // 不影響任何計算邏輯，因此只做基本的型別/長度防呆。
  const language = (raw && typeof raw.language === 'string') ? raw.language.trim().slice(0, 20) : '';
  const isChinese = isChineseLanguageLabel(language);
  const rawItems = Array.isArray(raw && raw.items) ? raw.items : [];
  const items = rawItems
    .filter(it => it && typeof it.name === 'string' && typeof it.price === 'number' && Number.isFinite(it.price))
    .map(it => ({
      name: it.name.trim().slice(0, 120) || '未命名品項',
      // 🆕 nameTranslated：品項名稱的繁體中文翻譯。原文已是中文（含簡體），或模型沒給
      // 翻譯時，一律留空字串，前端只在有值時才顯示「🌐 翻譯：...」提示行。
      nameTranslated: (!isChinese && typeof it.nameTranslated === 'string') ? it.nameTranslated.trim().slice(0, 120) : '',
      price: Math.round(it.price * 100) / 100,
      type: it.type === 'fee' ? 'fee' : 'item',
    }));
  return { currency, serviceChargeRate, items, language };
}

function startWebApi(options = {}) {
  const port = options.port || process.env.PORT || process.env.SPLITBILL_WEB_PORT || 3000;
  const apiKey = options.apiKey || process.env.SPLITBILL_API_KEY || '';

  const app = express();
  app.use(express.json({ limit: '12mb' })); // 帳單照片辨識會傳一張壓縮過的 base64 圖片，2mb 太小

  // 提供前端靜態頁面（public/index.html），同源存取可避免 CORS 問題
  app.use(express.static(path.join(__dirname, 'public')));

  // ---- 金鑰驗證（僅保護 /api/* 路由） ----
  // 🆕 [分享連結] 原本只認一把全域 SPLITBILL_API_KEY，符合就放行、不符合就整個
  // 401 擋掉。現在除了擁有者金鑰，也要接受「分享連結」的 token 當憑證——但
  // 分享 token 只認得「它被建立時綁定的那一個行程」，不能拿去存取別的行程或
  // /api/guilds 這種會列出全部行程名稱的端點，因此不能在這裡（還不知道請求
  // 要存取哪個行程）就直接判斷通過或拒絕，只能先把「這把金鑰是不是擁有者
  // 本人」記在 req.isOwner，實際的存取範圍留給各自的路由處理常式判斷。
  //
  // 例外：/api/shared-trip/:token 系列端點本身就是「token 寫在路徑裡」當
  // 憑證使用（分享連結的接收者完全不需要知道、也不需要填寫任何 API Key），
  // 因此這裡直接放行、把驗證完全交給該端點自己依路徑上的 token 判斷。
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/shared-trip/')) return next();
    // 🆕 [即時同步] SSE 端點無法使用 x-api-key header（瀏覽器原生 EventSource
    // 不支援自訂 header），驗證改在路由本身用一次性票券（見下方 sse-ticket
    // 相關端點）處理，這裡直接放行，不吃這裡的 header 檢查。
    if (req.path.endsWith('/events')) return next();
    if (!apiKey) return next(); // 沒設定金鑰就不驗證（僅建議在受信任的內網／VPN 環境這樣用）
    const provided = req.get('x-api-key');
    if (!provided) {
      return res.status(401).json({ error: '缺少或錯誤的 API Key' });
    }
    req.providedKey = provided;
    req.isOwner = (provided === apiKey);
    next();
  });

  /**
   * 🆕 [分享連結] 檢查這次請求是否有權限存取指定的行程。
   * 擁有者金鑰永遠全權放行；否則檢查提供的金鑰是不是這個行程自己名下、
   * 尚未過期的分享連結 token，並依 needWrite 決定該連結的權限（read/write）
   * 是否足夠。回傳 true 時呼叫端才可以繼續往下處理；回傳 false 時已經
   * 直接寫好錯誤回應，呼叫端應立即 return。
   */
  function authorizeTripAccess(req, res, trip, needWrite) {
    if (req.isOwner) return true;
    const link = (trip.shareLinks || []).find((l) => l.token === req.providedKey);
    if (!link) {
      res.status(403).json({ error: '沒有權限存取此行程' });
      return false;
    }
    if (storage.isShareLinkExpired(link)) {
      res.status(403).json({ error: '此分享連結已過期或已被撤銷，請跟建立連結的人索取新的連結' });
      return false;
    }
    if (needWrite && link.permission !== 'write') {
      res.status(403).json({ error: '此分享連結為唯讀，無法儲存變更' });
      return false;
    }
    return true;
  }

  // ════════════════════════════════════════════════════════════════
  // 🆕 [即時同步] POST /api/sse-ticket：擁有者專用，用一般的 header 驗證
  // （沿用上面 app.use('/api', ...) 的 x-api-key 檢查）換取一張短效、
  // 一次性的票券，再拿這張票券去開啟下面的 SSE 連線。分享連結不需要
  // 呼叫這個端點——它的 SSE 連線直接用網址上的 token 當憑證即可。
  // ════════════════════════════════════════════════════════════════
  app.post('/api/sse-ticket', (req, res) => {
    pruneSseTickets();
    const ticket = crypto.randomBytes(24).toString('hex');
    sseTickets.set(ticket, {
      isOwner: apiKey ? !!req.isOwner : true, // 沒設定金鑰時，整台伺服器沒有身份區分，視為擁有者
      providedKey: req.providedKey || null,
      expiresAt: Date.now() + SSE_TICKET_TTL_MS,
    });
    res.json({ ticket, expiresInMs: SSE_TICKET_TTL_MS });
  });

  // ---- GET /api/trip/:guildId/:tripId/events：SSE，這個行程被任何人改動時即時推播 ----
  app.get('/api/trip/:guildId/:tripId/events', (req, res) => {
    const guild = storage.getGuild(req.params.guildId);
    const trip = guild.trips[req.params.tripId];
    if (!trip) return res.status(404).json({ error: '找不到這個行程' });

    let authCtx = { isOwner: true, providedKey: null };
    if (apiKey) {
      pruneSseTickets();
      const ticketId = req.query.ticket;
      const ticket = ticketId && sseTickets.get(ticketId);
      if (!ticket || ticket.expiresAt < Date.now()) {
        return res.status(401).json({ error: '缺少或已過期的連線憑證，請重新整理頁面再試一次。' });
      }
      sseTickets.delete(ticketId); // 單次使用，用過即棄
      authCtx = ticket;
    }

    if (!authorizeTripAccess(authCtx, res, trip, false)) return;

    openTripSseStream(res, trip.id);
  });

  // ---- GET /api/shared-trip/:token/events：SSE，分享連結版本 ----
  app.get('/api/shared-trip/:token/events', (req, res) => {
    const found = storage.findTripByShareToken(req.params.token);
    if (!found) return res.status(404).json({ error: '這個分享連結不存在，可能已經被撤銷或網址有誤' });
    if (storage.isShareLinkExpired(found.shareLink)) {
      return res.status(403).json({ error: '這個分享連結已經過期，請跟建立連結的人索取新的連結' });
    }
    openTripSseStream(res, found.trip.id);
  });

  // ---- GET /api/guilds：列出所有伺服器與底下的行程（給前端下拉選單用） ----
  // 🆕 [分享連結] 這裡會列出「全部」伺服器與行程名稱，分享連結的持有者絕對
  // 不該看到這份清單（會曝光其他跟他無關的行程），因此強制只有擁有者本人
  // （真正的 SPLITBILL_API_KEY）能呼叫，分享 token 一律拒絕。
  app.get('/api/guilds', (req, res) => {
    if (apiKey && !req.isOwner) {
      return res.status(403).json({ error: '此操作僅限擁有者本人執行' });
    }
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
      if (!authorizeTripAccess(req, res, trip, false)) return;
      res.json(trip);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- PUT /api/trip/:guildId/:tripId：覆蓋寫入單一行程 ----
  app.put('/api/trip/:guildId/:tripId', (req, res) => {
    try {
      const guild = storage.getGuild(req.params.guildId);
      const existing = guild.trips[req.params.tripId];
      // 🆕 [分享連結] 寫入前一定要先確認權限；同時，若這個行程已經有人建立過
      // 分享連結，前端送來的完整覆蓋內容裡通常也會原封不動帶著 shareLinks
      // 陣列（因為前端載入/編輯/存回都是整包 trip 物件），這裡不用特別處理，
      // repairTrip() 會自動把它防呆修復好；但如果請求本身是「用分享連結」
      // 寫入的，就不检查它帶來的 shareLinks 內容是否被竄改——見下方安全性
      // 備註：分享連結持有者理論上不該能新增/竄改分享連結清單本身。
      // 🔒 [修正：existing 不存在時跳過權限驗證的漏洞]
      // 原本只有 existing 為真時才呼叫 authorizeTripAccess，導致行程被刪除後
      // 任何帶有非空 x-api-key 的請求都能在沒有任何驗證的情況下重新建立行程。
      // 修正後：
      //   - existing 存在 → 走原本的 authorizeTripAccess（支援擁有者金鑰與分享連結）
      //   - existing 不存在（建立新行程）→ 一律要求 req.isOwner，
      //     分享連結持有者無法建立新行程，避免孤兒行程或資料被復活。
      if (existing) {
        if (!authorizeTripAccess(req, res, existing, true)) return;
      } else {
        if (!requireOwner(req, res)) return;
      }
      // 🆕 [併發保護] 原子化版本比對（真正的樂觀鎖）：
      // 先前的保護完全靠前端「存檔前先 GET 查一次現在的版本、比對後才 PUT」，
      // 但這是兩個分開的 HTTP 請求，中間有一段競爭視窗——如果 A、B 兩個分頁
      // 幾乎同時各自查完版本（都還沒看到對方），會誰都判斷「沒有衝突」，
      // 兩邊都直接送出覆蓋式 PUT，最後送達的那個會整包蓋掉先送達的，較早
      // 存的那份資料就消失。修正方式是把「檢查版本」搬進這次 PUT 請求本身，
      // 讓檢查與寫入在伺服器這裡合併成單一原子操作：只要前端送來的
      // expectedUpdatedAt 跟伺服器「當下」的版本對不上，就直接拒絕（409），
      // 不會被任何其他請求插隊。前端收到 409 後會自動合併最新版本並重試
      // （見 webui/public/index.html 的 saveTripToApi()）。
      // 沒有帶 expectedUpdatedAt（例如非常舊版的前端）或行程原本就沒有
      // updatedAt（尚未被任何人存過）時，維持原本行為、不擋。
      if (existing) {
        const expected = req.body && req.body.expectedUpdatedAt;
        if (typeof expected === 'number' && typeof existing.updatedAt === 'number' && expected !== existing.updatedAt) {
          return res.status(409).json({
            error: '這個行程已經被其他人更新過，請合併最新版本後再儲存一次。',
            currentTrip: existing,
          });
        }
      }
      const incoming = req.body || {};
      delete incoming.expectedUpdatedAt; // 只是拿來比對版本用的欄位，不屬於行程資料本身，避免被存進去
      // 🔒 [分享連結安全性] shareLinks 永遠沿用伺服器上原有的清單，完全忽略
      // 前端送上來的 shareLinks 內容。
      // 理由一（非擁有者）：避免持有「可編輯」分享連結的人竄改分享清單。
      // 理由二（擁有者）：前端的 repairTrip() 不處理 shareLinks，擁有者儲存
      // 時前端送來的 trip 物件裡 shareLinks 可能是空陣列或缺漏，若直接覆蓋
      // 會把已建立的分享連結全部清空，導致唯讀連結失效。
      // 分享連結的建立/列出/撤銷永遠只能透過下方專屬的擁有者專用端點。
      if (existing) {
        incoming.shareLinks = existing.shareLinks;
      }
      const repaired = storage.repairTrip({ ...incoming, id: req.params.tripId });
      guild.trips[req.params.tripId] = repaired;
      // 🆕 [多人協作 / 即時同步] 改用 storage.touchTrip() 而不是直接寫
      // repaired.updatedAt = Date.now()：touchTrip() 內部除了蓋時間戳記，
      // 也會 emit('trip-updated', ...) 觸發 SSE 廣播。這是 webui 最主要的
      // 寫入路徑（「儲存到 Bot」按鈕），先前這裡繞過 touchTrip() 直接賦值，
      // 導致 webui 存檔完全不會推播給其他分頁，是「都要重整頁面才會更新」
      // 的根本原因。
      storage.touchTrip(repaired);
      storage.persist();
      res.json(repaired);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════════
  // 🆕 [分享連結] 擁有者專用：建立／列出／撤銷某個行程的分享連結
  // ════════════════════════════════════════════════════════════════
  // 這三個端點永遠只接受擁有者本人的 SPLITBILL_API_KEY，即使是「可編輯」
  // 的分享連結也不能呼叫——理由同上方 PUT 的安全性備註：分享連結的管理權
  // 本身不能被分享出去，否則等於任何拿到一個可編輯連結的人都能再幫自己
  // 開一把全新的、甚至是更高權限的連結，形同權限可以無限擴散。
  function requireOwner(req, res) {
    if (apiKey && !req.isOwner) {
      res.status(403).json({ error: '此操作僅限擁有者本人執行' });
      return false;
    }
    return true;
  }

  /**
   * 🆕 [分享連結] 給「不特定行程」的共用工具端點用（即時匯率查詢、帳單照片
   * 辨識）：擁有者永遠放行；否則檢查提供的金鑰是不是「任何一個行程」名下
   * 尚未過期的分享連結——這兩個端點本身不吃 guildId/tripId，也不會回傳任何
   * 特定行程的私密資料（純粹是查匯率、把照片丟給 AI 辨識回傳品項與金額），
   * 所以不像 authorizeTripAccess() 那樣需要綁定「這一個」行程，只要是任何一把
   * 有效的分享連結就算數。requireWrite=true 時進一步限定只有「可編輯」權限
   * 的連結才算數（唯讀訪客不能用來新增資料，帳單辨識屬於這一類）。
   */
  function hasShareableCredential(req, requireWrite) {
    if (req.isOwner) return true;
    if (!req.providedKey) return false;
    const found = storage.findTripByShareToken(req.providedKey);
    if (!found) return false;
    if (storage.isShareLinkExpired(found.shareLink)) return false;
    if (requireWrite && found.shareLink.permission !== 'write') return false;
    return true;
  }

  // ---- POST /api/trip/:guildId/:tripId/share-links：建立一筆新的分享連結 ----
  // body: { label?: string, permission: 'read'|'write', expiresInDays?: number|null }
  //   expiresInDays 省略或 null／0／負數 一律視為「永久有效」。
  app.post('/api/trip/:guildId/:tripId/share-links', (req, res) => {
    if (!requireOwner(req, res)) return;
    try {
      const guild = storage.getGuild(req.params.guildId);
      const trip = guild.trips[req.params.tripId];
      if (!trip) return res.status(404).json({ error: '找不到這個行程' });

      const body = req.body || {};
      const permission = body.permission === 'write' ? 'write' : 'read';
      const label = typeof body.label === 'string' ? body.label.slice(0, 50) : '';
      const days = Number(body.expiresInDays);
      const expiresAt = (Number.isFinite(days) && days > 0)
        ? Date.now() + days * 24 * 60 * 60 * 1000
        : null;

      const link = {
        token: storage.genShareToken(),
        label,
        permission,
        expiresAt,
        createdAt: Date.now(),
      };

      if (!Array.isArray(trip.shareLinks)) trip.shareLinks = [];
      trip.shareLinks.push(link);
      storage.persist();

      res.json(link);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- GET /api/trip/:guildId/:tripId/share-links：列出這個行程目前所有分享連結 ----
  app.get('/api/trip/:guildId/:tripId/share-links', (req, res) => {
    if (!requireOwner(req, res)) return;
    try {
      const guild = storage.getGuild(req.params.guildId);
      const trip = guild.trips[req.params.tripId];
      if (!trip) return res.status(404).json({ error: '找不到這個行程' });
      res.json(trip.shareLinks || []);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 🆕 ---- PATCH /api/trip/:guildId/:tripId/share-links/:token：修改一筆既有分享連結的權限 ----
  // 讓擁有者不用撤銷重建，就能隨時把一組已經發出去的連結在「唯讀／可編輯」之間切換。
  // 連結本身的 token／網址完全不變（對方書籤/聊天室裡存的舊連結還是同一個），
  // 只有伺服器這邊記錄的 permission 欄位被更新，下一次對方存取或儲存時就會立刻套用新權限。
  // body: { permission: 'read'|'write' }
  app.patch('/api/trip/:guildId/:tripId/share-links/:token', (req, res) => {
    if (!requireOwner(req, res)) return;
    try {
      const guild = storage.getGuild(req.params.guildId);
      const trip = guild.trips[req.params.tripId];
      if (!trip) return res.status(404).json({ error: '找不到這個行程' });

      const permission = (req.body || {}).permission;
      if (permission !== 'read' && permission !== 'write') {
        return res.status(400).json({ error: 'permission 必須是 "read" 或 "write"' });
      }

      const link = (trip.shareLinks || []).find((l) => l.token === req.params.token);
      if (!link) {
        return res.status(404).json({ error: '找不到這筆分享連結，可能已經被撤銷過了' });
      }

      link.permission = permission;
      storage.persist();
      res.json(link);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- DELETE /api/trip/:guildId/:tripId/share-links/:token：撤銷一筆分享連結 ----
  app.delete('/api/trip/:guildId/:tripId/share-links/:token', (req, res) => {
    if (!requireOwner(req, res)) return;
    try {
      const guild = storage.getGuild(req.params.guildId);
      const trip = guild.trips[req.params.tripId];
      if (!trip) return res.status(404).json({ error: '找不到這個行程' });

      const before = (trip.shareLinks || []).length;
      trip.shareLinks = (trip.shareLinks || []).filter((l) => l.token !== req.params.token);
      if (trip.shareLinks.length === before) {
        return res.status(404).json({ error: '找不到這筆分享連結，可能已經被撤銷過了' });
      }
      storage.persist();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════════
  // 🆕 [分享連結] 分享連結持有者專用：純粹靠網址路徑上的 token 當憑證，
  // 完全不需要另外填寫或帶上任何 API Key——這是刻意的設計，因為分享連結
  // 的對象通常是不熟悉技術的朋友，任何「還要另外設定金鑰」的步驟對他們
  // 來說都是困惑跟阻礙。安全性由 token 本身的高熵亂數（192 bits）與可
  // 個別撤銷/設定過期時間來保證，而不是靠額外的登入手續。
  // ════════════════════════════════════════════════════════════════

  // ---- GET /api/shared-trip/:token：依分享連結 token 取得對應的行程資料 ----
  app.get('/api/shared-trip/:token', (req, res) => {
    try {
      const found = storage.findTripByShareToken(req.params.token);
      if (!found) return res.status(404).json({ error: '這個分享連結不存在，可能已經被撤銷或網址有誤' });
      if (storage.isShareLinkExpired(found.shareLink)) {
        return res.status(403).json({ error: '這個分享連結已經過期，請跟建立連結的人索取新的連結' });
      }
      res.json({ trip: found.trip, permission: found.shareLink.permission });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- PUT /api/shared-trip/:token：依分享連結 token 寫入行程資料（需要 write 權限）----
  app.put('/api/shared-trip/:token', (req, res) => {
    try {
      const found = storage.findTripByShareToken(req.params.token);
      if (!found) return res.status(404).json({ error: '這個分享連結不存在，可能已經被撤銷或網址有誤' });
      if (storage.isShareLinkExpired(found.shareLink)) {
        return res.status(403).json({ error: '這個分享連結已經過期，請跟建立連結的人索取新的連結' });
      }
      if (found.shareLink.permission !== 'write') {
        return res.status(403).json({ error: '此分享連結為唯讀，無法儲存變更' });
      }

      // 🆕 [併發保護] 原子化版本比對，理由同上方 PUT /api/trip/:guildId/:tripId。
      // 分享連結版本先前完全沒有任何併發保護（連前端的「先查再比對」都沒有），
      // 風險其實比擁有者版本更高，這裡一併補上。
      const expected = req.body && req.body.expectedUpdatedAt;
      if (typeof expected === 'number' && typeof found.trip.updatedAt === 'number' && expected !== found.trip.updatedAt) {
        return res.status(409).json({
          error: '這個行程已經被其他人更新過，請合併最新版本後再儲存一次。',
          currentTrip: found.trip,
        });
      }

      const incoming = req.body || {};
      delete incoming.expectedUpdatedAt;
      // 🔒 同上方 PUT /api/trip/... 的安全性備註：分享連結持有者送來的內容，
      // shareLinks 欄位一律忽略、沿用伺服器上原本的清單，避免被拿來竄改
      // 分享連結本身。
      incoming.shareLinks = found.trip.shareLinks;
      const repaired = storage.repairTrip({ ...incoming, id: found.trip.id });
      found.guild.trips[found.trip.id] = repaired;
      // 🆕 [多人協作 / 即時同步] 同上，改用 touchTrip() 才會觸發 SSE 廣播。
      storage.touchTrip(repaired);
      storage.persist();
      res.json({ trip: repaired, permission: found.shareLink.permission });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- POST /api/parse-receipt：上傳帳單照片，用 Gemini 的視覺能力辨識出品項、金額、
  // 服務費比例、幣別。跟專案既有 /ai 指令共用同一把 GEMINI_API_KEY。 ----
  // body: { image: '<純 base64，不含 data: 前綴>', mediaType: 'image/jpeg' }
  // 🆕 [分享連結] 帳單照片辨識會消耗共用的 Gemini API 額度、且是「新增資料」
  // 性質的操作，因此只開放給擁有者本人，或是擁有「可編輯」權限的分享連結
  // （唯讀連結不行——唯讀訪客本來就不能新增花費，開放掃描給他們也用不上）。
  // ---- GET /api/fx-rate?from=JPY&to=TWD：取得當下即時匯率（供非基準幣支出/轉帳換算 amountInBase 用）----
  // 🆕 [分享連結] 查即時匯率本身是唯讀操作、不會洩漏任何特定行程的私密資料，
  // 因此開放給任何一把尚未過期的分享連結使用（唯讀或可編輯皆可）——唯讀訪客
  // 雖然不能存檔，但檢視金額換算後的正確結果一樣需要即時匯率。
  app.get('/api/fx-rate', async (req, res) => {
    if (apiKey && !hasShareableCredential(req, false)) {
      return res.status(403).json({ error: '此操作僅限擁有者本人或有效的分享連結使用' });
    }
    const from = String(req.query.from || '').trim().toUpperCase();
    const to = String(req.query.to || '').trim().toUpperCase();
    if (!from || !to) return res.status(400).json({ error: '缺少 from 或 to 參數' });
    if (from === to) return res.json({ rate: 1, asOf: null, source: 'same-currency' });
    try {
      const { rates, asOf } = await getFxRatesFor(from);
      const rate = rates[to];
      if (typeof rate !== 'number') {
        return res.status(404).json({ error: `即時匯率服務裡找不到 ${from} 兌 ${to} 的匯率` });
      }
      res.json({ rate, asOf, source: 'open.er-api.com' });
    } catch (err) {
      res.status(502).json({ error: '查詢即時匯率失敗：' + err.message });
    }
  });

  app.post('/api/parse-receipt', async (req, res) => {
    if (apiKey && !hasShareableCredential(req, true)) {
      return res.status(403).json({ error: '此功能僅限擁有者本人或擁有「可編輯」權限的分享連結使用' });
    }
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

module.exports = { startWebApi, extractJsonObject, sanitizeReceiptResponse, getFxRatesFor };