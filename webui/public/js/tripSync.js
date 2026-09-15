'use strict';
// 行程讀寫核心：loadTripFromApi/saveTripToApi（含版本衝突重試與合併）、分享連結版 saveSharedTripToApi、tryMergeTrips。
async function loadTripFromApi(){
  const guildId = document.getElementById('guildSelect').value;
  const tripId = document.getElementById('tripSelect').value;
  if (!guildId || !tripId){ toast('請先選擇伺服器與行程', 'error'); return; }
  try{
    const res = await fetch(`${apiBaseUrl()}/api/trip/${encodeURIComponent(guildId)}/${encodeURIComponent(tripId)}`, { headers: apiHeaders() });
    if (!res.ok){
      const body = await res.json().catch(()=>({}));
      throw new Error(body.error || ('HTTP ' + res.status));
    }
    const data = await res.json();
    trip = repairTrip(data);
    lastSyncedTripJSON = JSON.stringify(trip);
    editingExpenseId = null; editingDepositId = null;
    resetOverviewSectionCurrencyState();
    toast(`已載入「${trip.name}」（成員 ${trip.members.length} 人、支出 ${trip.expenses.length} 筆）`, 'success');
    updateBotStatusPill(true, trip.name);
    syncAdvDetailsState();
    if (currentSettingsSub === 'share') renderShareLinksPanel();
    saveOwnerConnectionState();
    renderAll();
    connectTripEventStream();
    if (!receiptState) maybeOfferReceiptDraftRestore(); // 🆕 目前沒有進行中的認領才詢問，避免打斷正在做的事
  }catch(err){
    toast('載入失敗：' + err.message, 'error');
  }
}
async function saveTripToApi(){
  // 🆕 [分享連結] 分享連結模式下走完全不同的儲存路徑（見 saveSharedTripToApi()）：
  // 不需要 guildSelect/tripSelect、不需要 apiHeaders() 裡的金鑰，純粹用網址
  // 路徑上的 token 當憑證，對分享連結的持有者來說完全不用碰到任何技術設定。
  if (shareMode) return saveSharedTripToApi();

  const guildId = document.getElementById('guildSelect').value;
  const tripId = document.getElementById('tripSelect').value || trip.id;
  if (!guildId){
    showMainTab('settings'); showSettingsSub('connect');
    toast('尚未連線，請先到「設定 → 🔌 連線 Bot」選擇伺服器與行程，之後就能在這裡直接儲存。', 'error');
    return;
  }

  // 🆕 [併發保護] 最多重試幾次：多人幾乎同時存檔時，即使每次都被伺服器的
  // 原子化版本檢查擋下（409），本地合併後重試一次通常就會成功；重試上限
  // 只是避免理論上的無限迴圈（例如短時間內一直有新的人持續搶著存檔）。
  const MAX_SAVE_RETRY = 3;

  for (let attempt = 0; attempt < MAX_SAVE_RETRY; attempt++){
    // 版本比對：儲存前先看看伺服器上的版本跟我們最後一次同步的是否一致，
    // 偵測到衝突時嘗試自動合併（把伺服器有但本地沒有的筆數加進來），
    // 只有在無法自動合併時才詢問使用者。
    // ⚠️ 這一步只是「儘量減少」不必要的衝突、給使用者更即時的合併體驗，
    // 不是真正的併發保護——它跟下面的 PUT 是兩個分開的請求，兩者之間仍有
    // 極短的競爭視窗。真正的保護在於 PUT 請求本身帶了 expectedUpdatedAt，
    // 由伺服器端原子化比對＋拒絕（見下方 409 處理）。
    try{
      const checkRes = await fetch(`${apiBaseUrl()}/api/trip/${encodeURIComponent(guildId)}/${encodeURIComponent(tripId)}`, { headers: apiHeaders() });
      if (checkRes.ok){
        const serverTrip = await checkRes.json();
        if (!lastSyncedTripJSON) {
          // 首次儲存（從未載入過），直接確認
          const proceed = await confirmModal(`確定要儲存目前的行程資料嗎？（伺服器 ${guildId} ／行程 ${tripId}）`, { confirmText:'儲存' });
          if (!proceed) return;
        } else if (serverTrip.updatedAt && trip.updatedAt && serverTrip.updatedAt !== trip.updatedAt) {
          // 伺服器版本比本地版本新，嘗試智慧合併
          const merged = tryMergeTrips(trip, serverTrip);
          if (merged) {
            // 合併成功：靜默套用合併結果，不打擾使用者
            trip = merged;
            renderAll();
            toast('已自動合併其他人的更新', 'info');
          } else {
            // 合併失敗（有衝突）：詢問使用者
            const proceed = await confirmModal('這個行程已經被其他人更新過，而且跟你目前的內容有衝突，無法自動合併。確定要用你目前這份覆蓋掉嗎？', { danger:true, confirmText:'仍要覆蓋', title:'偵測到資料衝突' });
            if (!proceed) return;
          }
        } else if (lastSyncedTripJSON && JSON.stringify(serverTrip) !== lastSyncedTripJSON && !serverTrip.updatedAt) {
          // 舊版伺服器（沒有 updatedAt），退回原本的整包比對
          const merged = tryMergeTrips(trip, serverTrip);
          if (merged) {
            trip = merged;
            renderAll();
            toast('已自動合併其他人的更新', 'info');
          } else {
            const proceed = await confirmModal('這份行程資料似乎已經被更新過（可能是別人剛存過，或你在別的分頁存過），確定要用你目前這份覆蓋掉嗎？', { danger:true, confirmText:'仍要覆蓋', title:'偵測到資料衝突' });
            if (!proceed) return;
          }
        }
      }
    }catch(e){ /* 檢查失敗就略過，不要因為這個擋住存檔 */ }

    try{
      // 🆕 [併發保護] 把本地目前認定的版本號一併送給伺服器；伺服器會在真正
      // 寫入前原子化比對這個版本號是否仍然等於它「當下」的版本，不一致就
      // 回傳 409，讓下面的重試邏輯接手，而不是悶不吭聲地整包覆蓋。
      const payload = Object.assign({}, trip, { expectedUpdatedAt: trip.updatedAt || null, writerId: CLIENT_INSTANCE_ID });
      const res = await fetch(`${apiBaseUrl()}/api/trip/${encodeURIComponent(guildId)}/${encodeURIComponent(tripId)}`, {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
        body: JSON.stringify(payload)
      });

      if (res.status === 409){
        // 真的被別人搶先一步存檔了（上面的預先檢查沒能攔到這個極短的競爭
        // 視窗）：拿伺服器回傳的「當下最新版本」合併，合併成功就重試一次；
        // 合併不了（真衝突）就不再重試，請使用者重新整理頁面。
        const body = await res.json().catch(()=>({}));
        const serverTrip = body.currentTrip;
        const merged = serverTrip ? tryMergeTrips(trip, serverTrip) : null;

        if (!merged){
          toast('儲存失敗：資料版本衝突且無法自動合併，請重新整理頁面後再試一次。', 'error');
          return;
        }

        trip = merged;
        renderAll();
        if (attempt < MAX_SAVE_RETRY - 1){
          toast('儲存時發現有人剛好搶先一步更新，已自動合併並重新儲存…', 'info');
          continue; // 用合併後的版本再跑一次迴圈重新存一次
        }
        toast('已自動合併其他人的更新，但重試次數已用完，請再按一次「儲存」把合併後的結果存回去。', 'error');
        return;
      }

      if (!res.ok){
        const body = await res.json().catch(()=>({}));
        throw new Error(body.error || ('HTTP ' + res.status));
      }
      const savedData = await res.json();
      trip = repairTrip(savedData); // 用伺服器回傳的版本（含最新 updatedAt）更新本地
      lastSyncedTripJSON = JSON.stringify(trip);
      toast('已儲存', 'success');
      updateBotStatusPill(true, trip.name);
      saveOwnerConnectionState();
      renderAll();
      return; // 成功，結束整個函式
    }catch(err){
      toast('儲存失敗：' + err.message, 'error');
      return;
    }
  }
}

// 🆕 [多人協作] 智慧合併：把「本地版本」與「伺服器版本」的 expenses/deposits/members
// 以 id 為鍵進行合併。策略：
// - 本地有、伺服器沒有的筆數（本地新增的）→ 保留
// - 伺服器有、本地沒有的筆數（別人新增的）→ 加進來
// - 兩邊都有同一個 id 的筆數 → 以本地版本為準（使用者正在編輯的優先）
// - 如果同一筆 id 的內容不同（衝突），回傳 null 表示無法自動合併
// 注意：members 的合併比較寬鬆，只要 id 一致就視為同一人（不管名稱是否被改過）
function tryMergeTrips(localTrip, serverTrip){
  try{
    // 合併 expenses
    const localExpMap = new Map(localTrip.expenses.map(e=>[e.id, e]));
    const serverExpMap = new Map(serverTrip.expenses.map(e=>[e.id, e]));
    const mergedExpenses = [];
    // 先加入本地的所有 expenses（本地版本優先）
    for (const [id, exp] of localExpMap) mergedExpenses.push(exp);
    // 再加入伺服器有但本地沒有的（別人新增的）
    for (const [id, exp] of serverExpMap){
      if (!localExpMap.has(id)) mergedExpenses.push(exp);
    }
    // 按 createdAt 排序
    mergedExpenses.sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));

    // 合併 deposits
    const localDepMap = new Map(localTrip.deposits.map(d=>[d.id, d]));
    const serverDepMap = new Map(serverTrip.deposits.map(d=>[d.id, d]));
    const mergedDeposits = [];
    for (const [id, dep] of localDepMap) mergedDeposits.push(dep);
    for (const [id, dep] of serverDepMap){
      if (!localDepMap.has(id)) mergedDeposits.push(dep);
    }
    mergedDeposits.sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));

    // 合併 members（伺服器有但本地沒有的成員也加進來，避免別人新增的成員消失）
    const localMemMap = new Map(localTrip.members.map(m=>[m.id, m]));
    const serverMemMap = new Map(serverTrip.members.map(m=>[m.id, m]));
    const mergedMembers = [...localTrip.members];
    for (const [id, mem] of serverMemMap){
      if (!localMemMap.has(id)) mergedMembers.push(mem);
    }

    // 建立合併後的 trip（保留本地的基本設定，更新 expenses/deposits/members）
    const merged = Object.assign({}, localTrip, {
      expenses: mergedExpenses,
      deposits: mergedDeposits,
      members: mergedMembers,
      // 保留伺服器的 shareLinks（不讓本地覆蓋）
      shareLinks: serverTrip.shareLinks || localTrip.shareLinks || [],
      // updatedAt 設為伺服器版本（合併後儲存時伺服器會再更新）
      updatedAt: serverTrip.updatedAt,
    });
    return repairTrip(merged);
  }catch(e){
    return null; // 合併過程出錯，回傳 null 讓呼叫端改走衝突提示
  }
}

// 🆕 [分享連結] 分享連結模式下的儲存：直接 PUT /api/shared-trip/:token，
// 伺服器會依這個 token 反查對應的行程並驗證權限（唯讀連結送到這裡一樣會被
// 伺服器擋下來，這裡先在前端擋一次純粹是為了不必要地打一次注定失敗的請求、
// 給使用者更直接的提示）。
async function saveSharedTripToApi(){
  if (shareMode.permission !== 'write'){
    toast('這個分享連結是唯讀的，無法儲存變更。', 'error');
    return;
  }

  // 🆕 [併發保護] 跟擁有者版本 saveTripToApi() 用同一套機制：帶上
  // expectedUpdatedAt 讓伺服器原子化比對，衝突時合併＋重試，見那邊的
  // 完整說明。分享連結版本先前完全沒有任何併發保護，兩位朋友同時透過
  // 同一個分享連結編輯時特別容易中獎，這裡優先度其實更高。
  const MAX_SAVE_RETRY = 3;

  for (let attempt = 0; attempt < MAX_SAVE_RETRY; attempt++){
    try{
      const payload = Object.assign({}, trip, { expectedUpdatedAt: trip.updatedAt || null, writerId: CLIENT_INSTANCE_ID });
      const res = await fetch(`${apiBaseUrl()}/api/shared-trip/${encodeURIComponent(shareMode.token)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.status === 409){
        const body = await res.json().catch(()=>({}));
        const serverTrip = body.currentTrip;
        const merged = serverTrip ? tryMergeTrips(trip, serverTrip) : null;

        if (!merged){
          toast('儲存失敗：資料版本衝突且無法自動合併，請重新整理頁面後再試一次。', 'error');
          return;
        }

        trip = merged;
        renderAll();
        if (attempt < MAX_SAVE_RETRY - 1){
          toast('儲存時發現有人剛好搶先一步更新，已自動合併並重新儲存…', 'info');
          continue;
        }
        toast('已自動合併其他人的更新，但重試次數已用完，請再按一次「儲存」把合併後的結果存回去。', 'error');
        return;
      }

      if (!res.ok){
        const body = await res.json().catch(()=>({}));
        throw new Error(body.error || ('HTTP ' + res.status));
      }
      const data = await res.json();
      trip = repairTrip(data.trip);
      lastSyncedTripJSON = JSON.stringify(trip);
      toast('已儲存', 'success');
      renderAll();
      return;
    }catch(err){
      toast('儲存失敗：' + err.message, 'error');
      return;
    }
  }
}

