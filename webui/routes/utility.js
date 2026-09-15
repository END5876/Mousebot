'use strict';
const express = require('express');

// 不綁定特定行程的共用工具端點：即時匯率查詢、帳單照片辨識。
module.exports = function createUtilityRouter(ctx) {
  const { apiKey, hasShareableCredential, getFxRatesFor, genAI, recognizeReceipt } = ctx;
  const router = express.Router();

  // ---- GET /api/fx-rate?from=JPY&to=TWD：取得當下即時匯率（供非基準幣支出/轉帳換算 amountInBase 用）----
  // 🆕 [分享連結] 查即時匯率本身是唯讀操作、不會洩漏任何特定行程的私密資料，
  // 因此開放給任何一把尚未過期的分享連結使用（唯讀或可編輯皆可）——唯讀訪客
  // 雖然不能存檔，但檢視金額換算後的正確結果一樣需要即時匯率。
  router.get('/fx-rate', async (req, res) => {
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

  // ---- POST /api/parse-receipt：上傳帳單照片，用 Gemini 的視覺能力辨識出品項、金額、
  // 服務費比例、幣別。跟專案既有 /ai 指令共用同一把 GEMINI_API_KEY。 ----
  // body: { image: '<純 base64，不含 data: 前綴>', mediaType: 'image/jpeg' }
  // 🆕 [分享連結] 帳單照片辨識會消耗共用的 Gemini API 額度、且是「新增資料」
  // 性質的操作，因此只開放給擁有者本人，或是擁有「可編輯」權限的分享連結
  // （唯讀連結不行——唯讀訪客本來就不能新增花費，開放掃描給他們也用不上）。
  router.post('/parse-receipt', async (req, res) => {
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
      const sanitized = await recognizeReceipt(image, mediaType);
      res.json(sanitized);
    } catch (err) {
      res.status(500).json({ error: '帳單辨識失敗：' + err.message });
    }
  });

  return router;
};
