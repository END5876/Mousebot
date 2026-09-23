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

// 🆕 [日期分組] 只回傳「時:分」不含日期，用於已經依日期分組的清單（分組
// 標題已經顯示日期，每筆底下不需要再重複印一次日期，避免同一筆資訊
// 「9/23 14:30」旁邊又有一個「9/23」分組標題重複顯示同一件事）。
function fmtTime(ts){
  if (!ts || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2,'0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 🆕 [日期分組] 把一組帳目（支出／轉帳，需已依 createdAt 由新到舊排序）
// 依「日曆日期」分組，回傳 [{ label, items, subtotal }]。
// label：今天／昨天／M-D（同年）／Y/M/D（跨年）。
// subtotal：該組項目的 amountInBase 加總（沒有 amountInBase 則退回 amount），
// 一律以 trip.baseCurrency 顯示，方便一眼看出「這天大概花了多少」。
function fmtDateKey(d){
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function groupItemsByDate(items){
  const groups = [];
  const now = new Date();
  const todayKey = fmtDateKey(now);
  const yest = new Date(now); yest.setDate(yest.getDate()-1);
  const yestKey = fmtDateKey(yest);
  let currentKey = null, currentGroup = null;
  for (const item of items){
    const d = new Date(item.createdAt || 0);
    const key = fmtDateKey(d);
    if (key !== currentKey){
      currentKey = key;
      const label = key === todayKey ? '今天'
        : key === yestKey ? '昨天'
        : d.getFullYear() === now.getFullYear() ? `${d.getMonth()+1}/${d.getDate()}`
        : `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
      currentGroup = { label, items: [], subtotal: 0 };
      groups.push(currentGroup);
    }
    currentGroup.items.push(item);
    currentGroup.subtotal = round2(currentGroup.subtotal + (typeof item.amountInBase === 'number' ? item.amountInBase : (item.amount||0)));
  }
  return groups;
}
