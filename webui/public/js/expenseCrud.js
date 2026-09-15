'use strict';
// 支出的新增/編輯/刪除，與「表單是否有未儲存內容」的保護判斷。
/* ===================== expense CRUD ===================== */
// 🆕 [即時同步保護] 判斷「新增支出」表單目前是否有使用者還沒送出的內容——
// 不只是編輯既有支出（editingExpenseId），也包含「正在填一筆全新的支出」：
// 已輸入項目名稱/金額，或已勾選任何代墊人/分攤成員。
// 用途：renderAll() 在別人透過 SSE 存檔、或任何其他操作觸發重繪時，
// 都會呼叫 buildChips() 整個重建 chips 清單（innerHTML 覆蓋），這會讓
// 使用者剛勾選的成員與手動調整的金額無聲消失。呼叫端只要偵測到這裡回傳
// true，就該跳過重建，保留使用者正在輸入的內容。
function hasUnsavedExpenseFormContent(){
  if (editingExpenseId) return true; // 正在編輯既有一筆，本來就該保護
  const descEl = document.getElementById('expDesc');
  const amountEl = document.getElementById('expAmount');
  if ((descEl && descEl.value.trim()) || (amountEl && amountEl.value.trim())) return true;
  if (document.querySelector('#payerChips .chip.checked')) return true;
  if (document.querySelector('#participantChips .chip.checked')) return true;
  return false;
}

// 🆕 [即時同步保護] 轉帳／預收款表單版本；轉帳表單用的是 <select> 而不是
// chip-checkbox，renderAll() 重繪時本來就會保留選取值（見 renderDepositSelects()
// 的「先記住、再重套用」寫法），不會像支出表單那樣被無聲清空，但這裡仍然
// 一併提供，讓 handleIncomingTripUpdate() 判斷「使用者是否正在操作中」時
// 可以把轉帳表單也納入考量，行為更一致。
function hasUnsavedDepositFormContent(){
  if (editingDepositId) return true;
  const payer = document.getElementById('depPayer');
  const collector = document.getElementById('depCollector');
  const amount = document.getElementById('depAmount');
  const note = document.getElementById('depNote');
  return !!(
    (payer && payer.value) || (collector && collector.value) ||
    (amount && amount.value.trim()) || (note && note.value.trim())
  );
}

function resetExpenseForm(){
  editingExpenseId = null;
  participantsDirty = false;
  document.getElementById('expenseFormTitle').textContent = '新增一筆支出';
  document.getElementById('expDesc').value = '';
  document.getElementById('expAmount').value = '';
  document.getElementById('expAmountInBase').value = '';
  buildChips('payerChips','payer');
  buildChips('participantChips','participant');
  renderExpenseHint();
  refreshExpenseLiveRate();
}
function resolveExpenseRate(currency){
  if (currency === trip.baseCurrency) return 1;
  if (expenseLiveRate && expenseLiveRate.currency === currency) return expenseLiveRate.rate;
  return trip.rates[currency];
}
function saveExpense(){
  const description = document.getElementById('expDesc').value.trim() || '（無說明）';
  const amount = parseFloat(document.getElementById('expAmount').value);
  const currency = document.getElementById('expCurrency').value;
  if (!(amount>0)){ toast('請輸入大於 0 的金額', 'error'); return false; }
  const customBaseRaw = document.getElementById('expAmountInBase').value.trim();
  const customBase = parseFloat(customBaseRaw);
  let amountInBase;
  if (currency !== trip.baseCurrency && customBaseRaw !== ''){
    if (!(customBase > 0)){ toast('換算後真實金額需為大於 0 的數字', 'error'); return false; }
    amountInBase = round2(customBase);
  } else {
    const rate = resolveExpenseRate(currency);
    if (!(rate>0)){ toast(`幣別 ${currency} 尚無匯率設定，且目前無法取得即時匯率`, 'error'); return false; }
    amountInBase = round2(amount*rate);
  }

  const payers = readChipValues('payer').filter(p=>p.amount>0 || document.querySelector(`#payerChips .chip[data-id="${p.userId}"]`).classList.contains('checked'));
  const participants = readChipValues('participant');

  if (!payers.length){ toast('請至少勾選一位代墊付款人', 'error'); return false; }
  if (!participants.length){ toast('請至少勾選一位分攤成員', 'error'); return false; }

  const payerSum = round2(payers.reduce((s,p)=>s+p.amount,0));
  if (round2(Math.abs(payerSum-amount)) > 0.01){ toast(`代墊金額總和 (${payerSum}) 與總金額 (${amount}) 不相符`, 'error'); return false; }
  const partSum = round2(participants.reduce((s,p)=>s+p.amount,0));
  if (round2(Math.abs(partSum-amount)) > 0.01){ toast(`分攤金額總和 (${partSum}) 與總金額 (${amount}) 不相符`, 'error'); return false; }

  if (editingExpenseId){
    const exp = trip.expenses.find(e=>e.id===editingExpenseId);
    Object.assign(exp, { description, amount, currency, amountInBase, payers, participants });
    toast('已更新支出', 'success');
  } else {
    trip.expenses.push({
      id: genId('exp'), description, amount, currency, amountInBase,
      payers, participants, createdAt: Date.now(), createdBy: 'web-ui'
    });
    toast('已新增支出', 'success');
  }
  resetExpenseForm();
  renderAll();
  return true;
}
async function saveExpenseAndSync(){
  if (saveExpense()) await saveTripToApi();
}
function editExpense(id){
  const exp = trip.expenses.find(e=>e.id===id);
  if (!exp) return;
  editingExpenseId = id;
  participantsDirty = true; // 編輯既有支出時，尊重原本已經存好的分攤金額，不要自動覆蓋
  document.getElementById('expenseFormTitle').textContent = '編輯支出';
  document.getElementById('expDesc').value = exp.description;
  document.getElementById('expAmount').value = exp.amount;
  document.getElementById('expCurrency').innerHTML = currencyOptions(exp.currency);
  document.getElementById('expAmountInBase').value = exp.currency !== trip.baseCurrency ? exp.amountInBase : '';
  buildChips('payerChips','payer');
  buildChips('participantChips','participant');
  exp.payers.forEach(p=>{
    const chip = document.querySelector(`#payerChips .chip[data-id="${p.userId}"]`);
    if (chip){ chip.querySelector('input[type=checkbox]').checked = true; chip.classList.add('checked'); chip.querySelector('.amt').value = p.amount; }
  });
  exp.participants.forEach(s=>{
    const chip = document.querySelector(`#participantChips .chip[data-id="${s.userId}"]`);
    if (chip){ chip.querySelector('input[type=checkbox]').checked = true; chip.classList.add('checked'); chip.querySelector('.amt').value = s.amount; }
  });
  renderExpenseHint();
  refreshExpenseLiveRate();
  showMainTab('expenses');
  document.getElementById('panel-expenses').scrollIntoView({behavior:'smooth'});
}
async function deleteExpense(id){
  const idx = trip.expenses.findIndex(e => e.id === id);
  if (idx === -1) return;

  const expense = trip.expenses[idx];
  const confirmed = await confirmModal(
    `確定要刪除支出「${expense.description || '未命名支出'}」嗎？確認後將立即儲存到 Bot。`,
    {
      title: '確認刪除支出',
      confirmText: '確認刪除',
      cancelText: '取消',
      danger: true,
    }
  );

  if (!confirmed) return;

  trip.expenses.splice(idx, 1);

  if (editingExpenseId === id) {
    resetExpenseForm();
  }

  renderAll();

  // 確認刪除後立即寫入伺服器；分享連結模式也會自動走對應的儲存 API。
  await saveTripToApi();
}

