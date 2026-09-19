'use strict';
// 全域狀態（trip/editingExpenseId/shareMode 等）、分頁切換、行程名稱/幣別欄位監聽。
/* ===================== state ===================== */
let trip = defaultTrip();
let editingExpenseId = null;
let editingDepositId = null;
// 🆕 [分享連結] null＝目前是擁有者模式（用真正的 SPLITBILL_API_KEY 操作）；
// 有值時代表這個分頁是透過分享連結打開的：{ token, permission:'read'|'write' }。
// 一旦進入分享模式就不會再切回擁有者模式（同一個分頁不混用兩種身分），
// 相關 UI 收斂見 body.share-mode / body.share-readonly 這兩個 CSS class。
let shareMode = null;

function memberName(id){ const m = trip.members.find(x=>x.id===id); return m ? m.name : '（已刪除成員）'; }
function currencyOptions(selected){
  return Object.keys(trip.rates).sort().map(c=>`<option value="${c}" ${c===selected?'selected':''}>${c}${c===trip.baseCurrency?' (基準)':''}</option>`).join('');
}

/* ===================== tabs ===================== */
let currentSettingsSub = 'members';
function showMainTab(tab){
  document.querySelectorAll('#topNav .nav-btn, #bottomNav .nav-btn').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.panel[data-panel]').forEach(p=>p.classList.toggle('active', p.dataset.panel===tab));
  if (tab === 'settings') showSettingsSub(currentSettingsSub);
  if (tab === 'expenses' && typeof checkReceiptSessionAvailability === 'function') checkReceiptSessionAvailability(); // 🆕 [多人協作] 進入支出分頁時，順便確認有沒有人正在進行帳單辨識協作
  renderAll();
  window.scrollTo({top:0, behavior:'smooth'});
}
function showSettingsSub(sub){
  currentSettingsSub = sub;
  document.querySelectorAll('.settings-subnav .subtab-btn').forEach(b=>b.classList.toggle('active', b.dataset.subtab===sub));
  document.querySelectorAll('.subpanel[data-subpanel]').forEach(p=>p.classList.toggle('active', p.dataset.subpanel===sub));
  if (sub === 'io') syncAdvDetailsState();
  if (sub === 'share') renderShareLinksPanel();
}
// 已連線 Bot 時，把「本機檔案／下載貼上／匯入」這些備用方式預設收合，
// 減少畫面雜訊；沒連線時預設展開，因為那時候本機方式就是主要路徑。
function syncAdvDetailsState(){
  const details = document.getElementById('advFileDetails');
  if (!details) return;
  const connected = !!document.getElementById('guildSelect').value;
  if (!details.dataset.userToggled) details.open = !connected;
}

/* ===================== cover fields ===================== */
document.getElementById('tripName').addEventListener('input', e=>{ trip.name = e.target.value; scheduleAutoSave(); });
document.getElementById('baseCurrency').addEventListener('change', e=>{
  trip.baseCurrency = e.target.value;
  trip.rates[trip.baseCurrency] = 1;
  renderAll();
});
document.addEventListener('DOMContentLoaded', ()=>{
  const details = document.getElementById('advFileDetails');
  if (details) details.addEventListener('toggle', ()=>{ details.dataset.userToggled = '1'; });
});

