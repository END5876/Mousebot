'use strict';
// 連線 Bot API 的基礎設施：apiBaseUrl/apiHeaders、即時匯率查詢、伺服器與行程清單、記住上次連線。
/* ===================== connect to bot API ===================== */
let lastGuilds = [];
let lastSyncedTripJSON = null; // 用來做簡單的樂觀鎖：跟伺服器目前的版本比對，偵測是否被別人改過
function apiBaseUrl(){
  const v = document.getElementById('apiBase').value.trim();
  return v ? v.replace(/\/+$/,'') : ''; // 空字串 = 使用目前網址（同源）
}
function apiHeaders(){
  const key = document.getElementById('apiKey').value.trim();
  return key ? { 'x-api-key': key } : {};
}
// 🆕 [分享連結] 給「擁有者/分享連結都可能呼叫」的共用工具端點用（即時匯率、
// 帳單辨識）：分享連結模式下用連結自己的 token 當憑證，否則沿用擁有者在
// 「連線 Bot」分頁填的金鑰。分享連結持有者的畫面上根本沒有 apiKey 那個
// 輸入框，apiHeaders() 在那個情境下只會拿到空字串，這是先前即時匯率對
// 分享連結訪客一直失敗的根因——這裡統一改用這個函式來源正確的憑證。
function apiHeadersAny(){
  if (shareMode) return { 'x-api-key': shareMode.token };
  return apiHeaders();
}

/* ===================== 即時匯率 ===================== */
// 非基準幣的支出/轉帳，存檔時要用「當下」的即時匯率換算 amountInBase（amount 仍存原始幣值）。
// 用短時間快取，避免同一張表單打字時每個 keystroke 都打一次外部匯率 API。
let liveRateCache = {}; // `${from}_${to}` -> { rate, asOf, fetchedAt }
const LIVE_RATE_CACHE_TTL = 10 * 60 * 1000; // 10 分鐘
async function fetchLiveRate(from, to){
  if (from === to) return { rate: 1, asOf: null };
  const key = `${from}_${to}`;
  const cached = liveRateCache[key];
  if (cached && (Date.now() - cached.fetchedAt) < LIVE_RATE_CACHE_TTL) return cached;
  try{
    const res = await fetch(`${apiBaseUrl()}/api/fx-rate?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { headers: apiHeadersAny() });
    const body = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    const entry = { rate: body.rate, asOf: body.asOf, fetchedAt: Date.now() };
    liveRateCache[key] = entry;
    return entry;
  }catch(err){
    return null; // 由呼叫端自行退回使用手動設定的匯率，不擋住記帳
  }
}
async function refreshGuildList(){
  try{
    const res = await fetch(apiBaseUrl() + '/api/guilds', { headers: apiHeaders() });
    if (!res.ok){
      const body = await res.json().catch(()=>({}));
      throw new Error(body.error || ('HTTP ' + res.status));
    }
    const guilds = await res.json();
    lastGuilds = guilds;
    const sel = document.getElementById('guildSelect');
    sel.innerHTML = guilds.length
      ? guilds.map(g=>`<option value="${g.guildId}">${g.guildId}${g.guildName?(' － '+escapeHtml(g.guildName)):''}</option>`).join('')
      : '<option value="">（伺服器上沒有任何資料）</option>';
    sel.onchange = ()=>{ populateTripSelect(); syncAdvDetailsState(); };
    populateTripSelect();
    syncAdvDetailsState();
    toast(`連線成功，共找到 ${guilds.length} 個伺服器`, 'success');
    updateBotStatusPill(true);
  }catch(err){
    toast('連線失敗：' + err.message + '（請確認網址、API Key，以及伺服器是否有開放該埠）', 'error');
    updateBotStatusPill(false);
  }
}
function populateTripSelect(){
  const guildId = document.getElementById('guildSelect').value;
  const g = lastGuilds.find(x=>x.guildId===guildId);
  const sel = document.getElementById('tripSelect');
  if (!g){ sel.innerHTML = '<option value="">－ 請先選伺服器 －</option>'; return; }
  sel.innerHTML = g.trips.length
    ? g.trips.map(t=>`<option value="${t.id}" ${t.id===g.defaultTripId?'selected':''}>${escapeHtml(t.name)}${t.archived?'（已封存）':''}</option>`).join('')
    : '<option value="">（此伺服器尚無行程）</option>';
}
// 🆕 記住擁有者上次連線成功的伺服器/行程（連同 API 位址與金鑰），下次重新
// 整理頁面時可以自動接回去，不用每次都重新輸入金鑰、重新選一次伺服器與
// 行程。存在 localStorage：這是「你自己這台裝置」記住「你自己的」連線
// 設定，資料完全不會被送到任何地方，跟先前討論過的「把金鑰塞進可分享
// 網址」是不同的風險等級（那個問題已經由分享連結機制解決了——分享連結
// 走的是完全獨立的 token，不會用到這裡存的擁有者金鑰）。
const OWNER_CONNECTION_STORAGE_KEY = 'splitbill-owner-connection';
function saveOwnerConnectionState(){
  try{
    const guildId = document.getElementById('guildSelect').value;
    const tripId = document.getElementById('tripSelect').value;
    if (!guildId || !tripId) return;
    localStorage.setItem(OWNER_CONNECTION_STORAGE_KEY, JSON.stringify({
      apiBase: document.getElementById('apiBase').value.trim(),
      apiKey: document.getElementById('apiKey').value.trim(),
      guildId, tripId,
    }));
  }catch(e){}
}
function clearOwnerConnectionState(){
  try{ localStorage.removeItem(OWNER_CONNECTION_STORAGE_KEY); }catch(e){}
}
// 頁面載入時嘗試自動接回上次的連線。刻意不重用 refreshGuildList()／
// loadTripFromApi()，因為那兩個函式失敗時會跳 toast 提示錯誤——這裡是
// 「安靜嘗試」，接不回去就悄悄退回一般的空白狀態，不用嚇到使用者（例如
// 伺服器金鑰後來換過、或行程被刪除了）。成功的話效果等同手動選好伺服器/
// 行程再按「載入」。
async function restoreOwnerConnectionState(){
  let saved = null;
  try{ saved = JSON.parse(localStorage.getItem(OWNER_CONNECTION_STORAGE_KEY) || 'null'); }catch(e){}
  if (!saved || !saved.guildId || !saved.tripId) return false;

  document.getElementById('apiKey').value = saved.apiKey || '';
  document.getElementById('apiBase').value = saved.apiBase || '';

  try{
    const res = await fetch(apiBaseUrl() + '/api/guilds', { headers: apiHeaders() });
    if (!res.ok){ clearOwnerConnectionState(); return false; }
    const guilds = await res.json();
    lastGuilds = guilds;
    if (!guilds.some(g => g.guildId === saved.guildId)){ clearOwnerConnectionState(); return false; }

    const guildSel = document.getElementById('guildSelect');
    guildSel.innerHTML = guilds.map(g=>`<option value="${g.guildId}">${g.guildId}${g.guildName?(' － '+escapeHtml(g.guildName)):''}</option>`).join('');
    guildSel.onchange = ()=>{ populateTripSelect(); syncAdvDetailsState(); };
    guildSel.value = saved.guildId;
    populateTripSelect();

    const tripSel = document.getElementById('tripSelect');
    if (![...tripSel.options].some(o => o.value === saved.tripId)){ clearOwnerConnectionState(); return false; }
    tripSel.value = saved.tripId;

    await loadTripFromApi();
    syncAdvDetailsState();
    return true;
  }catch(e){
    return false;
  }
}

