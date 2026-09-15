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

