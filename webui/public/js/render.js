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

// 🆕 [日期分組＋收合明細] 展開/收合單一筆支出／轉帳的詳細內容。
// 直接呼叫 renderAll() 重繪整頁——跟 editExpense() 等既有操作走同一套模式，
// 筆數量級下（數百筆內）效能沒有問題，也不用另外維護局部更新的邏輯。
function toggleExpenseExpand(id){
  if (expandedExpenseIds.has(id)) expandedExpenseIds.delete(id); else expandedExpenseIds.add(id);
  renderAll();
}
function toggleDepositExpand(id){
  if (expandedDepositIds.has(id)) expandedDepositIds.delete(id); else expandedDepositIds.add(id);
  renderAll();
}

// 單筆支出列：收合時只顯示「▸ 說明 + 時間」與金額；展開後才顯示代墊/分攤
// 明細與編輯/刪除按鈕，避免筆數一多，畫面被大量明細撐開難以掃視。
function renderExpenseRow(e){
  const expanded = expandedExpenseIds.has(e.id);
  const detailHtml = expanded ? `
      <div class="ledger-detail">
        <div class="ledger-sub">
          代墊：${e.payers.map(p=>`${escapeHtml(memberName(p.userId))} ${fmtMoney(p.amount,e.currency)}`).join('、')}<br>
          分攤：${e.participants.map(s=>`${escapeHtml(memberName(s.userId))} ${fmtMoney(s.amount,e.currency)}`).join('、')}
        </div>
        <div class="ledger-actions" data-write-only>
          <button class="btn btn-ghost btn-sm" onclick="editExpense('${e.id}')">編輯</button>
          <button class="btn btn-danger btn-sm" onclick="deleteExpense('${e.id}')">刪除</button>
        </div>
      </div>` : '';
  return `
    <div class="ledger-row ledger-row-collapsible">
      <div class="ledger-row-head" onclick="toggleExpenseExpand('${e.id}')">
        <div class="ledger-main">
          <div class="ledger-title"><span class="ledger-toggle-ic">${expanded?'▾':'▸'}</span>${escapeHtml(e.description)}</div>
          <div class="ledger-sub"><span class="ledger-time">${fmtTime(e.createdAt)}</span></div>
        </div>
        <div class="ledger-amt">${fmtMoney(e.amount, e.currency)} <span style="font-size:11px;color:var(--ink-soft);">${e.currency}</span></div>
      </div>
      ${detailHtml}
    </div>`;
}

// 單筆轉帳列：同上邏輯，收合時只留「付款人 → 收款人 + 時間」與金額。
function renderDepositRow(d){
  const expanded = expandedDepositIds.has(d.id);
  const detailHtml = expanded ? `
      <div class="ledger-detail">
        <div class="ledger-sub">${d.note ? escapeHtml(d.note) : '（無備註）'}</div>
        <div class="ledger-actions" data-write-only>
          <button class="btn btn-ghost btn-sm" onclick="editDeposit('${d.id}')">編輯</button>
          <button class="btn btn-danger btn-sm" onclick="deleteDeposit('${d.id}')">刪除</button>
        </div>
      </div>` : '';
  return `
    <div class="ledger-row ledger-row-collapsible">
      <div class="ledger-row-head" onclick="toggleDepositExpand('${d.id}')">
        <div class="ledger-main">
          <div class="ledger-title"><span class="ledger-toggle-ic">${expanded?'▾':'▸'}</span>${escapeHtml(memberName(d.payerId))} → ${escapeHtml(memberName(d.collectorId))}</div>
          <div class="ledger-sub"><span class="ledger-time">${fmtTime(d.createdAt)}</span></div>
        </div>
        <div class="ledger-amt">${fmtMoney(d.amount, d.currency)} <span style="font-size:11px;color:var(--ink-soft);">${d.currency}</span></div>
      </div>
      ${detailHtml}
    </div>`;
}

// 🆕 把一組已排序好的帳目依日期分組渲染成 HTML：每組一個 sticky 風格標題
// （日期 + 該組小計），底下接著該日期所有項目（用 rowRenderer 渲染單筆）。
function renderDateGroupedList(items, rowRenderer){
  const groups = groupItemsByDate(items);
  return groups.map(g=>`
    <div class="ledger-date-group">
      <div class="ledger-date-head">
        <span class="ledger-date-label">${escapeHtml(g.label)}</span>
        <span class="ledger-date-subtotal">${fmtMoney(g.subtotal, trip.baseCurrency)} ${trip.baseCurrency}</span>
      </div>
      ${g.items.map(rowRenderer).join('')}
    </div>`).join('');
}

// 🆕 [篩選／搜尋] 成員篩選改為複選 chip：把成員清單畫成可各自切換的按鈕，
// 沿用帳單辨識既有的 .claim-chip 樣式（開/關兩態視覺語彙一致）。
// toggleFnName 是點擊時要呼叫的全域函式名稱字串（見下方
// toggleExpenseFilterMember/toggleDepositFilterMember）。
function renderFilterMemberChips(selectedIds, toggleFnName){
  if (!trip.members.length) return '';
  return trip.members.map(m=>{
    const on = selectedIds.has(m.id);
    return `<button type="button" class="claim-chip ${on?'on':''}" onclick="${toggleFnName}('${m.id}')">${escapeHtml(m.name)}</button>`;
  }).join('');
}

// 依目前的篩選條件（關鍵字＋複選成員）過濾支出／轉帳清單。
// 成員篩選為「符合任一位已勾選成員」即算命中（OR 邏輯），沒有勾選任何
// 成員時視為不篩選成員。支出的「成員」比對代墊人與分攤人；轉帳的「成員」
// 比對付款人與收款人。
function filterExpenses(list){
  const text = expenseFilterText.trim().toLowerCase();
  const ids = expenseFilterMemberIds;
  return list.filter(e=>{
    if (ids.size && !e.payers.some(p=>ids.has(p.userId)) && !e.participants.some(s=>ids.has(s.userId))) return false;
    if (text && !(e.description||'').toLowerCase().includes(text)) return false;
    return true;
  });
}
function filterDeposits(list){
  const text = depositFilterText.trim().toLowerCase();
  const ids = depositFilterMemberIds;
  return list.filter(d=>{
    if (ids.size && !ids.has(d.payerId) && !ids.has(d.collectorId)) return false;
    if (text && !(d.note||'').toLowerCase().includes(text)) return false;
    return true;
  });
}

// 篩選列輸入變動時呼叫：把 DOM 上的值同步回全域篩選狀態，再重繪整頁。
// 跟 toggleExpenseExpand() 等既有操作一樣直接 renderAll()，篩選文字輸入框
// 本身是 index.html 裡的靜態元素、不會被 renderAll() 的 innerHTML 覆寫，
// 所以重繪不會讓使用者正在打的字或游標位置跑掉。
function onExpenseFilterChange(){
  expenseFilterText = document.getElementById('expenseFilterText').value;
  renderAll();
}
function onDepositFilterChange(){
  depositFilterText = document.getElementById('depositFilterText').value;
  renderAll();
}
// 🆕 成員 chip 點擊：切換該成員是否在篩選集合中，可同時勾選多位。
function toggleExpenseFilterMember(id){
  if (expenseFilterMemberIds.has(id)) expenseFilterMemberIds.delete(id); else expenseFilterMemberIds.add(id);
  renderAll();
}
function toggleDepositFilterMember(id){
  if (depositFilterMemberIds.has(id)) depositFilterMemberIds.delete(id); else depositFilterMemberIds.add(id);
  renderAll();
}
function clearExpenseFilter(){
  expenseFilterText = ''; expenseFilterMemberIds.clear();
  document.getElementById('expenseFilterText').value = '';
  renderAll();
}
function clearDepositFilter(){
  depositFilterText = ''; depositFilterMemberIds.clear();
  document.getElementById('depositFilterText').value = '';
  renderAll();
}
// 🆕 換行程（載入／匯入／清空重開／進入分享模式）時呼叫：清空篩選條件，
// 避免用舊行程篩出來的成員 id、關鍵字誤套用到新行程上。
function resetListFilters(){
  expenseFilterText = ''; expenseFilterMemberIds.clear();
  depositFilterText = ''; depositFilterMemberIds.clear();
  const et = document.getElementById('expenseFilterText'); if (et) et.value = '';
  const dt = document.getElementById('depositFilterText'); if (dt) dt.value = '';
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

  // expense list（🆕 依日期分組＋預設收合明細＋篩選／搜尋）
  {
    document.getElementById('expenseFilterMemberChips').innerHTML = renderFilterMemberChips(expenseFilterMemberIds, 'toggleExpenseFilterMember');
    const allExpenses = trip.expenses.slice().sort((a,b)=>b.createdAt-a.createdAt);
    const filteredExpenses = filterExpenses(allExpenses);
    const filterActive = !!(expenseFilterText.trim() || expenseFilterMemberIds.size);
    document.getElementById('expenseCount').textContent = filterActive
      ? `(${filteredExpenses.length}/${allExpenses.length})`
      : `(${allExpenses.length})`;
    document.getElementById('expenseFilterClearBtn').style.display = filterActive ? '' : 'none';
    document.getElementById('expenseList').innerHTML = filteredExpenses.length
      ? renderDateGroupedList(filteredExpenses, renderExpenseRow)
      : (allExpenses.length
          ? emptyState('🔍', '沒有符合篩選條件的支出', '清除篩選 →', "clearExpenseFilter()")
          : emptyState('🧾', '還沒有任何支出', '新增第一筆 →', "showMainTab('expenses'); document.getElementById('expDesc').focus();"));
  }

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
  {
    document.getElementById('depositFilterMemberChips').innerHTML = renderFilterMemberChips(depositFilterMemberIds, 'toggleDepositFilterMember');
    const allDeposits = trip.deposits.slice().sort((a,b)=>b.createdAt-a.createdAt);
    const filteredDeposits = filterDeposits(allDeposits);
    const filterActive = !!(depositFilterText.trim() || depositFilterMemberIds.size);
    document.getElementById('depositCount').textContent = filterActive
      ? `(${filteredDeposits.length}/${allDeposits.length})`
      : `(${allDeposits.length})`;
    document.getElementById('depositFilterClearBtn').style.display = filterActive ? '' : 'none';
    document.getElementById('depositList').innerHTML = filteredDeposits.length
      ? renderDateGroupedList(filteredDeposits, renderDepositRow)
      : (allDeposits.length
          ? emptyState('🔍', '沒有符合篩選條件的轉帳／預收紀錄', '清除篩選 →', "clearDepositFilter()")
          : emptyState('💸', '還沒有任何轉帳／預收紀錄', '新增第一筆 →', "showMainTab('deposits'); document.getElementById('depPayer').focus();"));
  }

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

  // --- 2. 建議轉帳／彼此累計欠款總額（合併卡片，共用同一個換算幣別；
  //        清單本身永遠先用基準幣別算好，換算只發生在顯示那一層） ---
  lastTransferTx = simplifyDebts(net);
  lastPairwiseDebts = calcPairwiseDebts(trip);
  if (!debtDisplayCurrency) debtDisplayCurrency = trip.baseCurrency;
  renderDebtSectionUI();

  // --- 3. 每位成員多幣別逐筆明細 ---
  renderMemberDetails(net);

  // json preview
  document.getElementById('jsonPreview').value = JSON.stringify(trip, null, 2);
  updateLocalFileStatus();
  scheduleAutoSave();
}

