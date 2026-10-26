'use strict';

// ════════════════════════════════════════════════════════
//  時長格式化（與 onlineMusicHandler.js 的邏輯保持一致）
// ════════════════════════════════════════════════════════
function _formatDuration(seconds) {
  if (!seconds) return '未知';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

// ════════════════════════════════════════════════════════
//  網址清理工具 (URL Cleaning)
//  🔒 [快取投毒] 把 YouTube／Bilibili 網址重建成唯一的標準形式：交給 yt-dlp 的網址與快取檔名
//  （musicCache.getCacheFilename）用的影片 ID 一定一致。以前快取檔名的 ID 是在整個網址裡找，
//  https://www.youtube.com/watch?v=<惡意>&x=BV<目標> 會下載惡意影片、存成目標 Bilibili 影片的快取，
//  再上傳到共用音樂庫給所有 Bot 播放。網址裡出現互相衝突的影片 ID 時回傳 ''（呼叫端當成無效網址）。
//  ⚠️ 與 music-library-service 的 ytdlp/urlUtils.js 相同，兩邊的快取檔名才會互相命中。
// ════════════════════════════════════════════════════════
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_PATH_RE = /^\/(?:shorts|embed|live|v|e)\/([^/]+)/;
const BILI_PATH_RE = /^\/video\/(BV[0-9A-Za-z]{10}|av\d+)(?:\/|$)/i;
const T_RE = /^(?:\d+|(?:\d+h)?(?:\d+m)?(?:\d+s)?)$/;

function _hostIs(hostname, base) {
  const h = String(hostname || '').toLowerCase();
  return h === base || h.endsWith(`.${base}`);
}

function parseUrl(rawUrl) {
  try { return new URL(String(rawUrl || '').trim()); } catch { return null; }
}

// 網址裡的 YouTube 影片 ID → { id, conflict }：路徑與 v= 參數（或多個 v=）指向不同影片時 conflict 為 true
function youtubeVideoId(urlObj) {
  const ids = new Set();
  const add = (v) => { if (v !== null && v !== undefined) ids.add(String(v)); };
  if (_hostIs(urlObj.hostname, 'youtu.be')) add(urlObj.pathname.split('/')[1] || null);
  const m = urlObj.pathname.match(YT_PATH_RE);
  if (m) add(m[1]);
  for (const v of urlObj.searchParams.getAll('v')) add(v);
  if (ids.size > 1) return { id: null, conflict: true };
  const [id] = ids;
  if (id === undefined) return { id: null, conflict: false };
  // 只出現一個、但不是合法 ID：當成沒有影片 ID（網址照一般方式清理；yt-dlp 自己會失敗，也算不出快取 ID）
  return YT_ID_RE.test(id) ? { id, conflict: false } : { id: null, conflict: false };
}

// 網址裡的 Bilibili 影片 ID（BVxxxxxxxxxx 或 avNNN）；不是 /video/<id> 形式時回傳 null
function bilibiliVideoId(urlObj) {
  const m = urlObj.pathname.match(BILI_PATH_RE);
  if (!m) return null;
  return /^av/i.test(m[1]) ? `av${m[1].slice(2)}` : `BV${m[1].slice(2)}`;
}

//   YouTube：有影片 ID → https://www.youtube.com/watch?v=<id>（保留開始時間 t）；ID 互相衝突 → ''
//   Bilibili：/video/<id> → https://www.bilibili.com/video/<id>（只保留分 P 的 p 參數）
//   其他 YouTube／Bilibili 網址一律改成 https；不認得的網域原樣回傳
function cleanUrl(rawUrl) {
  const urlObj = parseUrl(rawUrl);
  if (!urlObj || (urlObj.protocol !== 'https:' && urlObj.protocol !== 'http:')) return rawUrl;

  if (_hostIs(urlObj.hostname, 'youtube.com') || _hostIs(urlObj.hostname, 'youtu.be')) {
    const { id, conflict } = youtubeVideoId(urlObj);
    if (conflict) return '';
    if (id) {
      const t = urlObj.searchParams.get('t');
      return `https://www.youtube.com/watch?v=${id}${t && T_RE.test(t) ? `&t=${t}` : ''}`;
    }
    urlObj.protocol = 'https:';
    for (const k of ['list', 'index', 'start_radio', 'rv', 'feature']) urlObj.searchParams.delete(k);
    return urlObj.toString();
  }

  if (_hostIs(urlObj.hostname, 'bilibili.com')) {
    const p = urlObj.searchParams.get('p');
    const page = p && /^\d{1,4}$/.test(p) ? p : null;
    const id = bilibiliVideoId(urlObj);
    if (id) return `https://www.bilibili.com/video/${id}${page ? `?p=${page}` : ''}`;
    urlObj.protocol = 'https:';
    urlObj.search = '';
    if (page) urlObj.searchParams.set('p', page);
    return urlObj.toString();
  }

  return rawUrl;
}

// ════════════════════════════════════════════════════════
//  YouTube 網址且沒有 list 參數 → 一定是單一影片，不需要播放清單偵測
//  （mix / radio / 播放清單頁都會帶 list=；Bilibili 的分 P 無法從網址判斷，不適用）
// ════════════════════════════════════════════════════════
function _isYouTubeWithoutList(rawUrl) {
  try {
    const urlObj = new URL(rawUrl);
    const host = urlObj.hostname.toLowerCase();
    const isYouTube = host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
    return isYouTube && !urlObj.searchParams.has('list');
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════════
//  將 flat-playlist 條目解析為可直接 getInfo() 的完整網址
// ════════════════════════════════════════════════════════
function _resolveEntryUrl(baseUrl, entry) {
  if (entry.url && /^https?:\/\//i.test(entry.url)) return entry.url;
  if (entry.webpage_url) return entry.webpage_url;
  if (entry.id) return `https://www.youtube.com/watch?v=${entry.id}`;
  return baseUrl;
}

module.exports = {
  _formatDuration,
  cleanUrl,
  parseUrl,
  youtubeVideoId,
  bilibiliVideoId,
  _isYouTubeWithoutList,
  _resolveEntryUrl
};
