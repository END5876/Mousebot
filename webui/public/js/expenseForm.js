'use strict';
// 新增支出表單：代墊/分攤 chips、即時匯率提示、自動平均分攤邏輯。
/* ===================== expense chips ===================== */
// 🔧 依需求調整：新增支出時「誰要分攤」不再預設全選所有成員，改成完全空白，
// 由使用者自行勾選要分攤的人。取消勾選/勾選時仍會即時重新平均分攤金額
// （只要使用者還沒手動改過某人的金額，見 renderExpenseHint() 裡的判斷）。
let participantsDirty = false;
function buildChips(containerId, prefix){
  const container = document.getElementById(containerId);
  const defaultCheck = false;
  container.innerHTML = trip.members.map(m=>`
    <label class="chip${defaultCheck ? ' checked' : ''}" data-id="${m.id}">
      <span class="chip-checkbox"><input type="checkbox" ${defaultCheck ? 'checked' : ''} onchange="onChipToggle('${prefix}','${m.id}',this.checked)"></span>
      <span class="chip-label">${escapeHtml(m.name)}</span>
      <input type="number" class="amt" step="0.01" placeholder="0" data-id="${m.id}" oninput="${prefix==='participant' ? 'participantsDirty=true;' : ''}renderExpenseHint()">
    </label>`).join('') || '<p class="hint">尚未新增成員，請先到「成員」分頁新增。</p>';
}
function onChipToggle(prefix, id, checked){
  const wrap = document.getElementById(prefix==='payer'?'payerChips':'participantChips');
  const chip = wrap.querySelector(`.chip[data-id="${id}"]`);
  chip.classList.toggle('checked', checked);
  if (!checked){ chip.querySelector('.amt').value=''; }
  if (prefix === 'payer'){
    // 只勾選一位代墊付款人時，自動把總金額帶到他身上
    const checkedChips = [...wrap.querySelectorAll('.chip.checked')];
    if (checkedChips.length === 1){
      const amount = parseFloat(document.getElementById('expAmount').value);
      if (amount > 0) checkedChips[0].querySelector('.amt').value = amount;
    }
  }
  renderExpenseHint();
}
function equalFillChips(prefix){
  const wrap = document.getElementById(prefix==='payer'?'payerChips':'participantChips');
  const checked = [...wrap.querySelectorAll('.chip.checked')].map(c=>c.dataset.id);
  const amount = parseFloat(document.getElementById('expAmount').value);
  if (!checked.length){ toast(prefix==='payer'?'請先勾選代墊付款人':'請先勾選分攤成員', 'error'); return; }
  if (!(amount>0)){ toast('請先輸入金額', 'error'); return; }
  if (prefix === 'participant') participantsDirty = false;
  const shares = equalSplit(amount, checked);
  shares.forEach(s=>{
    const input = wrap.querySelector(`.chip[data-id="${s.userId}"] .amt`);
    if (input) input.value = s.amount;
  });
  renderExpenseHint();
}
function checkAllParticipants(){
  const wrap = document.getElementById('participantChips');
  const amount = parseFloat(document.getElementById('expAmount').value);
  const allIds = trip.members.map(m=>m.id);
  if (!allIds.length){ toast('尚未新增成員', 'error'); return; }
  allIds.forEach(id=>{
    const chip = wrap.querySelector(`.chip[data-id="${id}"]`);
    if (!chip) return;
    chip.querySelector('input[type=checkbox]').checked = true;
    chip.classList.add('checked');
  });
  participantsDirty = false;
  if (amount > 0){
    const shares = equalSplit(amount, allIds);
    shares.forEach(s=>{
      const input = wrap.querySelector(`.chip[data-id="${s.userId}"] .amt`);
      if (input) input.value = s.amount;
    });
  }
  renderExpenseHint();
}
// 🆕「自行分擔」：自己買自己付錢，單純記一筆帳，不用分攤給任何其他人。
// 直接把「分攤成員」複製成跟「代墊付款人」一模一樣的人跟金額（讀取當下
// payerChips 已填好的值），讓這筆花費的淨額互相抵銷、不會產生任何欠款，
// 但仍然完整記錄在支出清單裡，方便日後查帳。
function selfShareParticipants(){
  const payers = readChipValues('payer');
  if (!payers.length){ toast('請先勾選代墊付款人並輸入金額，再使用「自行分擔」', 'error'); return; }
  const wrap = document.getElementById('participantChips');
  wrap.querySelectorAll('.chip').forEach(chip=>{
    chip.querySelector('input[type=checkbox]').checked = false;
    chip.classList.remove('checked');
    chip.querySelector('.amt').value = '';
  });
  payers.forEach(p=>{
    const chip = wrap.querySelector(`.chip[data-id="${p.userId}"]`);
    if (!chip) return;
    chip.querySelector('input[type=checkbox]').checked = true;
    chip.classList.add('checked');
    chip.querySelector('.amt').value = p.amount;
  });
  participantsDirty = true; // 已手動指定金額，之後改動金額/勾選不要被自動平均覆蓋
  renderExpenseHint();
}
function readChipValues(prefix){
  const wrap = document.getElementById(prefix==='payer'?'payerChips':'participantChips');
  return [...wrap.querySelectorAll('.chip.checked')].map(c=>({
    userId: c.dataset.id,
    amount: parseFloat(c.querySelector('.amt').value) || 0
  }));
}
let expenseLiveRate = null; // { currency, rate, asOf } - 目前解析出的即時匯率
async function refreshExpenseLiveRate(){
  const currency = document.getElementById('expCurrency').value;
  if (currency === trip.baseCurrency){ expenseLiveRate = null; renderExpenseHint(); return; }
  const result = await fetchLiveRate(currency, trip.baseCurrency);
  // 使用者可能在等待期間又切換了幣別，回來時要確認還是同一個才套用
  if (document.getElementById('expCurrency').value !== currency) return;
  if (result){
    expenseLiveRate = { currency, rate: result.rate, asOf: result.asOf };
    trip.rates[currency] = result.rate; // 順便更新手動匯率表，離線時也有個還算新的備援值
  } else {
    expenseLiveRate = null;
  }
  renderExpenseHint();
}
function renderExpenseHint(){
  const amount = parseFloat(document.getElementById('expAmount').value) || 0;
  const currency = document.getElementById('expCurrency').value;
  const customInput = document.getElementById('expAmountInBase');
  const customBase = parseFloat(customInput.value);
  const isForeign = currency !== trip.baseCurrency;
  document.getElementById('expBaseCurrencyLabel').textContent = trip.baseCurrency;
  document.getElementById('expBaseAmountField').hidden = !isForeign;
  let rate, hintHtml;
  if (!isForeign){
    customInput.value = '';
    hintHtml = '';
  } else if (customInput.value.trim() !== ''){
    hintHtml = Number.isFinite(customBase) && customBase > 0
      ? `已採用手動指定的真實金額：<b>${fmtMoney(customBase, trip.baseCurrency)} ${trip.baseCurrency}</b>`
      : `請輸入大於 0 的真實金額，或清空欄位以依匯率自動換算。`;
  } else if (expenseLiveRate && expenseLiveRate.currency === currency){
    rate = expenseLiveRate.rate;
    const base = round2(amount*rate);
    hintHtml = `即時匯率 1 ${currency} = ${rate} ${trip.baseCurrency}，換算約為 <b>${fmtMoney(base, trip.baseCurrency)}</b>`;
  } else {
    rate = trip.rates[currency];
    if (rate){
      const base = round2(amount*rate);
      hintHtml = `⏳ 查詢即時匯率中…暫用手動設定的匯率換算約為 <b>${fmtMoney(base, trip.baseCurrency)}</b>`;
    } else {
      hintHtml = `幣別 ${currency} 尚無匯率，正在查詢即時匯率…若查不到請先到「幣別匯率」分頁手動設定。`;
    }
  }
  document.getElementById('expBaseHint').innerHTML = hintHtml;

  // 若代墊付款人只勾選了一位，金額變動時自動同步到他身上
  const payerWrap = document.getElementById('payerChips');
  if (payerWrap){
    const checkedPayers = [...payerWrap.querySelectorAll('.chip.checked')];
    if (checkedPayers.length === 1 && amount > 0){
      checkedPayers[0].querySelector('.amt').value = amount;
    }
  }
  // 分攤成員：只要使用者還沒手動改過任何一格，金額變動或勾選狀態改變時即時重新平均
  const participantWrap = document.getElementById('participantChips');
  if (participantWrap && !participantsDirty){
    const checkedParticipants = [...participantWrap.querySelectorAll('.chip.checked')].map(c=>c.dataset.id);
    if (checkedParticipants.length && amount > 0){
      const shares = equalSplit(amount, checkedParticipants);
      shares.forEach(s=>{
        const input = participantWrap.querySelector(`.chip[data-id="${s.userId}"] .amt`);
        if (input) input.value = s.amount;
      });
    }
  }
}
document.getElementById('expAmount').addEventListener('input', renderExpenseHint);
document.getElementById('expAmountInBase').addEventListener('input', renderExpenseHint);
document.getElementById('expCurrency').addEventListener('change', ()=>{ document.getElementById('expAmountInBase').value = ''; renderExpenseHint(); refreshExpenseLiveRate(); });

