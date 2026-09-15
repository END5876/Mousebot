'use strict';
const express = require('express');
const crypto = require('crypto');

// SSE 換票與事件串流端點。底層的訂閱表/廣播機制在 webui/lib/sse.js。
module.exports = function createSseRouter(ctx) {
  const {
    storage, apiKey, authorizeTripAccess,
    sseTickets, pruneSseTickets, SSE_TICKET_TTL_MS, openTripSseStream,
  } = ctx;
  const router = express.Router();

  // ════════════════════════════════════════════════════════════════
  // 🆕 [即時同步] POST /api/sse-ticket：擁有者專用，用一般的 header 驗證
  // （沿用 webui/lib/auth.js 的 x-api-key 檢查）換取一張短效、一次性的
  // 票券，再拿這張票券去開啟下面的 SSE 連線。分享連結不需要呼叫這個
  // 端點——它的 SSE 連線直接用網址上的 token 當憑證即可。
  // ════════════════════════════════════════════════════════════════
  router.post('/sse-ticket', (req, res) => {
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
  router.get('/trip/:guildId/:tripId/events', (req, res) => {
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
  router.get('/shared-trip/:token/events', (req, res) => {
    const found = storage.findTripByShareToken(req.params.token);
    if (!found) return res.status(404).json({ error: '這個分享連結不存在，可能已經被撤銷或網址有誤' });
    if (storage.isShareLinkExpired(found.shareLink)) {
      return res.status(403).json({ error: '這個分享連結已經過期，請跟建立連結的人索取新的連結' });
    }
    openTripSseStream(res, found.trip.id);
  });

  return router;
};
