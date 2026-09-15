'use strict';
// 🆕 [分享連結] 訪客端偵測與載入分享模式；另含「複製一鍵連線書籤網址」等擁有者端小工具，沿用原始檔案的相鄰順序。
/* ===================== 🆕 [分享連結] 訪客端：偵測與載入分享模式 ===================== */

// 用來把分享連結的 token 暫存在這個分頁的 sessionStorage 裡，讓「重新整理
// 頁面」後可以繼續留在同一個行程，不用回頭跟建立連結的人再要一次網址。
// 特意用 sessionStorage（分頁/瀏覽器關閉就清除）而不是 localStorage
// （會一直留著直到手動清除）：分享連結是要交給別人用的憑證，關掉分頁後
// 不留痕跡比較保守安全；重新整理頁面（同一個分頁）則完全不受影響。
const SHARE_TOKEN_STORAGE_KEY = 'splitbill-share-token';

// 從網址的 hash 讀出 #share=<token>，讀到後立刻清掉網址列（見函式內註解），
// 並存進 sessionStorage 供重新整理頁面時取用。用 hash 而不是 query string
// 的理由跟 buildShareUrl() 一致：hash 從來不會被送到伺服器，對外洩露面最小。
function detectShareTokenFromUrl(){
  const hash = location.hash || '';
  const match = hash.match(/^#share=(.+)$/);
  if (!match) return null;
  const token = decodeURIComponent(match[1]);
  // 讀到就立刻清掉網址列的 hash：避免這組憑證繼續留在網址列／瀏覽器歷史
  // 紀錄／之後使用者複製網址分享出去時被夾帶。用 replaceState 而不是
  // location.hash='' 是因為後者會留下一個多餘的瀏覽器歷史紀錄項目。
  history.replaceState(null, '', location.pathname + location.search);
  try{ sessionStorage.setItem(SHARE_TOKEN_STORAGE_KEY, token); }catch(e){}
  return token;
}
// 重新整理頁面後，網址列的 hash 已經在上次載入時被清掉了，改從
// sessionStorage 撈回上一次還在用的 token。
function getPersistedShareToken(){
  try{ return sessionStorage.getItem(SHARE_TOKEN_STORAGE_KEY); }catch(e){ return null; }
}
function clearPersistedShareToken(){
  try{ sessionStorage.removeItem(SHARE_TOKEN_STORAGE_KEY); }catch(e){}
}

function applyShareModeUI(){
  document.body.classList.add('share-mode');
  if (shareMode.permission !== 'write') document.body.classList.add('share-readonly');



  // 唯讀模式下，行程名稱／幣別這兩個「看似可編輯」的欄位改成唯讀展示，
  // 避免朋友以為改了會生效（實際上就算改了，儲存也會被伺服器擋下來，
  // 這裡純粹是不要讓介面看起來「可以改」造成誤會）。
  if (shareMode.permission !== 'write'){
    document.getElementById('tripName').readOnly = true;
    document.getElementById('baseCurrency').disabled = true;
  }
}

function showShareError(message){
  // 連結本身已經失效／被撤銷／網址有誤，繼續留著 sessionStorage 裡的 token
  // 只會讓下次重新整理頁面時又跑一次一樣的失敗流程，直接清掉。
  clearPersistedShareToken();
  document.getElementById('appHeader').style.display = 'none';
  document.getElementById('topNav').style.display = 'none';
  document.getElementById('bottomNav').style.display = 'none';
  document.querySelector('main.wrap').style.display = 'none';
  const el = document.getElementById('shareErrorScreen');
  el.innerHTML = `
    <div class="ic">😕</div>
    <h1>這個連結打不開</h1>
    <p>${escapeHtml(message)}</p>
    <p style="margin-top:14px;">可以請建立這個連結的人再傳一組新的給你。</p>
  `;
  el.style.display = 'block';
}

function showNoAccessScreen(){
  const el = document.getElementById('noAccessScreen');
  el.innerHTML = `
    <div class="no-access-card">
      <svg class="no-access-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
      <h1>無權限存取</h1>
      <div class="no-access-divider"></div>
      <p>請向行程主人索取分享連結，<br>才能檢視此頁面。</p>
    </div>
  `;
  el.classList.add('visible');
  // 隱藏主介面所有元素
  document.getElementById('appHeader').style.display = 'none';
  const topNav = document.getElementById('topNav');
  if (topNav) topNav.style.display = 'none';
  const bottomNav = document.getElementById('bottomNav');
  if (bottomNav) bottomNav.style.display = 'none';
  const mainEl = document.querySelector('main.wrap');
  if (mainEl) mainEl.style.display = 'none';
}

async function initShareMode(token){
  try{
    const res = await fetch(`${apiBaseUrl()}/api/shared-trip/${encodeURIComponent(token)}`);
    if (!res.ok){
      const body = await res.json().catch(()=>({}));
      const msg = res.status === 403
        ? (body.error || '這個連結已經過期或被撤銷了。')
        : '找不到這個分享連結，網址可能有誤。';
      showShareError(msg);
      return;
    }
    const data = await res.json();
    trip = repairTrip(data.trip);
    lastSyncedTripJSON = JSON.stringify(trip);
    shareMode = { token, permission: data.permission === 'write' ? 'write' : 'read' };
    applyShareModeUI();
    editingExpenseId = null; editingDepositId = null;
    renderAll();
    connectTripEventStream();
    // 🆕 帳單辨識是寫入功能，唯讀分享連結本來就看不到那個區塊，沒必要問
    if (!receiptState && shareMode.permission === 'write') maybeOfferReceiptDraftRestore();
  }catch(err){
    showShareError('連線時發生問題，請確認網路連線後重新整理頁面看看。');
  }
}

// 把目前的連線設定（API 位址／金鑰／伺服器／行程）組成一個網址，
// 存成瀏覽器書籤後，之後點一下就能自動帶入並直接載入該行程。
function buildBookmarkUrl(){
  const apiKey = document.getElementById('apiKey').value.trim();
  const apiBaseVal = document.getElementById('apiBase').value.trim();
  const guildId = document.getElementById('guildSelect').value;
  const tripId = document.getElementById('tripSelect').value;
  const url = new URL(apiBaseVal || location.href);
  url.hash = '';
  if (apiKey) url.searchParams.set('apiKey', apiKey);
  if (guildId) url.searchParams.set('guild', guildId);
  if (tripId) url.searchParams.set('trip', tripId);
  return url.toString();
}
function copyBookmarkUrl(){
  const apiKey = document.getElementById('apiKey').value.trim();
  if (!apiKey){ toast('請先在上面填 API Key（並建議先按一次「連線並讀取伺服器清單」選好伺服器/行程），再產生書籤網址', 'error'); return; }
  const url = buildBookmarkUrl();
  navigator.clipboard.writeText(url)
    .then(()=>toast('已複製書籤網址！存成瀏覽器書籤，之後點它就會自動連線並載入行程。（網址裡含金鑰，請只存在自己的書籤，不要公開分享）', 'success'))
    .catch(()=>toast('複製失敗，這是網址（請手動複製）：' + url, 'error'));
}
// 頁面載入時，若網址帶有 ?apiKey=...，自動帶入並連線、（若也帶 guild/trip）直接載入該行程
async function applyUrlParams(){
  const params = new URLSearchParams(location.search);
  const key = params.get('apiKey');
  const base = params.get('apiBase');
  const guildId = params.get('guild');
  const tripId = params.get('trip');
  if (!key) return false;
  document.getElementById('apiKey').value = key;
  if (base) document.getElementById('apiBase').value = base;
  await refreshGuildList();
  if (guildId && lastGuilds.some(g=>g.guildId===guildId)){
    document.getElementById('guildSelect').value = guildId;
    populateTripSelect();
    const targetTrip = tripId || (lastGuilds.find(g=>g.guildId===guildId)||{}).defaultTripId;
    if (targetTrip){
      document.getElementById('tripSelect').value = targetTrip;
      await loadTripFromApi();
    }
  }
  return true;
}

