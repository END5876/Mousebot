'use strict';
// 多人協作即時同步：SSE 連線建立/斷線/重連，以及收到推播時的合併或提示邏輯。
/* =====================================================================
   🆕 [即時同步] 多人協作：SSE（Server-Sent Events）即時推播
   ---------------------------------------------------------------------
   任何人（webui 存檔、或 Discord 面板操作）異動這個行程時，伺服器都會
   把最新的行程資料推播到這裡。設計原則：
   - 擁有者模式：先用一般帶 x-api-key header 的請求換一張短效、一次性的
     票券（EventSource 無法自訂 header，不能直接帶金鑰去開連線），
     再用票券開 SSE。連線中斷時（含票券只能用一次、網路波動）一律自己
     重新換票、重新連線，不依賴瀏覽器對同一個網址的內建自動重連
     （那樣會直接被拒絕，因為票券已經用掉了）。
   - 分享連結模式：沿用既有設計，token 本身就是路徑上的憑證，不需換票。
   - 收到推播時：若使用者目前沒有正在編輯中的表單/認領流程，直接套用
     並重繪；若有，先嘗試用既有的 tryMergeTrips() 自動合併，合併不了
     （極少發生）才用 toast 提醒使用者手動處理，不會無聲蓋掉正在輸入的
     內容。
===================================================================== */
let tripEventSource = null;
let tripEventReconnectTimer = null;

// 🆕 [即時同步] 這個分頁自己的識別碼，存檔時會附帶送給伺服器，SSE 推播回來
// 時原封不動夾帶在裡面。用這個「明確標記」而不是比較 updatedAt 時間先後，
// 是因為存檔的 PUT 回應跟 SSE 推播走的是兩條獨立連線，SSE 那筆事件常常會
// 比自己 PUT 的 fetch() Promise 更早被處理完——那時候本地 trip.updatedAt
// 都還沒更新成新版本，用時間戳記比較會誤判成「別人更新的」，導致操作者
// 本人也會看到「偵測到其他人更新」的提示。每次重新整理頁面就會換一組新的
// （不需要跨分頁/跨次重新整理持久化，純粹只是「這次連線是不是我發出去的」）。
const CLIENT_INSTANCE_ID = genId('client');

function disconnectTripEventStream(){
  clearTimeout(tripEventReconnectTimer);
  tripEventReconnectTimer = null;
  if (tripEventSource){
    tripEventSource.close();
    tripEventSource = null;
  }
}

async function connectTripEventStream(){
  disconnectTripEventStream();
  try{
    let url;
    if (shareMode){
      url = `${apiBaseUrl()}/api/shared-trip/${encodeURIComponent(shareMode.token)}/events`;
    } else {
      const guildId = document.getElementById('guildSelect').value;
      const tripId = document.getElementById('tripSelect').value || trip.id;
      if (!guildId || !tripId) return; // 尚未連線到任何行程，之後 loadTripFromApi() 成功時會再呼叫一次
      const ticketRes = await fetch(apiBaseUrl() + '/api/sse-ticket', { method: 'POST', headers: apiHeaders() });
      if (!ticketRes.ok) return; // 換票失敗（例如金鑰失效）就安靜放棄，不影響其他既有功能
      const { ticket } = await ticketRes.json();
      url = `${apiBaseUrl()}/api/trip/${encodeURIComponent(guildId)}/${encodeURIComponent(tripId)}/events?ticket=${encodeURIComponent(ticket)}`;
    }

    const es = new EventSource(url);
    tripEventSource = es;

    es.addEventListener('trip-updated', (evt) => {
      try{
        const envelope = JSON.parse(evt.data);
        // 🆕 [即時同步] 這筆推播就是「我自己剛存的」：writerId 完全比對，
        // 不看時間戳記，避免 SSE 推播先於自己 PUT 回應抵達造成的誤判
        // （見上面 CLIENT_INSTANCE_ID 宣告處的說明）。
        if (envelope && envelope.writerId && envelope.writerId === CLIENT_INSTANCE_ID) return;
        handleIncomingTripUpdate(envelope && envelope.trip ? envelope.trip : envelope);
      }catch(e){ /* 忽略解析失敗的單一事件 */ }
    });

    // 🆕 [即時同步] 行程被刪除（例如在 Discord 面板按了「刪除此行程」）：
    // 伺服器送完這個事件後會直接關閉連線，這裡主動斷線＋提醒使用者，
    // 不要再嘗試自動重連（trip 已經不存在，重連只會一直拿到 404）。
    es.addEventListener('trip-deleted', () => {
      handleIncomingTripDeleted();
    });

    // 🆕 [多人協作] 帳單辨識認領進度：有人更新了認領狀態（勾選/取消勾選、
    // 修改品項等）就會收到這個事件；如果自己也正在同一份協作裡，直接套用
    // 最新狀態；如果自己還沒加入，只更新「有人正在辨識中」的提示。
    es.addEventListener('receipt-session-updated', (evt) => {
      try{
        const payload = JSON.parse(evt.data);
        if (payload && payload.writerId && payload.writerId === CLIENT_INSTANCE_ID) return; // 自己剛推播的回音
        if (typeof receiptSessionJoined !== 'undefined' && receiptSessionJoined){
          receiptState = payload.state;
          renderReceiptWorkArea();
        } else if (typeof receiptSessionAnnounceUpdate === 'function') {
          receiptSessionAnnounceUpdate(payload.updatedAt);
        }
      }catch(e){ /* 忽略解析失敗的單一事件 */ }
    });

    // 🆕 [Bug fix] 這次的帳單辨識協作已經結束（帳單已建立成支出，或被取消）。
    // 過去這裡只把 receiptSessionJoined 這個旗標設回 false，畫面上的認領
    // 表單、品項清單、「建立這筆支出」按鈕卻完全沒有跟著關閉——導致還沒
    // 收到通知前就已經打開這頁的人，即使協作其實已經結束，依然可以照樣
    // 按下「建立這筆支出」，用自己手上那份（其實已經失效）的資料再送出
    // 一次，變成同一張帳單被重複記帳兩筆。現在改成直接呼叫
    // receiptResetUpload()：只對「真的還在這場協作裡」的分頁生效（本人
    // 剛送出的那個分頁已經在 finalizeReceiptExpense() 裡自行 reset 過，
    // receiptSessionJoined 這時已經是 false，不會重複顯示提示或誤觸）。
    es.addEventListener('receipt-session-cleared', (evt) => {
      let reason = null;
      try{ reason = (JSON.parse(evt.data) || {}).reason; }catch(e){ /* 忽略解析失敗，退回通用訊息 */ }
      if (typeof receiptSessionJoined !== 'undefined' && receiptSessionJoined){
        if (typeof receiptResetUpload === 'function') receiptResetUpload();
        // 🆕 依實際結束原因給出對應的訊息，而不是一句語意含糊的「可能已經…」
        const msg = reason === 'finalized'
          ? '這次帳單辨識協作已經結束了：已經有人建立成支出，畫面已自動關閉'
          : reason === 'abandoned'
          ? '這次帳單辨識協作已經被結束（放棄），沒有建立任何支出'
          : '這次帳單辨識協作已經結束了（可能已經建立成支出，或發起人已取消），請重新掃描或確認結果';
        toast(msg, 'info');
      }
      if (typeof receiptSessionAnnounceCleared === 'function') receiptSessionAnnounceCleared();
    });

    es.onerror = () => {
      // 連線中斷：關閉舊連線，稍等一下用「新換的票券」重新連線，
      // 不讓瀏覽器用同一個（已失效的一次性票券）網址自動重試。
      es.close();
      if (tripEventSource === es) tripEventSource = null;
      clearTimeout(tripEventReconnectTimer);
      tripEventReconnectTimer = setTimeout(connectTripEventStream, 3000);
    };
  }catch(e){
    // 即時同步屬於錦上添花的功能，換票或建立連線失敗都不應該擋住其他既有功能運作
  }
}

function handleIncomingTripUpdate(rawPushedTrip){
  const pushedTrip = repairTrip(rawPushedTrip);

  // Echo 抑制：如果推播來的版本並沒有比我們現在手上的新，代表這通常是
  // 我們自己剛存檔造成的那次廣播，或是一則過期的訊息，直接忽略即可。
  if (trip.updatedAt && pushedTrip.updatedAt && pushedTrip.updatedAt <= trip.updatedAt) return;

  const isEditing = !!(
    hasUnsavedExpenseFormContent() || hasUnsavedDepositFormContent() ||
    (receiptState && Array.isArray(receiptState.items) && receiptState.items.length)
  );

  if (!isEditing){
    trip = pushedTrip;
    lastSyncedTripJSON = JSON.stringify(trip);
    renderAll();
    toast('偵測到其他人更新了這個行程，畫面已同步', 'info');
    return;
  }

  // 目前有未儲存的編輯內容（表單填到一半、或正在認領帳單品項）：
  // 嘗試自動合併，避免正在輸入的東西被無聲蓋掉。
  const merged = tryMergeTrips(trip, pushedTrip);
  if (merged){
    trip = merged;
    lastSyncedTripJSON = JSON.stringify(trip);
    renderAll();
    toast('已自動合併其他人剛剛的更新', 'info');
  } else {
    toast('其他人剛更新了這個行程，但無法自動合併，請儘快儲存或重新整理頁面取得最新版本', 'error');
  }
}

// 🆕 [即時同步] 行程被刪除時的處理：分享連結模式下這個 token 本身也已經
// 跟著行程一起消失了（shareLinks 是存在 trip 物件裡的），直接沿用既有的
// 「連結失效」全頁提示；擁有者模式下沒有對應的全頁畫面，用醒目、不會自動
// 消失太快的 toast 提醒，並刷新伺服器/行程清單，避免使用者沒注意到還繼續
// 對著一個已經不存在的行程按「儲存回 Bot」（那會被伺服器當成建立一個
//全新、同名的行程，見 webui/server.js 的 PUT /api/trip/:guildId/:tripId）。
function handleIncomingTripDeleted(){
  disconnectTripEventStream();
  if (shareMode){
    showShareError('這個行程已經被刪除了，分享連結也跟著失效。');
    return;
  }
  toast('⚠️ 這個行程已經在別處被刪除了。畫面上仍保留刪除前的最後一份資料，但請避免直接按「儲存」，那會被當成建立一筆新的行程。', 'error', { duration: 10000 });
  if (document.getElementById('guildSelect').value){
    refreshGuildList().catch(()=>{});
  }
}

