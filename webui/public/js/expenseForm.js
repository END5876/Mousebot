'use strict';
// 新增支出表單：代墊/分攤 chips、即時匯率提示、自動平均分攤邏輯。
/* ===================== expense chips ===================== */
// 🔧 依需求調整：新增支出時「誰要分攤」不再預設全選所有成員，改成完全空白，
// 由使用者自行勾選要分攤的人。
// 🆕 [個別手動鎖定] 「誰要分攤？」現在套用跟「誰代墊付款？」完全一致的邏輯：
// 只要某一位的金額被使用者手動改過，就只鎖定那一位，剩下還沒被手動改過的人
// 會平均分攤「總金額 - 已手動輸入金額」的差額。不會再因為改了任何一格，
// 就整組停止自動平均；也不會因為新勾選一個人，金額就整包跳到那個人身上。
let participantsDirty = false; // 保留給編輯既有支出時使用：整體凍結自動平均，尊重原始存檔的分攤
// 記錄由使用者親自修改過金額的分攤成員；未列入者由系統平均管理差額。
let participantManualIds = new Set();
// 代墊多人時，記錄由使用者親自修改過金額的成員；未列入者由系統管理差額。
let payerManualIds = new Set();
// 🆕 [成員膠囊重新設計] 統一「勾選/取消勾選一個人」時要連動處理的三件事：
// 原生 checkbox 的 checked 狀態、外層 .chip 的 .checked 樣式 class、
// 金額欄位的 disabled 狀態（取消勾選順便清空金額，避免殘留舊值誤送出）。
// buildChips() 初始渲染、onChipToggle()、checkAllParticipants()、
// selfShareParticipants() 都共用這個函式，避免同一段邏輯散落各處。
function setChipChecked(chip, checked){
  const checkbox = chip.querySelector('.chip-checkbox');
  if (checkbox) checkbox.checked = checked;
  chip.classList.toggle('checked', checked);
  const amt = chip.querySelector('.amt');
  if (amt){
    amt.disabled = !checked;
    if (!checked) amt.value = '';
  }
}
// 🆕 [手動標記視覺化] 同步「這格是手動輸入」的視覺標記（.chip.manual），
// 讓使用者一眼分辨哪些金額是自己打的、哪些是系統自動平分算出來的。
// 凡是會新增/刪除 payerManualIds 或 participantManualIds 內容的地方，
// 呼叫完之後都補呼叫這個函式同步畫面，避免每處各自重複判斷邏輯。
function syncManualMarks(prefix){
  const wrap = document.getElementById(prefix==='payer' ? 'payerChips' : 'participantChips');
  if (!wrap) return;
  const manualIds = prefix==='payer' ? payerManualIds : participantManualIds;
  wrap.querySelectorAll('.chip').forEach(chip=>{
    const isManual = manualIds.has(chip.dataset.id);
    chip.classList.toggle('manual', isManual);
    const amt = chip.querySelector('.amt');
    if (amt) amt.title = isManual ? '已手動輸入，不會被自動平分覆蓋' : '';
  });
}
// 🆕 更新欄位標題列右側的「已選 N 人」計數（見 index.html 的 .field-head
// / .field-meta）。找不到對應元素時安靜略過，不強制要求每個呼叫端都有
// 這段 UI，之後要不要在某個欄位顯示計數，加不加那個 <span> 都不影響邏輯。
function updateChipFieldMeta(containerOrId){
  const container = typeof containerOrId === 'string' ? document.getElementById(containerOrId) : containerOrId;
  if (!container) return;
  const field = container.closest('.field');
  const meta = field && field.querySelector('.field-meta');
  if (!meta) return;
  const n = container.querySelectorAll('.chip.checked').length;
  meta.textContent = `已選 ${n} 人`;
}
function buildChips(containerId, prefix){
  const container = document.getElementById(containerId);
  if (prefix === 'payer') payerManualIds = new Set();
  if (prefix === 'participant') participantManualIds = new Set(); // 🆕 重建 chips 時重置手動標記
  container.innerHTML = trip.members.map(m=>`
    <div class="chip" data-id="${m.id}">
      <label class="chip-main">
        <input type="checkbox" class="chip-checkbox" onchange="onChipToggle('${prefix}','${m.id}',this.checked)">
        <span class="chip-box" aria-hidden="true"></span>
        <span class="chip-label" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</span>
      </label>
      <input type="number" class="amt" inputmode="decimal" step="0.01" min="0"
        aria-label="${escapeHtml(m.name)} 的金額" data-id="${m.id}" disabled
        oninput="${prefix==='payer' ? `onPayerAmountInput('${m.id}')` : `onParticipantAmountInput('${m.id}')`}">
    </div>`).join('') || '<p class="hint">尚未新增成員，請先到「成員」分頁新增。</p>';
  updateChipFieldMeta(container);
  syncManualMarks(prefix); // 🆕 重建後保險起見清掉舊的手動標記樣式（此時集合已重設為空）
}
function onChipToggle(prefix, id, checked){
  const wrap = document.getElementById(prefix==='payer'?'payerChips':'participantChips');
  const chip = wrap.querySelector(`.chip[data-id="${id}"]`);
  if (!chip) return;
  setChipChecked(chip, checked);
  if (prefix === 'payer'){
    // 取消勾選即移除其手動值身分；目前仍勾選、未手動輸入者會重新平均分攤差額。
    if (!checked) payerManualIds.delete(id);
    rebalancePayerAmounts();
  } else if (prefix === 'participant'){
    // 🆕 分攤成員套用相同規則：取消勾選即移除手動身分；
    // 編輯既有支出時（participantsDirty=true）維持原本「不自動改寫」的保護。
    if (!checked) participantManualIds.delete(id);
    if (!participantsDirty) rebalanceParticipantAmounts();
  }
  syncManualMarks(prefix); // 🆕
  updateChipFieldMeta(wrap);
  renderExpenseHint();
}

// 使用者修改代墊金額後，該人的值不再由系統覆寫；其餘未手動輸入者則平均分攤差額。
function onPayerAmountInput(id){
  payerManualIds.add(id);
  rebalancePayerAmounts();
  syncManualMarks('payer'); // 🆕
  renderExpenseHint();
}

// 🆕 分攤成員版本：使用者修改某人的分攤金額後，只鎖定那一位，
// 其餘還沒手動輸入的成員平均分攤剩餘差額（編輯既有支出時不觸發，保留原始資料）。
function onParticipantAmountInput(id){
  participantManualIds.add(id);
  if (!participantsDirty) rebalanceParticipantAmounts();
  syncManualMarks('participant'); // 🆕
  renderExpenseHint();
}

// 差額平均分配給所有「尚未手動輸入」的代墊人，而不是全部塞給最後一位，
// 避免每次新勾選一位成員，金額就整包跳到那個人身上。
function rebalancePayerAmounts(){
  const wrap = document.getElementById('payerChips');
  const total = parseFloat(document.getElementById('expAmount').value);
  if (!wrap || !(total > 0)) return;

  const payers = [...wrap.querySelectorAll('.chip.checked')];
  if (!payers.length) return;

  // 單一代墊者永遠承接全額；此時不需要保留手動拆分狀態。
  if (payers.length === 1){
    payers[0].querySelector('.amt').value = total;
    return;
  }

  const autoPayers = payers.filter(chip => !payerManualIds.has(chip.dataset.id));
  // 所有付款人都已手動輸入時，尊重使用者的值，不再自動改寫。
  if (!autoPayers.length) return;

  const manualTotal = payers
    .filter(chip => payerManualIds.has(chip.dataset.id))
    .reduce((sum, chip) => sum + (parseFloat(chip.querySelector('.amt').value) || 0), 0);

  const remaining = Math.max(0, round2(total - manualTotal));
  const shares = equalSplit(remaining, autoPayers.map(chip => chip.dataset.id));
  shares.forEach(s => {
    const chip = wrap.querySelector(`.chip[data-id="${s.userId}"]`);
    if (chip) chip.querySelector('.amt').value = s.amount;
  });
}

// 🆕 分攤成員版本：與 rebalancePayerAmounts() 邏輯完全一致。
// 差額只平均分配給還沒被手動輸入過的分攤成員，不會整包跳到某一位身上。
function rebalanceParticipantAmounts(){
  const wrap = document.getElementById('participantChips');
  const total = parseFloat(document.getElementById('expAmount').value);
  if (!wrap || !(total > 0)) return;

  const participants = [...wrap.querySelectorAll('.chip.checked')];
  if (!participants.length) return;

  // 只有一位分攤成員時，該人永遠承擔全額。
  if (participants.length === 1){
    participants[0].querySelector('.amt').value = total;
    return;
  }

  const autoParticipants = participants.filter(chip => !participantManualIds.has(chip.dataset.id));
  // 所有分攤成員都已手動輸入時，尊重使用者的值，不再自動改寫。
  if (!autoParticipants.length) return;

  const manualTotal = participants
    .filter(chip => participantManualIds.has(chip.dataset.id))
    .reduce((sum, chip) => sum + (parseFloat(chip.querySelector('.amt').value) || 0), 0);

  const remaining = Math.max(0, round2(total - manualTotal));
  const shares = equalSplit(remaining, autoParticipants.map(chip => chip.dataset.id));
  shares.forEach(s => {
    const chip = wrap.querySelector(`.chip[data-id="${s.userId}"]`);
    if (chip) chip.querySelector('.amt').value = s.amount;
  });
}
function equalFillChips(prefix){
  const wrap = document.getElementById(prefix==='payer'?'payerChips':'participantChips');
  const checked = [...wrap.querySelectorAll('.chip.checked')].map(c=>c.dataset.id);
  const amount = parseFloat(document.getElementById('expAmount').value);
  if (!checked.length){ toast(prefix==='payer'?'請先勾選代墊付款人':'請先勾選分攤成員', 'error'); return; }
  if (!(amount>0)){ toast('請先輸入金額', 'error'); return; }
  if (prefix === 'participant'){
    participantsDirty = false;
    participantManualIds = new Set(); // 🆕 點「平均分配」代表全部重設為自動，清空個別手動標記
  }
  if (prefix === 'payer'){
    payerManualIds = new Set(); // 🆕 同步修正：點「平均分配」也應清空代墊人的手動標記
  }
  syncManualMarks(prefix); // 🆕
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
    setChipChecked(chip, true);
  });
  participantsDirty = false;
  participantManualIds = new Set(); // 🆕 全選視為重新平均分配，清空所有手動標記
  syncManualMarks('participant'); // 🆕
  if (amount > 0){
    const shares = equalSplit(amount, allIds);
    shares.forEach(s=>{
      const input = wrap.querySelector(`.chip[data-id="${s.userId}"] .amt`);
      if (input) input.value = s.amount;
    });
  }
  updateChipFieldMeta(wrap);
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
    setChipChecked(chip, false);
  });
  payers.forEach(p=>{
    const chip = wrap.querySelector(`.chip[data-id="${p.userId}"]`);
    if (!chip) return;
    setChipChecked(chip, true);
    chip.querySelector('.amt').value = p.amount;
  });
  participantsDirty = true; // 已手動指定金額，之後改動金額/勾選不要被自動平均覆蓋
  participantManualIds = new Set(payers.map(p=>p.userId)); // 🆕 同步標記為手動金額，維持與代墊付款人一致的鎖定邏輯
  syncManualMarks('participant'); // 🆕
  updateChipFieldMeta(wrap);
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
      hintHtml = `幣別 ${currency} 尚無匯率資料，正在查詢即時匯率…如果查不到，請到「設定 → 匯率」分頁手動新增。`;
    }
  }
  document.getElementById('expBaseHint').innerHTML = hintHtml;

  // 代墊者有尚未手動輸入的金額時，將總額差額平均分配給這些人。
  rebalancePayerAmounts();
  // 🆕 分攤成員：套用相同規則。編輯既有支出時（participantsDirty=true）
  // 完全不自動改寫，尊重原始存檔的分攤金額；新增支出時則平均分配差額
  // 給所有尚未手動輸入過金額的分攤成員。
  if (!participantsDirty){
    rebalanceParticipantAmounts();
  }
}
document.getElementById('expAmount').addEventListener('input', renderExpenseHint);
document.getElementById('expAmountInBase').addEventListener('input', renderExpenseHint);
document.getElementById('expCurrency').addEventListener('change', ()=>{ document.getElementById('expAmountInBase').value = ''; renderExpenseHint(); refreshExpenseLiveRate(); });
