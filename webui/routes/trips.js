'use strict';
const express = require('express');

// 行程本體的讀寫端點：GET /api/guilds、GET/PUT /api/trip/:guildId/:tripId。
// ctx 由 webui/server.js 組裝，包含 storage / apiKey / authorizeTripAccess / requireOwner。
module.exports = function createTripsRouter(ctx) {
  const { storage, apiKey, authorizeTripAccess, requireOwner } = ctx;
  const router = express.Router();

  // ---- GET /api/guilds：列出所有伺服器與底下的行程（給前端下拉選單用） ----
  // 🆕 [分享連結] 這裡會列出「全部」伺服器與行程名稱，分享連結的持有者絕對
  // 不該看到這份清單（會曝光其他跟他無關的行程），因此強制只有擁有者本人
  // （真正的 SPLITBILL_API_KEY）能呼叫，分享 token 一律拒絕。
  router.get('/guilds', (req, res) => {
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
  router.get('/trip/:guildId/:tripId', (req, res) => {
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
  router.put('/trip/:guildId/:tripId', (req, res) => {
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
      // （見 webui/public/js/tripSync.js 的 saveTripToApi()）。
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
      // 🆕 [即時同步] 取出前端這次存檔附帶的 writerId（若有），等一下連同
      // touchTrip() 一起送給 SSE 廣播，讓寫入者本人可以認出「這是我自己」。
      // 限制長度只是基本防呆，這只是一個不透光的識別字串，不做任何權限用途。
      const writerId = typeof incoming.writerId === 'string' ? incoming.writerId.slice(0, 64) : null;
      delete incoming.expectedUpdatedAt; // 只是拿來比對版本用的欄位，不屬於行程資料本身，避免被存進去
      delete incoming.writerId; // 同上，不是行程資料欄位
      // 🔒 [分享連結安全性] shareLinks 永遠沿用伺服器上原有的清單，完全忽略
      // 前端送上來的 shareLinks 內容。
      // 理由一（非擁有者）：避免持有「可編輯」分享連結的人竄改分享清單。
      // 理由二（擁有者）：前端的 repairTrip() 不處理 shareLinks，擁有者儲存
      // 時前端送來的 trip 物件裡 shareLinks 可能是空陣列或缺漏，若直接覆蓋
      // 會把已建立的分享連結全部清空，導致唯讀連結失效。
      // 分享連結的建立/列出/撤銷永遠只能透過 routes/shareLinks.js 專屬的
      // 擁有者專用端點。
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
      storage.touchTrip(repaired, { writerId });
      storage.persist();
      res.json(repaired);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
