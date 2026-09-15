'use strict';
// 帳單照片辨識流程：上傳、草稿保存、逐項認領、依認領結果建立支出。
/* =====================================================================
   帳單照片辨識 — 上傳照片 → 伺服器呼叫 Claude 辨識品項 → 逐項認領 →
   一鍵生成一筆支出（participants 用計算出的自訂金額，不是均分）。
===================================================================== */
let receiptState = null; // { imageDataUrl, items:[{id,name,price,type,assignedTo:'shared'|string[]}] }

// 🆕 [資料遺失保護] 帳單認領進度草稿：整個認領流程（上傳照片辨識 → 逐項認領 →
// 建立支出）往往要花一段時間，過程中若使用者不小心重新整理頁面、或分頁被
// 系統／瀏覽器關閉，receiptState 只存在記憶體裡會直接整個消失，得重新掃描
// 一次。這裡改成每隔幾秒把目前的進度存一份到 sessionStorage（分頁關閉才會
// 清除，重新整理不受影響），下次載入行程時偵測到屬於「同一個行程」的草稿，
// 就詢問使用者要不要復原。
const RECEIPT_DRAFT_STORAGE_KEY = 'splitbill-receipt-draft';
let receiptDraftDirty = false;       // 自從上次寫入 sessionStorage 後，內容是否有變動過
let receiptDraftPromptShown = false; // 這次頁面載入期間，是否已經詢問過使用者一次

function persistReceiptDraft(){
  try{
    if (!receiptState){
      sessionStorage.removeItem(RECEIPT_DRAFT_STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(RECEIPT_DRAFT_STORAGE_KEY, JSON.stringify({
      tripId: trip.id,
      savedAt: Date.now(),
      receiptState,
    }));
  }catch(e){
    // sessionStorage 已滿、或瀏覽器隱私模式下不可用：安靜放棄即可，
    // 不應該讓「草稿備份」這種錦上添花的功能擋住使用者正常的認領流程。
  }
}
function clearReceiptDraft(){
  try{ sessionStorage.removeItem(RECEIPT_DRAFT_STORAGE_KEY); }catch(e){}
}

// 每 3 秒檢查一次：只要認領進度有變動（receiptDraftDirty），就寫一份新的
// 草稿進去；沒有變動就不做事，避免不必要的重複寫入。
setInterval(() => {
  if (receiptDraftDirty){
    persistReceiptDraft();
    receiptDraftDirty = false;
  }
}, 3000);

// 行程載入完成後呼叫（擁有者／分享連結模式都適用）：若偵測到 sessionStorage
// 裡有屬於「這個行程」的認領草稿，詢問使用者要不要復原繼續認領。
// 整個頁面載入期間只會詢問一次，避免使用者按「不用了」之後每次重繪都被再問。
async function maybeOfferReceiptDraftRestore(){
  if (receiptDraftPromptShown) return;
  let raw = null;
  try{ raw = sessionStorage.getItem(RECEIPT_DRAFT_STORAGE_KEY); }catch(e){}
  if (!raw) return;

  let draft;
  try{ draft = JSON.parse(raw); }catch(e){ clearReceiptDraft(); return; }

  // 草稿是屬於別的行程留下的（例如上次瀏覽的是另一個行程），先不理會、
  // 也不主動清掉——真的切回那個行程時還是可能用得到，不用急著丟棄。
  if (!draft || draft.tripId !== trip.id) return;

  const itemCount = draft.receiptState && Array.isArray(draft.receiptState.items) ? draft.receiptState.items.length : 0;
  if (!itemCount){ clearReceiptDraft(); return; }

  receiptDraftPromptShown = true;
  const restore = await confirmModal(
    `偵測到上次離開時，有一筆帳單辨識的認領還沒完成（${itemCount} 個項目）。要復原繼續認領嗎？`,
    { title: '復原上次的認領進度？', confirmText: '復原', cancelText: '不用了，重新開始' }
  );

  if (restore){
    receiptState = draft.receiptState;
    showMainTab('expenses');
    renderReceiptWorkArea();
    toast('已復原上次的認領進度', 'success');
  } else {
    clearReceiptDraft();
  }
}

// 把上傳的圖片縮小＋轉成 JPEG，避免原始照片太大，上傳慢、也浪費辨識費用
async function fileToResizedDataUrl(file, maxDim, quality){
  maxDim = maxDim || 1600; quality = quality || 0.85;
  const objUrl = URL.createObjectURL(file);
  try{
    const img = await new Promise((resolve, reject)=>{
      const im = new Image();
      im.onload = ()=>resolve(im);
      im.onerror = ()=>reject(new Error('圖片讀取失敗'));
      im.src = objUrl;
    });
    let { width, height } = img;
    if (Math.max(width, height) > maxDim){
      const scale = maxDim / Math.max(width, height);
      width = Math.round(width*scale); height = Math.round(height*scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

async function handleReceiptUpload(evt){
  const file = evt.target.files[0];
  evt.target.value = ''; // 允許之後重新選同一個檔案也能觸發 change
  if (!file) return;
  if (!file.type.startsWith('image/')){ toast('請上傳圖片檔案', 'error'); return; }

  const uploadZone = document.getElementById('receiptUploadZone');
  const original = uploadZone.innerHTML;
  uploadZone.innerHTML = `<div class="receipt-upload" style="cursor:default;"><span class="spinner" style="border-color:var(--card-line); border-top-color:var(--ink); margin:0 auto 8px; display:block;"></span>辨識中，請稍候…</div>`;

  try{
    const dataUrl = await fileToResizedDataUrl(file);
    const base64 = dataUrl.split(',')[1];
    const res = await fetch(apiBaseUrl() + '/api/parse-receipt', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeadersAny()),
      body: JSON.stringify({ image: base64, mediaType: 'image/jpeg' })
    });
    const body = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    const rate = typeof body.serviceChargeRate === 'number' ? body.serviceChargeRate : 0;
    // 服務費是加成在「餐點」品項上（不含訂金等雜費），所以在這裡就直接把服務費算進每個
    // 品項的價格裡；之後不管這個品項是被個人認領、還是丟進共同分擔，用的都已經是含服務費的金額。
    // basePrice 永遠保留「服務費前」的原始金額，這樣之後如果手動修正服務費比例，能重新算過。
    const items = (body.items || []).map(it => {
      const isItem = it.type !== 'fee';
      const finalPrice = isItem ? round2(it.price * (1 + rate)) : it.price;
      return {
        id: genId('ritem'),
        name: it.name,
        // 🆕 語言辨識 + 翻譯：品項名稱的繁體中文翻譯（原文若本來就是中文則為空字串）。
        nameTranslated: it.nameTranslated || '',
        basePrice: it.price,
        price: finalPrice,
        priceOverridden: false, // 使用者手動改過金額後會變 true，之後調整服務費比例就不會再覆蓋這筆
        type: it.type,
        assignedTo: it.type === 'fee' ? 'shared' : [], // 服務費/訂金等雜費自動歸入共同分擔
      };
    });
    if (!items.length){
      toast('沒有辨識出任何品項，請確認照片清楚、光線充足，或改用「新增一筆支出」手動輸入', 'error');
      uploadZone.innerHTML = original;
      return;
    }
    receiptState = {
      imageDataUrl: dataUrl,
      items,
      serviceChargeRate: rate,
      detectedCurrency: body.currency || null,
      // 🆕 語言辨識：帳單主要文字語言（例如「日文」），純粹用來在畫面上提示「已附上翻譯」。
      detectedLanguage: body.language || '',
      attendeeIds: trip.members.map(m=>m.id), // 預設全員出席，可取消勾選
      description: '',
      payerId: null,
      currency: null,
    };
    const rateNote = rate > 0 ? `，已自動加上 ${Math.round(rate*10000)/100}% 服務費` : '';
    const hasTranslation = items.some(it => it.nameTranslated);
    const langNote = hasTranslation && receiptState.detectedLanguage
      ? `，偵測到帳單為${receiptState.detectedLanguage}，已附上繁中翻譯`
      : '';
    toast(`辨識出 ${items.length} 個項目${rateNote}${langNote}，請逐項認領`, 'success');
    renderReceiptWorkArea();
    persistReceiptDraft(); // 🆕 剛辨識完的基礎資料（含圖片）先立刻存一份，不等下一次週期性儲存
  }catch(err){
    toast('辨識失敗：' + err.message, 'error');
    uploadZone.innerHTML = original;
  }
}

function receiptResetUpload(){
  receiptState = null;
  clearReceiptDraft(); // 🆕 認領已放棄或已完成，清掉暫存草稿，避免下次重整又跳出復原提示
  receiptDraftDirty = false;
  document.getElementById('receiptWorkArea').style.display = 'none';
  document.getElementById('receiptWorkArea').innerHTML = '';
  document.getElementById('receiptUploadZone').style.display = '';
  document.getElementById('receiptUploadZone').innerHTML = `
    <label class="receipt-upload" for="receiptFileInput">
      <div class="ic">🧾</div>
      <div>點這裡上傳帳單照片（或用手機拍照）</div>
      <input type="file" id="receiptFileInput" accept="image/*" onchange="handleReceiptUpload(event)">
    </label>`;
}

function receiptToggleAttendee(memberId){
  const idx = receiptState.attendeeIds.indexOf(memberId);
  if (idx > -1) receiptState.attendeeIds.splice(idx,1);
  else receiptState.attendeeIds.push(memberId);
  renderReceiptWorkArea();
}
function receiptToggleClaim(itemId, memberId){
  const item = receiptState.items.find(i=>i.id===itemId);
  if (!Array.isArray(item.assignedTo)) item.assignedTo = [];
  const idx = item.assignedTo.indexOf(memberId);
  if (idx > -1) item.assignedTo.splice(idx,1);
  else item.assignedTo.push(memberId);
  renderReceiptWorkArea();
}
function receiptSetShared(itemId){
  const item = receiptState.items.find(i=>i.id===itemId);
  item.assignedTo = (item.assignedTo === 'shared') ? [] : 'shared';
  renderReceiptWorkArea();
}
function receiptUpdateField(itemId, field, value){
  const item = receiptState.items.find(i=>i.id===itemId);
  if (field === 'price'){ item.price = parseFloat(value) || 0; item.priceOverridden = true; } // 使用者接手了，不再自動套用服務費比例
  else if (field === 'name'){ item.name = value; item.nameTranslated = ''; } // 名稱被手動改過，AI 原本的翻譯已經對不上，直接清空避免顯示過時翻譯
  renderReceiptWorkArea(); // 完整重繪，讓「已含服務費」提示能正確消失/更新
}
function receiptRemoveItem(itemId){
  receiptState.items = receiptState.items.filter(i=>i.id!==itemId);
  renderReceiptWorkArea();
}
// 手動新增一個辨識漏掉的品項
function receiptAddManualItem(){
  receiptState.items.push({
    id: genId('ritem'),
    name: '',
    nameTranslated: '', // 手動新增的項目沒有 AI 翻譯可用
    basePrice: 0,
    price: 0,
    priceOverridden: true, // 手動輸入的金額不受服務費比例調整影響
    type: 'item',
    assignedTo: [],
  });
  renderReceiptWorkArea();
  const rows = document.querySelectorAll('#receiptWorkArea .receipt-item-head input[type=text]');
  if (rows.length) rows[rows.length-1].focus();
}
// 品項／雜費分類點錯了可以直接切換
function receiptToggleItemType(itemId){
  const item = receiptState.items.find(i=>i.id===itemId);
  item.type = item.type === 'fee' ? 'item' : 'fee';
  if (item.type === 'fee'){
    item.assignedTo = 'shared'; // 雜費預設共同分擔
  } else {
    item.assignedTo = [];
    if (!item.priceOverridden && receiptState.serviceChargeRate > 0){
      item.price = round2(item.basePrice * (1 + receiptState.serviceChargeRate));
    }
  }
  renderReceiptWorkArea();
}
// 服務費比例辨識錯誤時可以手動修正；還沒被手動改過金額的品項會依新比例重新計算
function receiptUpdateServiceChargeRate(value){
  let rate = parseFloat(value);
  if (!Number.isFinite(rate) || rate < 0) rate = 0;
  rate = round2(rate) / 100; // 輸入框是百分比（例如打 10 代表 10%）
  receiptState.serviceChargeRate = rate;
  receiptState.items.forEach(item=>{
    if (item.type === 'item' && !item.priceOverridden){
      item.price = round2(item.basePrice * (1 + rate));
    }
  });
  renderReceiptWorkArea();
}

// 核心分帳邏輯：個別認領的品項均分給認領人；「共同分擔」（含自動歸類的服務費/訂金）
// 加總後，再平均分給所有出席者。回傳 {memberId: 金額}，加總會精確等於總金額。
function computeReceiptSplit(items, attendeeIds){
  const perPerson = {};
  attendeeIds.forEach(id => perPerson[id] = 0);
  let sharedTotal = 0;
  for (const item of items){
    if (item.assignedTo === 'shared' || !Array.isArray(item.assignedTo) || item.assignedTo.length === 0){
      sharedTotal = round2(sharedTotal + item.price);
    } else {
      const shares = equalSplit(item.price, item.assignedTo);
      shares.forEach(s=>{ if (perPerson[s.userId] !== undefined) perPerson[s.userId] = round2(perPerson[s.userId] + s.amount); });
    }
  }
  if (attendeeIds.length && sharedTotal !== 0){
    const shares = equalSplit(sharedTotal, attendeeIds);
    shares.forEach(s=>{ perPerson[s.userId] = round2(perPerson[s.userId] + s.amount); });
  }
  return perPerson;
}

function buildReceiptSummaryHtml(){
  const items = receiptState.items;
  const grandTotal = round2(items.reduce((s,i)=>s+i.price,0));
  const unclaimedCount = items.filter(i => i.assignedTo !== 'shared' && (!Array.isArray(i.assignedTo) || i.assignedTo.length===0)).length;
  const perPerson = computeReceiptSplit(items, receiptState.attendeeIds);
  const rows = receiptState.attendeeIds.map(id=>`
    <div class="receipt-summary-row"><span>${escapeHtml(memberName(id))}</span><span>${fmtMoney(perPerson[id]||0, trip.baseCurrency)}</span></div>
  `).join('');
  return `<div class="receipt-summary" id="receiptSummaryBox">
    ${rows}
    <div class="receipt-summary-row total"><span>總金額</span><span>${fmtMoney(grandTotal, trip.baseCurrency)}</span></div>
    ${unclaimedCount ? `<p class="hint" style="color:var(--debt);">⚠️ 還有 ${unclaimedCount} 個項目尚未認領</p>` : ''}
  </div>`;
}

function renderReceiptWorkArea(){
  receiptDraftDirty = true; // 🆕 內容有變動，交給週期性儲存在下一輪把最新草稿寫進 sessionStorage
  document.getElementById('receiptUploadZone').style.display = 'none';
  const area = document.getElementById('receiptWorkArea');
  area.style.display = 'block';

  const memberChipsHtml = (item)=> trip.members.map(m=>{
    const on = Array.isArray(item.assignedTo) && item.assignedTo.includes(m.id);
    return `<button type="button" class="claim-chip ${on?'on':''}" onclick="receiptToggleClaim('${item.id}','${m.id}')">${escapeHtml(m.name)}</button>`;
  }).join('');

  const itemsHtml = receiptState.items.map(item=>{
    const isShared = item.assignedTo === 'shared';
    const unclaimed = !isShared && (!Array.isArray(item.assignedTo) || item.assignedTo.length===0);
    const showServiceHint = item.type==='item' && !item.priceOverridden && receiptState.serviceChargeRate > 0;
    const serviceChargeHint = showServiceHint
      ? `<p class="hint" style="margin-top:6px;">已含 ${Math.round(receiptState.serviceChargeRate*10000)/100}% 服務費（原價 ${fmtMoney(item.basePrice, receiptState.detectedCurrency||trip.baseCurrency)}）</p>`
      : '';
    // 🆕 語言辨識 + 翻譯：品項名稱若有繁中翻譯（代表帳單原文不是中文），
    // 在輸入框下方附上一行「原文＋翻譯」同時顯示，方便核對辨識是否正確。
    const translationHint = item.nameTranslated
      ? `<p class="hint" style="margin-top:6px;">🌐 翻譯：<b>${escapeHtml(item.nameTranslated)}</b></p>`
      : '';
    return `
    <div class="receipt-item-row ${item.type==='fee'?'fee':''} ${unclaimed?'unclaimed':''}">
      <div class="receipt-item-head">
        <button type="button" class="receipt-type-badge ${item.type==='fee'?'fee':''}" onclick="receiptToggleItemType('${item.id}')" title="點一下切換品項／雜費分類">${item.type==='fee'?'雜費':'品項'} ⇄</button>
        <input type="text" value="${escapeHtml(item.name)}" placeholder="品項名稱" onchange="receiptUpdateField('${item.id}','name',this.value)">
        <input type="number" inputmode="decimal" class="num amt-input" value="${item.price}" step="0.01" onchange="receiptUpdateField('${item.id}','price',this.value)">
        <button type="button" class="btn btn-ghost btn-sm" onclick="receiptRemoveItem('${item.id}')" title="刪除這個項目">✕</button>
      </div>
      ${translationHint}
      <div class="receipt-claim-chips">
        ${memberChipsHtml(item)}
        <button type="button" class="claim-chip shared ${isShared?'on':''}" onclick="receiptSetShared('${item.id}')">🤝 共同分擔</button>
      </div>
      ${serviceChargeHint}
      ${unclaimed ? '<p class="hint" style="color:var(--debt); margin-top:6px;">尚未認領——請點選人名或「共同分擔」</p>' : ''}
    </div>`;
  }).join('');

  const attendeeChipsHtml = trip.members.map(m=>{
    const on = receiptState.attendeeIds.includes(m.id);
    return `<button type="button" class="claim-chip ${on?'on':''}" onclick="receiptToggleAttendee('${m.id}')">${escapeHtml(m.name)}</button>`;
  }).join('');

  const detectedCur = receiptState.detectedCurrency;
  const curInTrip = detectedCur && trip.rates[detectedCur];
  const defaultCur = receiptState.currency || (curInTrip ? detectedCur : trip.baseCurrency);
  const currencyHint = (detectedCur && !curInTrip)
    ? `<p class="hint" style="color:var(--debt);">偵測到帳單可能是 <b>${detectedCur}</b>，但行程裡還沒有這個幣別的匯率，請先到「設定 → 匯率」新增，否則下面無法選擇它。</p>`
    : (detectedCur ? `<p class="hint">已自動選擇偵測到的幣別 ${detectedCur}，辨識錯了可以在下面自行改選。</p>` : '');

  const payerOptions = trip.members.map(m=>`<option value="${m.id}" ${receiptState.payerId===m.id?'selected':''}>${escapeHtml(m.name)}</option>`).join('');

  area.innerHTML = `
    <div class="receipt-preview-row">
      <img class="receipt-thumb" src="${receiptState.imageDataUrl}" alt="帳單照片預覽">
      <div style="flex:1;">
        <p class="hint" style="margin-top:0;">共 ${receiptState.items.length} 個項目。點選品項下方的人名即可認領（可多選＝一起分攤這項），服務費與訂金已自動歸入「共同分擔」。辨識錯誤都可以直接修改，或用下方「新增項目」補上漏掉的品項。${receiptState.items.some(it => it.nameTranslated) ? `<br>🌐 偵測到帳單為<b>${escapeHtml(receiptState.detectedLanguage)}</b>，品項下方已附上繁體中文翻譯供核對。` : ''}</p>
        <button type="button" class="btn btn-ghost btn-sm" onclick="receiptResetUpload()">🔄 重新上傳照片</button>
      </div>
    </div>

    <div class="row">
      <div class="field" style="max-width:160px;">
        <label>服務費 %（辨識錯了可修正）</label>
        <input type="number" inputmode="decimal" step="0.1" min="0" value="${Math.round(receiptState.serviceChargeRate*10000)/100}" onchange="receiptUpdateServiceChargeRate(this.value)">
      </div>
    </div>
    <p class="hint" style="margin-top:-6px;">調整比例會自動套用到所有尚未手動改過金額的「品項」；雜費（如訂金）不受影響，已手動改過金額的品項也不會被覆寫。</p>

    <div class="field">
      <label>這頓誰有出席？（決定「共同分擔」要平均分給誰）</label>
      <div class="chip-select">${attendeeChipsHtml}</div>
    </div>

    <h2 class="section-title" style="font-size:14.5px; margin-top:16px;">品項認領</h2>
    ${itemsHtml}
    <div class="btn-row">
      <button type="button" class="btn btn-ghost btn-sm" onclick="receiptAddManualItem()">＋ 新增一個項目（辨識漏掉的）</button>
    </div>

    ${buildReceiptSummaryHtml()}

    <div class="field" style="margin-top:14px;">
      <label>項目說明</label>
      <input type="text" id="receiptDesc" placeholder="例如：聚餐晚餐" value="${escapeHtml(receiptState.description||'')}" oninput="receiptState.description=this.value">
    </div>
    <div class="row">
      <div class="field">
        <label>誰墊付這筆帳單？</label>
        <select id="receiptPayer" onchange="receiptState.payerId=this.value">${payerOptions}</select>
      </div>
      <div class="field" style="max-width:130px;">
        <label>幣別</label>
        <select id="receiptCurrency" onchange="receiptState.currency=this.value">${currencyOptions(defaultCur)}</select>
      </div>
    </div>
    ${currencyHint}
    <div class="btn-row">
      <button class="btn btn-brass btn-block" onclick="withLoading(this,'儲存中…',finalizeReceiptExpense)">建立這筆支出</button>
    </div>`;
}

async function finalizeReceiptExpense(){
  // 手動新增後忘記填寫、金額還是 0 又沒填名稱的空白列，視為放棄該列，直接忽略不擋結算
  receiptState.items = receiptState.items.filter(i => i.name.trim() || i.price !== 0);
  const items = receiptState.items;
  if (!items.length){ toast('沒有任何品項可以結算', 'error'); return; }
  const unclaimed = items.filter(i => i.assignedTo !== 'shared' && (!Array.isArray(i.assignedTo) || i.assignedTo.length===0));
  if (unclaimed.length){ toast(`還有 ${unclaimed.length} 個項目尚未認領，請先認領完再結算`, 'error'); return; }
  if (!receiptState.attendeeIds.length){ toast('請至少勾選一位出席者', 'error'); return; }

  const payerId = document.getElementById('receiptPayer').value;
  const currency = document.getElementById('receiptCurrency').value;
  const description = document.getElementById('receiptDesc').value.trim() || '帳單辨識支出';
  if (!payerId){ toast('請選擇誰墊付這筆帳單', 'error'); return; }
  let rate = trip.rates[currency];
  if (currency !== trip.baseCurrency){
    const live = await fetchLiveRate(currency, trip.baseCurrency);
    if (live){ rate = live.rate; trip.rates[currency] = live.rate; }
  }
  if (!(rate>0)){ toast(`幣別 ${currency} 尚無匯率設定，且目前無法取得即時匯率`, 'error'); return; }

  const grandTotal = round2(items.reduce((s,i)=>s+i.price,0));
  if (!(grandTotal>0)){ toast('總金額需要大於 0', 'error'); return; }
  const perPerson = computeReceiptSplit(items, receiptState.attendeeIds);
  const participants = receiptState.attendeeIds.map(id => ({ userId:id, amount: perPerson[id]||0 }));

  trip.expenses.push({
    id: genId('exp'),
    description,
    amount: grandTotal,
    currency,
    amountInBase: round2(grandTotal * rate),
    payers: [{ userId: payerId, amount: grandTotal }],
    participants,
    createdAt: Date.now(),
    createdBy: 'web-ui-receipt',
  });
  toast(`已建立支出「${description}」，共 ${fmtMoney(grandTotal, currency)} ${currency}`, 'success');
  receiptResetUpload();
  renderAll();
  await saveTripToApi();
}

