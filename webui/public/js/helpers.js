'use strict';

/* =====================================================================
   資料結構（與 Mousebot handlers/splitbill/utils/storage.js 對齊）
   Trip = {
     id, name, baseCurrency, rates:{cur:rate}, members:[{id,name}],
     expenses:[{id,description,amount,currency,amountInBase,payers:[{userId,amount}],
                participants:[{userId,amount}],createdAt,createdBy}],
     deposits:[{id,collectorId,payerId,amount,currency,amountInBase,note,createdAt}],
     archived, createdAt
   }
===================================================================== */

function genId(prefix){ return prefix + '_' + Math.random().toString(16).slice(2,10); }
function round2(n){ return Math.round((n + Number.EPSILON) * 100) / 100; }
function fmtMoney(amount, currency){
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '-';
  return amount.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// 🆕 [時間資訊] 支出／轉帳明細列需要顯示「這筆是什麼時候記的」，同一年只顯示
// 月/日 時:分（多天行程最常見的情境，不需要年份佔版面）；跨年（例如年底/年初
// 出遊，或很久以前的舊行程）才自動補上年份，避免誤判成今年的紀錄。
function fmtDateTime(ts){
  if (!ts || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  const datePart = d.getFullYear() === now.getFullYear()
    ? `${d.getMonth()+1}/${d.getDate()}`
    : `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
  return `${datePart} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
