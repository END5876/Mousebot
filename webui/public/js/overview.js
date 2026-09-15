'use strict';
// 總覽頁：建議轉帳／彼此累計欠款的幣別換算與渲染、淨額長條圖、成員逐筆明細。
/* =====================================================================
   🆕 Overview: 「建議轉帳」與「彼此累計欠款總額」共用的幣別換算邏輯
   ---------------------------------------------------------------------
   兩個區塊行為一致：
   - 清單永遠完整顯示（不收合），每一行金額旁邊直接標示幣別代碼。
   - 卡片內建一列小型「換算幣別」下拉選單（預設＝行程基準幣別，不需額外
     請求），選別的幣別時才即時向 /api/fx-rate 查匯率換算；查不到即時
     匯率則退回行程裡手動設定的匯率，兩者都查不到就維持顯示基準幣別並
     附上提示文字，跟選單同一行顯示。
   - 清單本身（simplifyDebts / calcPairwiseDebts 的計算結果）永遠是用
     「基準幣別」算出來的金額，換算只發生在顯示這一層，不影響背後的
     淨額計算邏輯。
===================================================================== */
let transferDisplayCurrency = null;   // 目前選擇的顯示幣別；預設為 trip.baseCurrency
let pairwiseDisplayCurrency = null;
let lastTransferTx = [];              // 每次 renderAll() 都會依基準幣別重新計算一次
let lastPairwiseDebts = [];

// 🔒 換了一整個行程（匯入 JSON／從 Bot 載入／清空重開）時，上一個行程選過的顯示幣別
// 對新行程來說可能沒有意義（例如新行程根本沒設定那個幣別），這裡重置回「跟著新行程
// 的基準幣別」。
function resetOverviewSectionCurrencyState(){
  transferDisplayCurrency = null;
  pairwiseDisplayCurrency = null;
}

function onTransferCurrencyChange(value){
  transferDisplayCurrency = value;
  renderTransferSectionUI();
}
function onPairwiseCurrencyChange(value){
  pairwiseDisplayCurrency = value;
  renderPairwiseSectionUI();
}

/**
 * 把「基準幣別」的金額換算成目標幣別的匯率倍數：
 *   converted = baseAmount * rate
 * 優先用即時匯率（fetchLiveRate 內部本身有短時間快取），抓不到才退回
 * 行程裡手動設定的匯率；兩者都沒有就回傳 null，由呼叫端自行決定怎麼顯示。
 */
async function resolveDisplayRate(targetCurrency){
  if (targetCurrency === trip.baseCurrency) return 1;
  const live = await fetchLiveRate(trip.baseCurrency, targetCurrency);
  if (live && typeof live.rate === 'number' && live.rate > 0) return live.rate;
  const fallbackRate = trip.rates[targetCurrency]; // 1 target = fallbackRate 基準幣
  if (fallbackRate > 0) return 1 / fallbackRate;
  return null;
}

async function renderTransferSectionUI(){
  const listEl = document.getElementById('settleList');
  const selectEl = document.getElementById('transferCurrencySelect');
  const noteEl = document.getElementById('transferRateNote');
  if (!listEl) return;

  const wantedCurrency = transferDisplayCurrency || trip.baseCurrency;
  if (selectEl) selectEl.innerHTML = currencyOptions(wantedCurrency);

  // effectiveCurrency 代表 displayList 裡的金額「實際上」是用哪個幣別算出來的，
  // 換算失敗時 displayList 會維持基準幣別金額，這裡也要跟著退回基準幣別，
  // 否則畫面會出現「金額還是基準幣別的數字，卻標成使用者選的那個幣別代碼」的錯誤標示。
  let displayList = lastTransferTx;
  let effectiveCurrency = trip.baseCurrency;
  let rateNote = '';
  if (wantedCurrency !== trip.baseCurrency){
    const rate = await resolveDisplayRate(wantedCurrency);
    if (rate){
      displayList = lastTransferTx.map(t => ({ ...t, amount: round2(t.amount * rate) }));
      effectiveCurrency = wantedCurrency;
      rateNote = `依匯率 1 ${trip.baseCurrency} ≈ ${round2(rate)} ${wantedCurrency} 換算，僅供參考。`;
    } else {
      rateNote = `⚠️ 無法取得 ${wantedCurrency} 匯率，暫時仍以 ${trip.baseCurrency} 顯示。`;
    }
  }
  if (noteEl) noteEl.textContent = rateNote;

  listEl.innerHTML = lastTransferTx.length ? displayList.map(t => `
    <div class="settle-item">
      <span>${escapeHtml(memberName(t.from))}</span>
      <span class="settle-arrow">應付給 →</span>
      <span>${escapeHtml(memberName(t.to))}</span>
      <span class="settle-amt">${fmtMoney(t.amount, effectiveCurrency)}<span class="settle-amt-cur">${effectiveCurrency}</span></span>
    </div>`).join('') : '<p class="empty-state" style="padding:16px;">🎉 目前沒有需要結算的款項</p>';
}

async function renderPairwiseSectionUI(){
  const listEl = document.getElementById('pairwiseDebtList');
  const selectEl = document.getElementById('pairwiseCurrencySelect');
  const noteEl = document.getElementById('pairwiseRateNote');
  if (!listEl) return;

  const wantedCurrency = pairwiseDisplayCurrency || trip.baseCurrency;
  if (selectEl) selectEl.innerHTML = currencyOptions(wantedCurrency);

  let displayList = lastPairwiseDebts;
  let effectiveCurrency = trip.baseCurrency;
  let rateNote = '';
  if (wantedCurrency !== trip.baseCurrency){
    const rate = await resolveDisplayRate(wantedCurrency);
    if (rate){
      displayList = lastPairwiseDebts.map(t => ({ ...t, amount: round2(t.amount * rate) }));
      effectiveCurrency = wantedCurrency;
      rateNote = `依匯率 1 ${trip.baseCurrency} ≈ ${round2(rate)} ${wantedCurrency} 換算，僅供參考。`;
    } else {
      rateNote = `⚠️ 無法取得 ${wantedCurrency} 匯率，暫時仍以 ${trip.baseCurrency} 顯示。`;
    }
  }
  if (noteEl) noteEl.textContent = rateNote;

  listEl.innerHTML = lastPairwiseDebts.length ? displayList.map(t => `
    <div class="settle-item">
      <span>${escapeHtml(memberName(t.from))}</span>
      <span class="settle-arrow">欠</span>
      <span>${escapeHtml(memberName(t.to))}</span>
      <span class="settle-amt">${fmtMoney(t.amount, effectiveCurrency)}<span class="settle-amt-cur">${effectiveCurrency}</span></span>
    </div>`).join('') : '<p class="empty-state" style="padding:16px;">🎉 目前彼此之間沒有任何累計欠款</p>';
}

/* =====================================================================
   Overview: 橫向淨額長條圖
===================================================================== */
function renderBalanceBarChart(net) {
  const el = document.getElementById('balanceBarChart');
  if (!el) return;
  if (!trip.members.length) {
    el.innerHTML = emptyState('👥', '尚未新增成員，先到「設定 → 成員」加人吧', '前往新增成員 →',
      "showMainTab('settings'); showSettingsSub('members'); document.getElementById('newMemberName').focus()");
    return;
  }
  // 找最大絕對值，用來計算長條寬度比例
  const vals = trip.members.map(m => round2(net[m.id] || 0));
  const maxAbs = Math.max(...vals.map(v => Math.abs(v)), 0.01);

  el.innerHTML = trip.members.map((m, idx) => {
    const v = vals[idx];
    const pct = Math.min(Math.abs(v) / maxAbs * 46, 46); // 最多佔軌道寬度的 46%（留中線）
    const cls = v > 0.01 ? 'pos' : (v < -0.01 ? 'neg' : 'zero');
    const valLabel = v > 0.01 ? `+${fmtMoney(v, trip.baseCurrency)}`
                   : v < -0.01 ? `${fmtMoney(v, trip.baseCurrency)}`
                   : '結清';
    const barHtml = v > 0.01
      ? `<div class="bar-fill-pos" style="width:${pct}%"></div>`
      : v < -0.01
      ? `<div class="bar-fill-neg" style="width:${pct}%"></div>`
      : `<div class="bar-fill-zero"></div>`;
    return `<div class="bar-row">
      <div class="bar-name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>
      <div class="bar-track">
        <div class="bar-axis"></div>
        ${barHtml}
      </div>
      <div class="bar-val ${cls}">${valLabel} <span style="font-size:9.5px;opacity:.7">${trip.baseCurrency}</span></div>
    </div>`;
  }).join('');
}

/* =====================================================================
   Overview: 每位成員多幣別逐筆明細
   修正紀錄：
   1. transferIn / transferOut 的 amtSign 原本與 summaryRows 矛盾，
      導致「已轉帳結清」的人淨額不減反增，形同債務加倍計算。
      現已對調為：transferIn = -1（減少淨額），transferOut = +1（增加淨額）。
   2. 明細文字「收自／付給」原本耦合在 amtSign 判斷式中，
      對調正負號後文字會跟著錯。現改用獨立參數 isIncoming 控制文字，
      amtSign 只單純代表「對淨額的影響方向」。
   3. 移除未被呼叫的死代碼 fmtOrigAndBase()。
===================================================================== */
function renderMemberDetails(net) {
  const el = document.getElementById('memberDetailList');
  if (!el) return;
  if (!trip.members.length) {
    el.innerHTML = '<p class="hint" style="padding:14px 0 6px;">尚未新增任何成員。</p>';
    return;
  }

  // 計算每位成員的多幣別收支明細
  // 結構：{ memberId: { paid:[{exp,amount,amountInBase}], share:[...], transferIn:[...], transferOut:[...] } }
  function buildMemberLedger() {
    const ledger = {};
    for (const m of trip.members) {
      ledger[m.id] = { paid: [], share: [], transferIn: [], transferOut: [] };
    }
    for (const exp of trip.expenses) {
      // 代墊／分攤本位幣值均使用與淨額計算相同的尾差分配結果。
      for (const p of allocateExpenseBaseAmounts(exp.payers, exp)) {
        if (ledger[p.userId]) {
          ledger[p.userId].paid.push({
            description: exp.description,
            amount: p.amount,
            currency: exp.currency,
            amountInBase: p.amountInBase,
            createdAt: exp.createdAt,
          });
        }
      }
      for (const s of allocateExpenseBaseAmounts(exp.participants, exp)) {
        if (ledger[s.userId]) {
          ledger[s.userId].share.push({
            description: exp.description,
            amount: s.amount,
            currency: exp.currency,
            amountInBase: s.amountInBase,
            createdAt: exp.createdAt,
          });
        }
      }
    }
    for (const d of trip.deposits) {
      // 付款人：付出去（轉帳給收款人）→ 應記錄為轉帳支出 (transferOut)
      if (ledger[d.payerId]) {
        ledger[d.payerId].transferOut.push({
          counterpart: memberName(d.collectorId),
          amount: d.amount,
          currency: d.currency,
          amountInBase: d.amountInBase,
          note: d.note,
          createdAt: d.createdAt,
        });
      }
      // 收款人：收到預付款 → 應記錄為轉帳收入 (transferIn)
      if (ledger[d.collectorId]) {
        ledger[d.collectorId].transferIn.push({
          counterpart: memberName(d.payerId),
          amount: d.amount,
          currency: d.currency,
          amountInBase: d.amountInBase,
          note: d.note,
          createdAt: d.createdAt,
        });
      }
    }
    return ledger;
  }

  // amtSign：僅代表「對淨額的影響方向」（+1 增加淨額 / -1 減少淨額）
  // isIncoming：僅代表「文字顯示為收自 / 付給」，兩者互相獨立，不再耦合
  function renderSection(title, items, tagClass, tagLabel, amtSign, isIncoming) {
    if (!items.length) return '';
    const rows = items.map(item => {
      const desc = item.description
        || (item.counterpart ? `${isIncoming ? '收自' : '付給'} ${escapeHtml(item.counterpart)}` : '');
      const sub = item.note ? `備註：${escapeHtml(item.note)}` : '';
      return `<div class="detail-row">
        <div class="detail-row-left">
          <div class="detail-row-desc">
            <span class="detail-tag ${tagClass}">${tagLabel}</span>${escapeHtml(desc)}
          </div>
          ${sub ? `<div class="detail-row-sub">${sub}</div>` : ''}
        </div>
        <div class="detail-row-amt">
          <div class="orig">${amtSign > 0 ? '+' : '−'}${fmtMoney(item.amount, item.currency)} ${item.currency}</div>
          ${item.currency !== trip.baseCurrency
            ? `<div class="base">≈ ${amtSign > 0 ? '+' : '−'}${fmtMoney(item.amountInBase, trip.baseCurrency)} ${trip.baseCurrency}</div>`
            : ''}
        </div>
      </div>`;
    }).join('');
    return `<div class="detail-section-title">${title}</div>${rows}`;
  }

  const ledger = buildMemberLedger();

  el.innerHTML = trip.members.map(m => {
    const v = round2(net[m.id] || 0);
    const netCls = v > 0.01 ? 'pos' : (v < -0.01 ? 'neg' : 'zero');
    const netLabel = v > 0.01 ? `+${fmtMoney(v, trip.baseCurrency)} ${trip.baseCurrency}`
                   : v < -0.01 ? `${fmtMoney(v, trip.baseCurrency)} ${trip.baseCurrency}`
                   : '已結清';
    const ld = ledger[m.id];
    const hasData = ld.paid.length || ld.share.length || ld.transferIn.length || ld.transferOut.length;

    // ↓↓↓ 修正處：transferIn 改為 -1（收到預付款＝減少淨額，因為原本墊款義務已被抵銷）
    //             transferOut 改為 +1（付出預付款＝增加淨額，等同預先幫忙代墊）
    const paidSection   = renderSection('代墊支出（＋增加淨額）', ld.paid, 'paid', '代墊', 1, false);
    const shareSection  = renderSection('分攤費用（－減少淨額）', ld.share, 'share', '分攤', -1, false);
    const tInSection    = renderSection('預收款／轉帳收入（－減少淨額）', ld.transferIn, 'transfer-in', '收自', -1, true);
    const tOutSection   = renderSection('預付款／轉帳支出（＋增加淨額）', ld.transferOut, 'transfer-out', '付給', 1, false);

    const totalPaid  = round2(ld.paid.reduce((s,x)=>s+x.amountInBase,0));
    const totalShare = round2(ld.share.reduce((s,x)=>s+x.amountInBase,0));
    const totalTIn   = round2(ld.transferIn.reduce((s,x)=>s+x.amountInBase,0));
    const totalTOut  = round2(ld.transferOut.reduce((s,x)=>s+x.amountInBase,0));

    const summaryRows = [
      totalPaid  ? `<div class="detail-summary-row"><span class="label">代墊合計</span><span class="val pos">+${fmtMoney(totalPaid, trip.baseCurrency)} ${trip.baseCurrency}</span></div>` : '',
      totalShare ? `<div class="detail-summary-row"><span class="label">分攤合計</span><span class="val neg">−${fmtMoney(totalShare, trip.baseCurrency)} ${trip.baseCurrency}</span></div>` : '',
      totalTIn   ? `<div class="detail-summary-row"><span class="label">收款合計</span><span class="val neg">−${fmtMoney(totalTIn, trip.baseCurrency)} ${trip.baseCurrency}</span></div>` : '',
      totalTOut  ? `<div class="detail-summary-row"><span class="label">付款合計</span><span class="val pos">+${fmtMoney(totalTOut, trip.baseCurrency)} ${trip.baseCurrency}</span></div>` : '',
    ].filter(Boolean).join('');

    const bodyHtml = hasData
      ? `${paidSection}${shareSection}${tInSection}${tOutSection}
         <div style="border-top:1.5px solid var(--card-line);margin-top:8px;padding-top:4px;">
           ${summaryRows}
           <div class="detail-summary-row" style="border-top:1px dashed var(--card-line);margin-top:4px;padding-top:8px;">
             <span class="label" style="font-weight:700;">淨額</span>
             <span class="val ${netCls}" style="font-size:14px;">${netLabel}</span>
           </div>
         </div>`
      : '<p class="hint" style="padding:8px 0 4px;">尚無任何記帳紀錄。</p>';

    return `<div class="member-detail-card" id="mdc-${m.id}">
      <div class="member-detail-head" onclick="toggleMemberDetail('${m.id}')">
        <div class="member-detail-name">
          <span class="status-dot" style="background:${v>0.01?'var(--credit)':v<-0.01?'var(--debt)':'var(--card-line)'}"></span>
          ${escapeHtml(m.name)}
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="member-detail-net ${netCls}">${netLabel}</span>
          <span class="member-detail-chevron">▼</span>
        </div>
      </div>
      <div class="member-detail-body">${bodyHtml}</div>
    </div>`;
  }).join('');
}

function toggleMemberDetail(memberId) {
  const card = document.getElementById('mdc-' + memberId);
  if (!card) return;
  card.classList.toggle('open');
}

