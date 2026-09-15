'use strict';
// 🆕 [分享連結] 擁有者專用：建立／列出／修改／撤銷分享連結面板。
/* ===================== 🆕 [分享連結] 擁有者專用：建立／列出／撤銷 ===================== */

// 把一個分享 token 組成完整的、朋友可以直接點的網址。刻意放在 URL 的 hash
// （# 之後）而不是一般的 query string（? 之後）：hash 完全不會被送到伺服器，
// 不會出現在伺服器/代理的存取紀錄裡，也不會被 Referrer 帶到第三方（例如頁面
// 內建的 Google Fonts、即時匯率 API）。頁面載入時讀取到 hash 裡的 token 後，
// 也會立刻用 history.replaceState() 把網址列清乾淨（見 initShareMode()），
// 進一步降低瀏覽器歷史紀錄殘留明碼憑證的風險。
function buildShareUrl(token){
  const url = new URL(apiBaseUrl() || location.href, location.href);
  url.search = '';
  url.hash = `share=${token}`;
  return url.toString();
}

async function renderShareLinksPanel(){
  const noTripHint = document.getElementById('shareLinkNoTripHint');
  const manageArea = document.getElementById('shareLinkManageArea');
  const guildId = document.getElementById('guildSelect').value;
  const tripId = document.getElementById('tripSelect').value;

  if (!guildId || !tripId){
    noTripHint.style.display = '';
    manageArea.style.display = 'none';
    return;
  }
  noTripHint.style.display = 'none';
  manageArea.style.display = '';

  const listEl = document.getElementById('shareLinkList');
  const countEl = document.getElementById('shareLinkCount');
  try{
    const res = await fetch(`${apiBaseUrl()}/api/trip/${encodeURIComponent(guildId)}/${encodeURIComponent(tripId)}/share-links`, { headers: apiHeaders() });
    if (!res.ok){
      const body = await res.json().catch(()=>({}));
      throw new Error(body.error || ('HTTP ' + res.status));
    }
    const links = await res.json();
    countEl.textContent = `(${links.length})`;
    listEl.innerHTML = links.length ? links.slice().sort((a,b)=>b.createdAt-a.createdAt).map(l => {
      const expiryLabel = l.expiresAt ? `到期：${new Date(l.expiresAt).toLocaleDateString('zh-TW')}` : '永久有效';
      const safeLabel = escapeHtml(l.label || '此連結').replace(/'/g,"\\'");
      return `<div class="ledger-row">
        <div class="ledger-main">
          <div class="ledger-title">${escapeHtml(l.label || '（未命名連結）')}</div>
          <div class="ledger-sub">
            <select class="convert-select share-link-perm-select" onchange="updateShareLinkPermission('${l.token}', this.value)">
              <option value="read" ${l.permission!=='write'?'selected':''}>👀 唯讀</option>
              <option value="write" ${l.permission==='write'?'selected':''}>✏️ 可編輯</option>
            </select>
            ${expiryLabel}
          </div>
          <div class="ledger-actions">
            <button class="btn btn-brass btn-sm" onclick="copyShareLinkUrl('${l.token}')">🔗 複製連結</button>
            <button class="btn btn-danger btn-sm" onclick="revokeShareLink('${l.token}', '${safeLabel}')">撤銷</button>
          </div>
        </div>
      </div>`;
    }).join('') : emptyState('🔗', '還沒有任何分享連結', null, '');
  }catch(err){
    listEl.innerHTML = '';
    countEl.textContent = '';
    toast('讀取分享連結失敗：' + err.message, 'error');
  }
}

async function createShareLink(){
  const guildId = document.getElementById('guildSelect').value;
  const tripId = document.getElementById('tripSelect').value;
  if (!guildId || !tripId){ toast('請先連線並選擇一個行程。', 'error'); return; }

  const label = document.getElementById('shareLinkLabel').value.trim();
  const permission = document.getElementById('shareLinkPermission').value;
  const expiresInDays = parseInt(document.getElementById('shareLinkExpiry').value, 10) || 0;

  try{
    const res = await fetch(`${apiBaseUrl()}/api/trip/${encodeURIComponent(guildId)}/${encodeURIComponent(tripId)}/share-links`, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
      body: JSON.stringify({ label, permission, expiresInDays })
    });
    if (!res.ok){
      const body = await res.json().catch(()=>({}));
      throw new Error(body.error || ('HTTP ' + res.status));
    }
    const link = await res.json();
    document.getElementById('shareLinkLabel').value = '';
    await renderShareLinksPanel();
    await confirmModal(
      `已建立分享連結！點「確定」會把連結複製到剪貼簿，貼給朋友即可，請不要公開分享這組網址。`,
      { confirmText: '複製連結並關閉', cancelText: '稍後再說' }
    ) && await copyShareLinkUrl(link.token);
  }catch(err){
    toast('建立分享連結失敗：' + err.message, 'error');
  }
}

async function copyShareLinkUrl(token){
  const url = buildShareUrl(token);
  try{
    await navigator.clipboard.writeText(url);
    toast('已複製分享連結，貼給朋友即可（請勿公開分享）', 'success');
  }catch(e){
    toast('複製失敗，這是連結網址（請手動複製）：' + url, 'error');
  }
}

// 🆕 隨時修改一筆既有分享連結的權限（唯讀／可編輯），不用撤銷重建、對方手上的連結網址
// 完全不變，下一次對方開啟或儲存時就會立刻套用新權限。select 選單本身已經有目前的值，
// 這裡只在使用者真的選了不同的選項時才送出請求，避免每次重新整理清單都白打一次 API。
async function updateShareLinkPermission(token, permission){
  const guildId = document.getElementById('guildSelect').value;
  const tripId = document.getElementById('tripSelect').value;
  try{
    const res = await fetch(`${apiBaseUrl()}/api/trip/${encodeURIComponent(guildId)}/${encodeURIComponent(tripId)}/share-links/${encodeURIComponent(token)}`, {
      method: 'PATCH',
      headers: Object.assign({ 'Content-Type': 'application/json' }, apiHeaders()),
      body: JSON.stringify({ permission })
    });
    if (!res.ok){
      const body = await res.json().catch(()=>({}));
      throw new Error(body.error || ('HTTP ' + res.status));
    }
    toast(permission === 'write' ? '已改為可編輯' : '已改為唯讀', 'success');
    renderShareLinksPanel();
  }catch(err){
    toast('修改權限失敗：' + err.message, 'error');
    renderShareLinksPanel(); // 失敗時重新讀取清單，讓下拉選單的值還原成伺服器上實際的權限
  }
}

async function revokeShareLink(token, label){
  const ok = await confirmModal(`確定要撤銷「${label}」這組分享連結嗎？撤銷後，任何拿著這個連結的人都會立刻無法再存取。`, { danger:true, confirmText:'確定撤銷' });
  if (!ok) return;

  const guildId = document.getElementById('guildSelect').value;
  const tripId = document.getElementById('tripSelect').value;
  try{
    const res = await fetch(`${apiBaseUrl()}/api/trip/${encodeURIComponent(guildId)}/${encodeURIComponent(tripId)}/share-links/${encodeURIComponent(token)}`, {
      method: 'DELETE',
      headers: apiHeaders()
    });
    if (!res.ok){
      const body = await res.json().catch(()=>({}));
      throw new Error(body.error || ('HTTP ' + res.status));
    }
    toast('已撤銷分享連結', 'success');
    renderShareLinksPanel();
  }catch(err){
    toast('撤銷失敗：' + err.message, 'error');
  }
}

