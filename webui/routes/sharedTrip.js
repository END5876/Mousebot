'use strict';
const express = require('express');

// ════════════════════════════════════════════════════════════════
// 🆕 [分享連結] 分享連結持有者專用：純粹靠網址路徑上的 token 當憑證，
// 完全不需要另外填寫或帶上任何 API Key——這是刻意的設計，因為分享連結
// 的對象通常是不熟悉技術的朋友，任何「還要另外設定金鑰」的步驟對他們
// 來說都是困惑跟阻礙。安全性由 token 本身的高熵亂數（192 bits）與可
// 個別撤銷/設定過期時間來保證，而不是靠額外的登入手續。
//
// SSE 版本（GET /api/shared-trip/:token/events）放在 routes/sse.js。
// ════════════════════════════════════════════════════════════════
module.exports = function createSharedTripRouter(ctx) {
  const { storage } = ctx;
  const router = express.Router();

  // ---- GET /api/shared-trip/:token：依分享連結 token 取得對應的行程資料 ----
  router.get('/shared-trip/:token', (req, res) => {
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
  router.put('/shared-trip/:token', (req, res) => {
    try {
      const found = storage.findTripByShareToken(req.params.token);
      if (!found) return res.status(404).json({ error: '這個分享連結不存在，可能已經被撤銷或網址有誤' });
      if (storage.isShareLinkExpired(found.shareLink)) {
        return res.status(403).json({ error: '這個分享連結已經過期，請跟建立連結的人索取新的連結' });
      }
      if (found.shareLink.permission !== 'write') {
        return res.status(403).json({ error: '此分享連結為唯讀，無法儲存變更' });
      }

      // 🆕 [併發保護] 原子化版本比對，理由同 routes/trips.js 的 PUT /api/trip/:guildId/:tripId。
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
      const writerId = typeof incoming.writerId === 'string' ? incoming.writerId.slice(0, 64) : null;
      delete incoming.expectedUpdatedAt;
      delete incoming.writerId;
      // 🔒 同上方 routes/trips.js PUT 的安全性備註：分享連結持有者送來的內容，
      // shareLinks 欄位一律忽略、沿用伺服器上原本的清單，避免被拿來竄改
      // 分享連結本身。
      incoming.shareLinks = found.trip.shareLinks;
      const repaired = storage.repairTrip({ ...incoming, id: found.trip.id });
      found.guild.trips[found.trip.id] = repaired;
      // 🆕 [多人協作 / 即時同步] 同上，改用 touchTrip() 才會觸發 SSE 廣播，
      // 並一併帶上 writerId 讓寫入者本人可以被正確辨識出來。
      storage.touchTrip(repaired, { writerId });
      storage.persist();
      res.json({ trip: repaired, permission: found.shareLink.permission });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
