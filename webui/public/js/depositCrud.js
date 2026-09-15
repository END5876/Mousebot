'use strict';
// 轉帳／預收款的新增/編輯/刪除與即時匯率提示。
/* ===================== deposit CRUD ===================== */
let depositLiveRate = null; // { currency, rate, asOf }
async function refreshDepositLiveRate(){
  const currency = document.getElementById('depCurrency').value;
  if (currency === trip.baseCurrency){ depositLiveRate = null; renderDepositHint(); return; }
  const result = await fetchLiveRate(currency, trip.baseCurrency);
  if (document.getElementById('depCurrency').value !== currency) return;
  if (result){
    depositLiveRate = { currency, rate: result.rate, asOf: result.asOf };
    trip.rates[currency] = result.rate;
  } else {
    depositLiveRate = null;
  }
  renderDepositHint();
}
function resolveDepositRate(currency){
  if (currency === trip.baseCurrency) return 1;
  if (depositLiveRate && depositLiveRate.currency === currency) return depositLiveRate.rate;
  return trip.rates[currency];
}
function renderDepositHint(){
  const amount = parseFloat(document.getElementById('depAmount').value) || 0;
  const currency = document.getElementById('depCurrency').value;
  const customInput = document.getElementById('depAmountInBase');
  const customBase = parseFloat(customInput.value);
  const hintEl = document.getElementById('depBaseHint');
  if (!hintEl) return;
  const isForeign = currency !== trip.baseCurrency;
  document.getElementById('depBaseCurrencyLabel').textContent = trip.baseCurrency;
  document.getElementById('depBaseAmountField').hidden = !isForeign;
  if (!isForeign){ customInput.value = ''; hintEl.innerHTML = ''; return; }
  if (customInput.value.trim() !== ''){
    hintEl.innerHTML = Number.isFinite(customBase) && customBase > 0
      ? `已採用手動指定的真實金額：<b>${fmtMoney(customBase, trip.baseCurrency)} ${trip.baseCurrency}</b>`
      : `請輸入大於 0 的真實金額，或清空欄位以依匯率自動換算。`;
  } else if (depositLiveRate && depositLiveRate.currency === currency){
    const base = round2(amount*depositLiveRate.rate);
    hintEl.innerHTML = `即時匯率 1 ${currency} = ${depositLiveRate.rate} ${trip.baseCurrency}，換算約為 <b>${fmtMoney(base, trip.baseCurrency)}</b>`;
  } else {
    const rate = trip.rates[currency];
    if (rate){
      const base = round2(amount*rate);
      hintEl.innerHTML = `⏳ 查詢即時匯率中…暫用手動設定的匯率換算約為 <b>${fmtMoney(base, trip.baseCurrency)}</b>`;
    } else {
      hintEl.innerHTML = `幣別 ${currency} 尚無匯率，正在查詢即時匯率…若查不到請先到「幣別匯率」分頁手動設定。`;
    }
  }
}
document.getElementById('depAmount').addEventListener('input', renderDepositHint);
document.getElementById('depAmountInBase').addEventListener('input', renderDepositHint);
document.getElementById('depCurrency').addEventListener('change', ()=>{ document.getElementById('depAmountInBase').value = ''; renderDepositHint(); refreshDepositLiveRate(); });

function resetDepositForm(){
  editingDepositId = null;
  document.getElementById('depositFormTitle').textContent = '新增一筆轉帳／預收款';
  document.getElementById('depAmount').value = '';
  document.getElementById('depAmountInBase').value = '';
  document.getElementById('depNote').value = '';
  renderDepositHint();
  refreshDepositLiveRate();
}
function saveDeposit(){
  const payerId = document.getElementById('depPayer').value;
  const collectorId = document.getElementById('depCollector').value;
  const amount = parseFloat(document.getElementById('depAmount').value);
  const currency = document.getElementById('depCurrency').value;
  const note = document.getElementById('depNote').value.trim();
  if (!payerId || !collectorId){ toast('請選擇付款人與收款人', 'error'); return false; }
  if (payerId === collectorId){ toast('付款人與收款人不能是同一人', 'error'); return false; }
  if (!(amount>0)){ toast('請輸入大於 0 的金額', 'error'); return false; }
  const customBaseRaw = document.getElementById('depAmountInBase').value.trim();
  const customBase = parseFloat(customBaseRaw);
  let amountInBase;
  if (currency !== trip.baseCurrency && customBaseRaw !== ''){
    if (!(customBase > 0)){ toast('換算後真實金額需為大於 0 的數字', 'error'); return false; }
    amountInBase = round2(customBase);
  } else {
    const rate = resolveDepositRate(currency);
    if (!(rate>0)){ toast(`幣別 ${currency} 尚無匯率設定，且目前無法取得即時匯率`, 'error'); return false; }
    amountInBase = round2(amount*rate);
  }

  if (editingDepositId){
    const dep = trip.deposits.find(d=>d.id===editingDepositId);
    Object.assign(dep, { payerId, collectorId, amount, currency, amountInBase, note });
    toast('已更新轉帳紀錄', 'success');
  } else {
    trip.deposits.push({ id: genId('dep'), payerId, collectorId, amount, currency, amountInBase, note, createdAt: Date.now() });
    toast('已新增轉帳紀錄', 'success');
  }
  resetDepositForm();
  renderAll();
  return true;
}
async function saveDepositAndSync(){
  if (saveDeposit()) await saveTripToApi();
}
function editDeposit(id){
  const dep = trip.deposits.find(d=>d.id===id);
  if (!dep) return;
  editingDepositId = id;
  document.getElementById('depositFormTitle').textContent = '編輯轉帳紀錄';
  renderDepositSelects();
  document.getElementById('depPayer').value = dep.payerId;
  document.getElementById('depCollector').value = dep.collectorId;
  document.getElementById('depCurrency').innerHTML = currencyOptions(dep.currency);
  document.getElementById('depAmount').value = dep.amount;
  document.getElementById('depAmountInBase').value = dep.currency !== trip.baseCurrency ? dep.amountInBase : '';
  document.getElementById('depNote').value = dep.note;
  renderDepositHint();
  refreshDepositLiveRate();
  showMainTab('deposits');
  document.getElementById('panel-deposits').scrollIntoView({behavior:'smooth'});
}
function deleteDeposit(id){
  const idx = trip.deposits.findIndex(d=>d.id===id);
  if (idx === -1) return;
  const [removed] = trip.deposits.splice(idx,1);
  if (editingDepositId===id) resetDepositForm();
  renderAll();
  toastUndo(`已刪除「${memberName(removed.payerId)} → ${memberName(removed.collectorId)}」的轉帳紀錄`, ()=>{ trip.deposits.splice(idx,0,removed); renderAll(); });
}

