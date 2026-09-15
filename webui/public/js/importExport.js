'use strict';
// JSON 匯入/匯出、下載、複製、清空並開新行程。
/* ===================== import / export ===================== */
// 偵測是否為整份 guild 檔案 { guildId: { trips: {...} } }，或單一 trip 物件。
// 有多個行程時改用站內清單 modal 讓使用者用點的（取代原本 prompt() 手動打 ID）。
async function resolveTripFromRaw(parsed){
  if (parsed && parsed.members && parsed.expenses !== undefined) {
    return parsed;
  }
  if (parsed && typeof parsed === 'object') {
    let tripsBag = parsed.trips ? parsed : null;
    if (!tripsBag) {
      for (const key of Object.keys(parsed)) {
        if (parsed[key] && parsed[key].trips) { tripsBag = parsed[key]; break; }
      }
    }
    if (tripsBag && tripsBag.trips) {
      const ids = Object.keys(tripsBag.trips);
      if (ids.length === 1) return tripsBag.trips[ids[0]];
      if (ids.length > 1) {
        const items = ids.map(id=>{
          const t = tripsBag.trips[id];
          return { value: id, title: t.name || '未命名行程', sub: `${(t.members||[]).length} 位成員・${(t.expenses||[]).length} 筆支出` };
        });
        const pick = await pickModal('偵測到多個行程，選一個要匯入的：', items);
        return pick ? tripsBag.trips[pick] : null;
      }
    }
  }
  return null;
}
function downloadJson(){
  const blob = new Blob([JSON.stringify(trip, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `splitbill-${trip.name || trip.id}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function copyJson(){
  navigator.clipboard.writeText(JSON.stringify(trip, null, 2))
    .then(()=>toast('已複製到剪貼簿', 'success'))
    .catch(()=>toast('複製失敗，請手動選取文字方塊內容', 'error'));
}
function handleFileImport(evt){
  const file = evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{ document.getElementById('jsonInput').value = reader.result; };
  reader.readAsText(file);
}
async function importJson(){
  const raw = document.getElementById('jsonInput').value.trim();
  if (!raw){ toast('請貼上或選擇 JSON 檔案', 'error'); return; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch(err){ toast('JSON 格式錯誤：'+err.message, 'error'); return; }

  const candidateTrip = await resolveTripFromRaw(parsed);
  if (!candidateTrip){ toast('找不到可辨識的 trip 資料結構', 'error'); return; }

  trip = repairTrip(candidateTrip);
  editingExpenseId = null; editingDepositId = null;
  resetOverviewSectionCurrencyState();
  toast(`已匯入行程「${trip.name}」（成員 ${trip.members.length} 人、支出 ${trip.expenses.length} 筆）`, 'success');
  renderAll();
}
async function confirmNewTrip(){
  const ok = await confirmModal('確定要清空目前所有記帳內容，重新開始一個新行程嗎？此動作會清空成員、支出、轉帳等所有資料（但存檔前都可以按復原）。', { danger:true, confirmText:'清空並開新行程' });
  if (!ok) return;
  const snapshot = trip;
  trip = defaultTrip();
  editingExpenseId = null; editingDepositId = null;
  resetOverviewSectionCurrencyState();
  localFileHandle = null;
  updateLocalFileStatus();
  disconnectTripEventStream(); // 🆕 [即時同步] 清空後不再是原本那個行程，停止接收舊行程的推播
  renderAll();
  toastUndo('已清空行程，開始新的一個', ()=>{ trip = snapshot; renderAll(); });
}

