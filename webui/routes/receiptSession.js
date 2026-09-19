'use strict';
const express = require('express');

// ════════════════════════════════════════════════════════════════
// 🆕 [多人協作] 帳單辨識認領進度的即時同步端點。
// 刻意沿用既有的「分享連結」權限模型：不另外產生新的協作連結，任何擁有
// 這個行程「可編輯」權限的人（擁有者本人，或 write 權限的分享連結持有者）
// 都可以讀取／更新目前進行中的認領狀態；唯讀連結持有者只能被動看見有人
// 在協作（前端會顯示提示），但無法加入操作。
//
// 資料本身完全不落地（見 lib/receiptSessions.js），也不夾帶進 trip 物件，
// 廣播管道直接重用既有的「這個行程的 SSE 訂閱者」（webui/lib/sse.js 的
// tripSubscribers），不需要另外開一組 SSE 端點或另外換票。
// ════════════════════════════════════════════════════════════════
module.exports = function createReceiptSessionRouter(ctx) {
  const {
    storage, authorizeTripAccess,
    getReceiptSession, setReceiptSession, clearReceiptSession, broadcastReceiptSession,
  } = ctx;
  const router = express.Router();

  function respondSession(res, entry) {
    res.json(entry ? { active: true, state: entry.state, updatedAt: entry.updatedAt } : { active: false });
  }

  // 只接受已知的兩種結束原因，其餘一律當成 null（前端會顯示語意含糊但仍
  // 安全的預設訊息），避免任意字串未經檢查就被塞進 SSE 廣播內容。
  const KNOWN_END_REASONS = new Set(['finalized', 'abandoned']);
  function sanitizeReceiptSessionEndReason(raw) {
    return KNOWN_END_REASONS.has(raw) ? raw : null;
  }

  // ---- 擁有者／一般分享連結路徑：/api/trip/:guildId/:tripId/receipt-session ----
  router.get('/trip/:guildId/:tripId/receipt-session', (req, res) => {
    try {
      const guild = storage.getGuild(req.params.guildId);
      const trip = guild.trips[req.params.tripId];
      if (!trip) return res.status(404).json({ error: '找不到這個行程' });
      if (!authorizeTripAccess(req, res, trip, true)) return;
      respondSession(res, getReceiptSession(trip.id));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/trip/:guildId/:tripId/receipt-session', (req, res) => {
    try {
      const guild = storage.getGuild(req.params.guildId);
      const trip = guild.trips[req.params.tripId];
      if (!trip) return res.status(404).json({ error: '找不到這個行程' });
      if (!authorizeTripAccess(req, res, trip, true)) return;
      const body = req.body || {};
      if (!body.state || typeof body.state !== 'object') {
        return res.status(400).json({ error: '缺少 state 資料' });
      }
      const writerId = typeof body.writerId === 'string' ? body.writerId.slice(0, 64) : null;
      const entry = setReceiptSession(trip.id, body.state, writerId);
      broadcastReceiptSession(trip.id, entry);
      res.json({ ok: true, updatedAt: entry.updatedAt });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/trip/:guildId/:tripId/receipt-session', (req, res) => {
    try {
      const guild = storage.getGuild(req.params.guildId);
      const trip = guild.trips[req.params.tripId];
      if (!trip) return res.status(404).json({ error: '找不到這個行程' });
      if (!authorizeTripAccess(req, res, trip, true)) return;
      clearReceiptSession(trip.id);
      broadcastReceiptSession(trip.id, null, sanitizeReceiptSessionEndReason(req.query.reason));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- 分享連結訪客路徑：/api/shared-trip/:token/receipt-session ----
  // 沿用 routes/sharedTrip.js 的做法：token 本身就是憑證，需要 write 權限才能讀寫。
  router.get('/shared-trip/:token/receipt-session', (req, res) => {
    try {
      const found = storage.findTripByShareToken(req.params.token);
      if (!found) return res.status(404).json({ error: '這個分享連結不存在，可能已經被撤銷或網址有誤' });
      if (storage.isShareLinkExpired(found.shareLink)) {
        return res.status(403).json({ error: '這個分享連結已經過期，請跟建立連結的人索取新的連結' });
      }
      if (found.shareLink.permission !== 'write') {
        return res.status(403).json({ error: '此分享連結為唯讀，無法加入帳單辨識協作' });
      }
      respondSession(res, getReceiptSession(found.trip.id));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/shared-trip/:token/receipt-session', (req, res) => {
    try {
      const found = storage.findTripByShareToken(req.params.token);
      if (!found) return res.status(404).json({ error: '這個分享連結不存在，可能已經被撤銷或網址有誤' });
      if (storage.isShareLinkExpired(found.shareLink)) {
        return res.status(403).json({ error: '這個分享連結已經過期，請跟建立連結的人索取新的連結' });
      }
      if (found.shareLink.permission !== 'write') {
        return res.status(403).json({ error: '此分享連結為唯讀，無法加入帳單辨識協作' });
      }
      const body = req.body || {};
      if (!body.state || typeof body.state !== 'object') {
        return res.status(400).json({ error: '缺少 state 資料' });
      }
      const writerId = typeof body.writerId === 'string' ? body.writerId.slice(0, 64) : null;
      const entry = setReceiptSession(found.trip.id, body.state, writerId);
      broadcastReceiptSession(found.trip.id, entry);
      res.json({ ok: true, updatedAt: entry.updatedAt });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/shared-trip/:token/receipt-session', (req, res) => {
    try {
      const found = storage.findTripByShareToken(req.params.token);
      if (!found) return res.status(404).json({ error: '這個分享連結不存在，可能已經被撤銷或網址有誤' });
      if (storage.isShareLinkExpired(found.shareLink)) {
        return res.status(403).json({ error: '這個分享連結已經過期，請跟建立連結的人索取新的連結' });
      }
      if (found.shareLink.permission !== 'write') {
        return res.status(403).json({ error: '此分享連結為唯讀，無法結束帳單辨識協作' });
      }
      clearReceiptSession(found.trip.id);
      broadcastReceiptSession(found.trip.id, null, sanitizeReceiptSessionEndReason(req.query.reason));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
