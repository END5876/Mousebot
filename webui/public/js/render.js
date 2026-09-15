'use strict';
// renderAll()：把目前 trip 狀態重繪到整個頁面各個區塊。
/* ===================== render ===================== */
function renderDepositSelects(){
  const opts = trip.members.map(m=>`<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
  const prevPayer = document.getElementById('depPayer').value;
  const prevCollector = document.getElementById('depCollector').value;
  const prevCurrency = document.getElementById('depCurrency').value || trip.baseCurrency;
  document.getElementById('depPayer').innerHTML = '<option value="">請選擇</option>' + opts;
  document.getElementById('depCollector').innerHTML = '<option value="">請選擇</option>' + opts;
  document.getElementById('depCurrency').innerHTML = currencyOptions(prevCurrency);
  if (prevPayer && trip.members.some(m=>m.id===prevPayer)) document.getElementById('depPayer').value = prevPayer;
  if (prevCollector && trip.members.some(m=>m.id===prevCollector)) document.getElementById('depCollector').value = prevCollector;
}
function emptyState(icon, text, ctaLabel, ctaOnclick){
  return `<div class="empty-state">
    <div class="ic">${icon}</div>
    <p>${escapeHtml(text)}</p>
    ${ctaLabel ? `<button class="btn btn-ghost btn-sm" onclick="${ctaOnclick}">${escapeHtml(ctaLabel)}</button>` : ''}
  </div>`;
}

function renderAll(){
  // cover
  document.getElementById('tripName').value = trip.name;
  document.getElementById('tripId').value = trip.id;
  document.getElementById('baseCurrency').innerHTML = currencyOptions(trip.baseCurrency);
  document.getElementById('baseLabel').textContent = trip.baseCurrency;

  // members tab
  document.getElementById('memberCount').textContent = `(${trip.members.length})`;
  document.getElementById('memberList').innerHTML = trip.members.map(m=>`
    <div class="member-tag">
      <span class="dot"></span>
      <input type="text" value="${escapeHtml(m.name)}" onchange="renameMember('${m.id}', this.value)">
      <button class="btn btn-danger btn-sm" onclick="removeMember('${m.id}')">刪除</button>
    </div>`).join('') || emptyState('👥', '尚未新增任何成員', '新增第一位成員 →', "document.getElementById('newMemberName').focus()");

  // rates tab
  document.getElementById('rateTableBody').innerHTML = Object.entries(trip.rates).sort().map(([code,rate])=>`
    <tr>
      <td data-label="幣別"><b>${code}</b>${code===trip.baseCurrency?' <span class="hint">（基準）</span>':''}</td>
      <td data-label="匯率"><input type="number" inputmode="decimal" step="0.0001" value="${rate}" ${code===trip.baseCurrency?'disabled':''} onchange="updateRate('${code}', this.value)"></td>
      <td data-label="">${code===trip.baseCurrency?'':`<button class="btn btn-danger btn-sm" onclick="removeRate('${code}')">刪除</button>`}</td>
    </tr>`).join('');

  // expense form selects
  const curSel = document.getElementById('expCurrency');
  const prevCur = curSel.value || trip.baseCurrency;
  curSel.innerHTML = currencyOptions(prevCur);
  if (!hasUnsavedExpenseFormContent()) { buildChips('payerChips','payer'); buildChips('participantChips','participant'); }
  renderExpenseHint();

  // expense list
  document.getElementById('expenseCount').textContent = `(${trip.expenses.length})`;
  document.getElementById('expenseList').innerHTML = trip.expenses.slice().sort((a,b)=>b.createdAt-a.createdAt).map(e=>`
    <div class="ledger-row">
      <div class="ledger-main">
        <div class="ledger-title">${escapeHtml(e.description)}</div>
        <div class="ledger-sub">
          <span class="ledger-time">${fmtDateTime(e.createdAt)}</span><br>
          代墊：${e.payers.map(p=>`${escapeHtml(memberName(p.userId))} ${fmtMoney(p.amount,e.currency)}`).join('、')}<br>
          分攤：${e.participants.map(s=>`${escapeHtml(memberName(s.userId))} ${fmtMoney(s.amount,e.currency)}`).join('、')}
        </div>
        <div class="ledger-actions" data-write-only>
          <button class="btn btn-ghost btn-sm" onclick="editExpense('${e.id}')">編輯</button>
          <button class="btn btn-danger btn-sm" onclick="deleteExpense('${e.id}')">刪除</button>
        </div>
      </div>
      <div class="ledger-amt">${fmtMoney(e.amount, e.currency)} <span style="font-size:11px;color:var(--ink-soft);">${e.currency}</span></div>
    </div>`).join('') || emptyState('🧾', '還沒有任何支出', '新增第一筆 →', "showMainTab('expenses'); document.getElementById('expDesc').focus();");

  // deposit form selects
  renderDepositSelects();
  if (editingDepositId){
    const dep = trip.deposits.find(d=>d.id===editingDepositId);
    if (dep){
      document.getElementById('depPayer').value = dep.payerId;
      document.getElementById('depCollector').value = dep.collectorId;
      document.getElementById('depCurrency').innerHTML = currencyOptions(dep.currency);
    }
  }
  document.getElementById('depositCount').textContent = `(${trip.deposits.length})`;
  document.getElementById('depositList').innerHTML = trip.deposits.slice().sort((a,b)=>b.createdAt-a.createdAt).map(d=>`
    <div class="ledger-row">
      <div class="ledger-main">
        <div class="ledger-title">${escapeHtml(memberName(d.payerId))} → ${escapeHtml(memberName(d.collectorId))}</div>
        <div class="ledger-sub">
          <span class="ledger-time">${fmtDateTime(d.createdAt)}</span><br>
          ${d.note ? escapeHtml(d.note) : '（無備註）'}
        </div>
        <div class="ledger-actions" data-write-only>
          <button class="btn btn-ghost btn-sm" onclick="editDeposit('${d.id}')">編輯</button>
          <button class="btn btn-danger btn-sm" onclick="deleteDeposit('${d.id}')">刪除</button>
        </div>
      </div>
      <div class="ledger-amt">${fmtMoney(d.amount, d.currency)} <span style="font-size:11px;color:var(--ink-soft);">${d.currency}</span></div>
    </div>`).join('') || emptyState('💸', '還沒有任何轉帳／預收紀錄', '新增第一筆 →', "showMainTab('deposits'); document.getElementById('depPayer').focus();");

  // overview
  document.getElementById('kvMembers').textContent = trip.members.length;
  document.getElementById('kvExpenses').textContent = trip.expenses.length;
  document.getElementById('kvDeposits').textContent = trip.deposits.length;
  const totalBase = round2(trip.expenses.reduce((s,e)=>s+e.amountInBase,0));
  document.getElementById('kvTotal').textContent = fmtMoney(totalBase, trip.baseCurrency);

  const net = calcNetBalances(trip);

  // --- 1. 橫向長條圖 ---
  renderBalanceBarChart(net);

  const allSettled = trip.members.length>0 && trip.members.every(m=>Math.abs(net[m.id]||0)<=0.01);
  const stamp = document.getElementById('stampBadge');
  stamp.textContent = allSettled ? '已結清' : '待結算';
  stamp.classList.toggle('settled', allSettled);

  // --- 2. 建議轉帳（可換算幣別；清單本身永遠先用基準幣別算好） ---
  lastTransferTx = simplifyDebts(net);
  if (!transferDisplayCurrency) transferDisplayCurrency = trip.baseCurrency;
  renderTransferSectionUI();

  // --- 3. 每位成員多幣別逐筆明細 ---
  renderMemberDetails(net);

  // --- 4. 彼此累計欠款總額（非最少筆數簡化版；同樣可換算幣別） ---
  lastPairwiseDebts = calcPairwiseDebts(trip);
  if (!pairwiseDisplayCurrency) pairwiseDisplayCurrency = trip.baseCurrency;
  renderPairwiseSectionUI();

  // json preview
  document.getElementById('jsonPreview').value = JSON.stringify(trip, null, 2);
  updateLocalFileStatus();
  scheduleAutoSave();
}

