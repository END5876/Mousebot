'use strict';
// 帳單照片辨識流程：上傳、草稿保存、逐項認領、依認領結果建立支出。
/* =====================================================================
   帳單照片辨識 — 上傳照片 → 伺服器呼叫 Claude 辨識品項 → 逐項認領 →
   一鍵生成一筆支出（participants 用計算出的自訂金額，不是均分）。
===================================================================== */
let receiptState = null; // { imageDataUrl, items:[{id,name,price,type,assignedTo:'shared'|string[]}] }

/* =====================================================================
   🆕 [多人協作] 帳單辨識認領進度的即時同步
   ---------------------------------------------------------------------
   沿用既有的「分享連結」可編輯權限即可，不另外產生新的協作連結：任何
   擁有這個行程可編輯權限的人（擁有者本人、或 write 權限的分享連結持有者）
   開始掃描帳單、產生 receiptState 後，就會自動把這份認領進度廣播給同一個
   行程裡其他擁有可編輯權限的人。不特別區分「你是誰」，任何人都可以直接
   幫任何人勾選——沿用既有的 receiptToggleClaim() 等函式，這裡只是額外把
   每次的變動同步推播出去。
   這份協作狀態刻意不落地寫進 trip.json，只存在伺服器記憶體（見
   webui/lib/receiptSessions.js），沒人更新一段時間後會自動過期。
===================================================================== */
let receiptSessionJoined = false;      // 目前這個分頁的 receiptState 是否正在跟伺服器同步
let receiptSessionPushDirty = false;   // 自從上次推播後，是否有新的變動待送出
let remoteReceiptSessionInfo = null;   // 偵測到「其他人正在辨識中」時的摘要，用來畫加入提示

function receiptSessionUrl(suffix){
  suffix = suffix || '';
  if (shareMode) return `${apiBaseUrl()}/api/shared-trip/${encodeURIComponent(shareMode.token)}/receipt-session${suffix}`;
  const guildId = document.getElementById('guildSelect').value;
  const tripId = document.getElementById('tripSelect').value || trip.id;
  return `${apiBaseUrl()}/api/trip/${encodeURIComponent(guildId)}/${encodeURIComponent(tripId)}/receipt-session${suffix}`;
}

async function pushReceiptSessionToServer(){
  if (!receiptState) return;
  try{
    await fetch(receiptSessionUrl(), {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeadersAny()),
      body: JSON.stringify({ state: receiptState, writerId: CLIENT_INSTANCE_ID })
    });
  }catch(e){
    // 廣播失敗不影響自己本地繼續操作，下一輪偵測到還有變動時會再試一次
  }
}

async function clearReceiptSessionOnServer(reason){
  try{ await fetch(receiptSessionUrl(`?reason=${encodeURIComponent(reason || '')}`), { method: 'DELETE', headers: apiHeadersAny() }); }catch(e){}
}

// 🆕 [Bug fix] 只有「這個分頁自己做的編輯」才該標記為待推播；套用從伺服器／
// SSE 收到的別人狀態時絕對不能標記，否則每個分頁收到更新後都會在自己的
// 週期性計時器裡把「剛收到、可能已經是舊的」那份狀態原封不動地推回去，
// 跟其他人幾乎同時的最新編輯互相搶時間覆蓋——這正是「別人點的項目過幾秒
// 又被換回發起人版本」的成因：renderReceiptWorkArea() 原本無論呼叫來源
// 一律標記待推播，導致純粹「接收＋重繪」也會觸發一次沒有意義、甚至帶著
// 舊資料的再推播。現在改成只有實際觸發編輯的函式（receiptToggleClaim 等）
// 會呼叫這個函式，renderReceiptWorkArea() 本身不再自動標記。
function markReceiptSessionDirty(){
  receiptSessionPushDirty = true;
}

// 每 1.5 秒檢查一次：認領動作希望盡快讓其他人看到，比草稿備份的 3 秒間隔更緊湊一點。
setInterval(() => {
  if (receiptSessionJoined && receiptSessionPushDirty){
    receiptSessionPushDirty = false;
    pushReceiptSessionToServer();
  }
}, 1500);

function renderReceiptSessionBanner(){
  const zone = document.getElementById('receiptSessionBanner');
  if (!zone) return;
  if (remoteReceiptSessionInfo && !receiptState){
    zone.style.display = '';
    zone.innerHTML = `
      <div class="receipt-session-banner">
        <span>📡 有人正在進行帳單辨識認領中，加入即可立刻同步、一起點選品項</span>
        <button type="button" class="btn btn-brass btn-sm" onclick="withLoading(this,'加入中…',joinReceiptSession)">加入認領</button>
      </div>`;
  } else {
    zone.style.display = 'none';
    zone.innerHTML = '';
  }
}

// 🆕 由 SSE 收到「有其他人開始／更新了認領進度」時呼叫；只有目前沒有自己
// 認領畫面的人才需要看到這個提示，已經在協作中的分頁會直接套用最新狀態
// （見 js/sse.js 的 receipt-session-updated 監聽器），不需要另外顯示提示。
function receiptSessionAnnounceUpdate(updatedAt){
  remoteReceiptSessionInfo = { updatedAt };
  renderReceiptSessionBanner();
}
function receiptSessionAnnounceCleared(){
  remoteReceiptSessionInfo = null;
  renderReceiptSessionBanner();
}

// 進入「支出記帳」分頁、或剛連上行程時呼叫：查詢目前是否有其他人正在
// 進行帳單辨識協作，若有則顯示「加入認領」的提示按鈕。
async function checkReceiptSessionAvailability(){
  if (receiptSessionJoined || receiptState) return;
  if (!shareMode){
    const guildId = document.getElementById('guildSelect').value;
    const tripId = document.getElementById('tripSelect').value;
    if (!guildId || !tripId) return; // 尚未連線，不用檢查
  }
  try{
    const res = await fetch(receiptSessionUrl(), { headers: apiHeadersAny() });
    if (!res.ok) return;
    const body = await res.json();
    remoteReceiptSessionInfo = (body && body.active) ? { updatedAt: body.updatedAt } : null;
    renderReceiptSessionBanner();
  }catch(e){ /* 安靜失敗，不影響其他功能 */ }
}

// 加入其他人正在進行的認領：直接拉回目前最新的 state 套用成自己的 receiptState。
// 這裡刻意不標記待推播（見 markReceiptSessionDirty 的說明）：套用別人給的
// 狀態不是「自己的新變動」，之後只有實際點選品項等本地操作才會標記待推播。
async function joinReceiptSession(){
  try{
    const res = await fetch(receiptSessionUrl(), { headers: apiHeadersAny() });
    if (!res.ok){ toast('加入失敗，請稍後再試一次', 'error'); return; }
    const body = await res.json();
    if (!body || !body.active){
      toast('這個認領進度剛好已經結束了', 'error');
      remoteReceiptSessionInfo = null;
      renderReceiptSessionBanner();
      return;
    }
    receiptState = body.state;
    receiptSessionJoined = true;
    remoteReceiptSessionInfo = null;
    renderReceiptWorkArea();
    toast('已加入，現在可以一起點選品項了', 'success');
  }catch(err){
    toast('加入失敗：' + err.message, 'error');
  }
}

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
    // 🆕 [多人協作] 復原草稿時要自動重新加入協作，而不是只把重整前的本地
    // 畫面原封不動叫回來就結束。重新整理頁面會讓 receiptSessionJoined
    // 這個記憶體旗標歸零，若什麼都不做，這個分頁會變成一份「看得到、
    // 但既不會推播自己的變動、也不會套用別人變動」的殭屍畫面。
    // 這裡先問伺服器「這場協作現在還在不在」：
    //   - 還在（自己重整的這段期間，其他人可能持續在認領）→ 直接採用
    //     伺服器上「當下最新」的狀態，而不是用手上這份可能已經過時的
    //     本地草稿，避免一加入就把別人剛做的認領覆蓋掉。
    //   - 不在了（可能沒人接手，或協作早就結束）→ 沿用本地草稿內容，
    //     並主動把它重新廣播出去，讓自己等同「重新發起」這場協作，
    //     其他人一樣能看到「加入認領」的提示、接續使用。
    let usedServerState = false;
    try{
      const res = await fetch(receiptSessionUrl(), { headers: apiHeadersAny() });
      if (res.ok){
        const body = await res.json();
        if (body && body.active){
          receiptState = body.state;
          usedServerState = true;
        }
      }
    }catch(e){ /* 查詢失敗就退回使用本地草稿，不阻擋復原 */ }

    if (!usedServerState) receiptState = draft.receiptState;
    receiptSessionJoined = true;

    // 這裡刻意在 receiptState／receiptSessionJoined 都設定好之後才切分頁：
    // 切分頁時會順便觸發 checkReceiptSessionAvailability()（見 js/state.js），
    // 該函式一看到 receiptState 已經有值就會直接跳過，不會因為時間差而
    // 短暫顯示一個多餘、其實已經沒有意義的「加入認領」提示。
    showMainTab('expenses');
    renderReceiptWorkArea();

    if (!usedServerState) pushReceiptSessionToServer(); // 重新把（沒人接手的）這份協作廣播出去

    toast(usedServerState ? '已復原並同步最新的認領進度' : '已復原上次的認領進度，並已重新加入協作', 'success');
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
    // 🆕 [Bug fix] 順序很重要：一定要先把 receiptSessionJoined 設成 true，
    // 再呼叫 renderReceiptWorkArea()——「🛑 結束認領（放棄）」按鈕是否顯示
    // 就是看這個當下的值。先前這兩行順序相反，導致第一次掃描完成、剛畫出
    // 畫面那一刻 receiptSessionJoined 還是 false，按鈕整個不會出現，
    // 要等使用者之後隨便點了什麼觸發重繪才會冒出來。
    receiptSessionJoined = true;
    renderReceiptWorkArea();
    persistReceiptDraft(); // 🆕 剛辨識完的基礎資料（含圖片）先立刻存一份，不等下一次週期性儲存
    // 🆕 [多人協作] 新掃描出來的這份認領進度，預設就是這個分頁在「驅動」，
    // 立刻廣播出去，讓其他擁有可編輯權限的人能馬上看到「加入認領」的提示。
    pushReceiptSessionToServer();
  }catch(err){
    toast('辨識失敗：' + err.message, 'error');
    uploadZone.innerHTML = original;
  }
}

function receiptResetUpload(){
  receiptState = null;
  clearReceiptDraft(); // 🆕 認領已放棄或已完成，清掉暫存草稿，避免下次重整又跳出復原提示
  receiptDraftDirty = false;
  receiptSessionJoined = false;      // 🆕 [多人協作] 離開這次的認領畫面（不會結束其他人的協作，見上方說明）
  receiptSessionPushDirty = false;   // 🆕
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

// 🆕 [多人協作] 明確「結束（放棄）」這次認領：不建立任何支出，直接把整場
// 協作結束掉，並通知所有正在一起認領的人。
// 跟上面的「🔄 重新上傳照片」不同——那個只會讓「自己」離開這個畫面，
// 伺服器上的協作仍然存在，其他人可以繼續認領；這個按鈕則是主動終止整場
// 協作，任何一位參與者都可以按（不特別區分發起人），因為之前已經確認
// 不需要區分「你是誰」。會影響到所有正在協作的人，因此先跳確認框，
// 避免手滑誤觸中斷別人正在做的事。
async function abandonReceiptSession(){
  const ok = await confirmModal(
    '確定要結束這次認領嗎？不會建立任何支出，正在一起認領的其他人也會被中斷，需要的話得重新掃描。',
    { title: '結束（放棄）這次認領？', confirmText: '結束並放棄', cancelText: '取消', danger: true }
  );
  if (!ok) return;
  const wasJoined = receiptSessionJoined;
  receiptResetUpload();
  if (wasJoined) await clearReceiptSessionOnServer('abandoned');
  toast('已結束這次認領，沒有建立任何支出', 'info');
}

function receiptToggleAttendee(memberId){
  const idx = receiptState.attendeeIds.indexOf(memberId);
  if (idx > -1) receiptState.attendeeIds.splice(idx,1);
  else receiptState.attendeeIds.push(memberId);
  markReceiptSessionDirty();
  renderReceiptWorkArea();
}
function receiptToggleClaim(itemId, memberId){
  const item = receiptState.items.find(i=>i.id===itemId);
  if (!Array.isArray(item.assignedTo)) item.assignedTo = [];
  const idx = item.assignedTo.indexOf(memberId);
  if (idx > -1) item.assignedTo.splice(idx,1);
  else item.assignedTo.push(memberId);
  markReceiptSessionDirty();
  renderReceiptWorkArea();
}
function receiptSetShared(itemId){
  const item = receiptState.items.find(i=>i.id===itemId);
  item.assignedTo = (item.assignedTo === 'shared') ? [] : 'shared';
  markReceiptSessionDirty();
  renderReceiptWorkArea();
}
function receiptUpdateField(itemId, field, value){
  const item = receiptState.items.find(i=>i.id===itemId);
  if (field === 'price'){ item.price = parseFloat(value) || 0; item.priceOverridden = true; } // 使用者接手了，不再自動套用服務費比例
  else if (field === 'name'){ item.name = value; item.nameTranslated = ''; } // 名稱被手動改過，AI 原本的翻譯已經對不上，直接清空避免顯示過時翻譯
  markReceiptSessionDirty();
  renderReceiptWorkArea(); // 完整重繪，讓「已含服務費」提示能正確消失/更新
}
function receiptRemoveItem(itemId){
  receiptState.items = receiptState.items.filter(i=>i.id!==itemId);
  markReceiptSessionDirty();
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
  markReceiptSessionDirty();
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
  markReceiptSessionDirty();
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
  markReceiptSessionDirty();
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
        <div class="btn-row">
          <button type="button" class="btn btn-ghost btn-sm" onclick="receiptResetUpload()">🔄 重新上傳照片</button>
          ${receiptSessionJoined ? '<button type="button" class="btn btn-danger btn-sm" onclick="abandonReceiptSession()">🛑 結束認領（放棄）</button>' : ''}
        </div>
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
  // 🆕 [Bug fix] 建立支出前，先跟伺服器確認一次「這場協作是否還在進行中」。
  // 上面 SSE 的 receipt-session-cleared 監聽器只能處理「事件已經送達」之後
  // 的情況；如果兩個人幾乎同時按下「建立這筆支出」，在對方的送出結果透過
  // SSE 傳回來之前，自己這邊完全不知情、照樣會建立出第二筆重複的支出。
  // 這裡在真正寫入之前，用一次即時查詢當最後防線：若協作已經被別人結束
  // （代表已經有人送出過了），就直接中止並提示，而不是照樣送出。
  // 查詢失敗（例如網路問題）時不擋，維持原本可以送出的行為。
  if (receiptSessionJoined){
    try{
      const checkRes = await fetch(receiptSessionUrl(), { headers: apiHeadersAny() });
      if (checkRes.ok){
        const body = await checkRes.json();
        if (!body || !body.active){
          toast('這筆帳單剛好已經被其他人建立完成了，這裡就不用再送一次囉', 'error');
          receiptResetUpload();
          renderAll();
          return;
        }
      }
    }catch(e){ /* 查詢失敗就不擋，維持原本可以送出的行為 */ }
  }

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
  const wasJoined = receiptSessionJoined; // 🆕 [多人協作] 先記住這次是不是正在協作中，等 reset 完再決定要不要通知大家結束
  receiptResetUpload();
  renderAll();
  await saveTripToApi();
  if (wasJoined) clearReceiptSessionOnServer('finalized'); // 🆕 這筆帳單已經正式記入支出，通知所有協作者這次認領已經結束
}

