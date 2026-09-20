'use strict';
// File System Access API：直接開啟並覆寫本機 trip.json、自動儲存排程。
/* ===================== 直接覆寫本機檔案 (File System Access API) ===================== */
let localFileHandle = null;
let autoSaveEnabled = false;
let autoSaveTimer = null;
const supportsFileSystemAccess = typeof window.showOpenFilePicker === 'function'
  && typeof window.showSaveFilePicker === 'function';

function initFsApiUi(){
  const hint = document.getElementById('fsApiHint');
  if (!supportsFileSystemAccess){
    document.getElementById('btnOpenLocal').disabled = true;
    document.getElementById('btnSaveLocal').disabled = true;
    document.getElementById('autoSaveLocal').disabled = true;
    hint.textContent = '你目前的瀏覽器不支援「直接寫入本機檔案」（僅 Chrome / Edge 等 Chromium 瀏覽器支援）。請改用下方的下載／貼上方式，或用「連線 Bot」分頁直接存回伺服器（所有瀏覽器都適用）。';
  } else {
    hint.textContent = '按「選擇 trip.json」開啟你要編輯的檔案，之後按「儲存並覆寫檔案」會直接寫回同一個檔案，不用再下載、也不用手動貼上。此功能需要 HTTPS 或 localhost。';
  }
}
function updateLocalFileStatus(){
  const el = document.getElementById('localFileStatus');
  el.textContent = localFileHandle ? `目前連結檔案：${localFileHandle.name}` : '尚未連結本機檔案';
  const pillText = document.getElementById('fileStatusText');
  const pill = document.getElementById('fileStatusPill');
  if (localFileHandle){
    pillText.textContent = (autoSaveEnabled ? '自動覆寫：' : '已連結：') + localFileHandle.name;
    pill.classList.add('on'); pill.classList.remove('warn');
  } else {
    pillText.textContent = '未連結本機檔案';
    pill.classList.remove('on','warn');
  }
  // 🆕 [狀態 pill 精簡] 「未連結本機檔案」是多數人（用 Bot 連線）的預設/
  // 正常狀態，不需要常駐提醒；只有使用者主動連結了本機檔案（代表接下來
  // 存檔會直接覆寫本機磁碟上的那個檔案，是需要使用者知情的狀態）才顯示。
  pill.style.display = localFileHandle ? '' : 'none';
}
function updateBotStatusPill(connected, label){
  const pillText = document.getElementById('botStatusText');
  const pill = document.getElementById('botStatusPill');
  if (connected){
    pillText.textContent = label ? `已連線：${label}` : '已連線 Bot';
    pill.classList.add('on'); pill.classList.remove('warn');
  } else {
    pillText.textContent = '未連線 Bot';
    pill.classList.remove('on','warn');
  }
  // 🆕 [狀態 pill 精簡] 已連線是正常狀態，不需要常駐佔位；未連線才是需要
  // 使用者處理的狀態，才跳出來提醒（點下去可直接跳到「連線 Bot」分頁）。
  pill.style.display = connected ? 'none' : '';
}
function toggleApiKeyVisibility(){
  const input = document.getElementById('apiKey');
  const btn = document.getElementById('apiKeyToggleBtn');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  btn.textContent = showing ? '顯示' : '隱藏';
}
async function openLocalFile(){
  if (!supportsFileSystemAccess) return;
  try{
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'Trip JSON', accept: {'application/json': ['.json']} }],
      excludeAcceptAllOption: false,
      multiple: false
    });
    const file = await handle.getFile();
    const text = await file.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch(err){ toast('這個檔案不是合法的 JSON：'+err.message, 'error'); return; }
    const candidate = await resolveTripFromRaw(parsed);
    if (!candidate){ toast('這個檔案裡找不到可辨識的 trip 資料結構', 'error'); return; }

    trip = repairTrip(candidate);
    localFileHandle = handle;
    editingExpenseId = null; editingDepositId = null;
    resetOverviewSectionCurrencyState();
    updateLocalFileStatus();
    toast(`已連結並載入「${trip.name}」，之後按「儲存並覆寫檔案」會直接寫回這個檔案`, 'success');
    renderAll();
  }catch(err){
    handleFsError(err);
  }
}
async function saveToLocalFile(silent){
  if (!supportsFileSystemAccess) return;
  try{
    if (!localFileHandle){
      localFileHandle = await window.showSaveFilePicker({
        suggestedName: `splitbill-${trip.name||trip.id}.json`,
        types: [{ description:'Trip JSON', accept:{'application/json':['.json']} }]
      });
    }
    const writable = await localFileHandle.createWritable();
    await writable.write(JSON.stringify(trip, null, 2));
    await writable.close();
    updateLocalFileStatus();
    if (!silent) toast('已覆寫檔案：' + localFileHandle.name, 'success');
  }catch(err){
    handleFsError(err);
  }
}
function handleFsError(err){
  if (err.name === 'AbortError') return; // 使用者自己取消選擇視窗
  if (err.name === 'SecurityError'){
    toast('此功能需要安全連線（HTTPS 或 localhost），目前頁面是用 http 開啟。請改用下方下載／貼上，或幫這個網頁加上 HTTPS 反向代理後再試。', 'error');
    return;
  }
  toast('操作失敗：' + err.message, 'error');
}
function onAutoSaveToggle(checked){
  autoSaveEnabled = checked;
  if (checked && !localFileHandle){
    toast('請先選擇並連結一個檔案，自動覆寫才會生效', 'error');
  }
  updateLocalFileStatus();
}
function scheduleAutoSave(){
  if (!autoSaveEnabled || !localFileHandle) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(()=>{ saveToLocalFile(true); }, 500);
}