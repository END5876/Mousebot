// handlers/musicAntiBot.js
// 職責：Bilibili & YouTube 防爬蟲邏輯
//       Headers 偽裝、Cookies 準備、yt-dlp 參數組合、錯誤分類、client 輪換
// 被 musicPlayer.js 引用

const fs   = require('fs');
const path = require('path');

// ════════════════════════════════════════════════════════
//  Proxy 設定 (Cloudflare WARP)
// ════════════════════════════════════════════════════════
const WARP_PROXY = process.env.WARP_PROXY_URL;

// ★ 修改 1：啟動時明確記錄 proxy 使用狀態
if (WARP_PROXY) {
  console.log(`✅ [Proxy] 已設定 WARP_PROXY_URL，YouTube 請求將透過 Proxy 轉發: ${WARP_PROXY}`);
} else {
  console.log('ℹ️ [Proxy] 未設定 WARP_PROXY_URL，YouTube 請求將直接使用本地網路連線');
}

// ════════════════════════════════════════════════════════
//  Cookies 檔案路徑（僅保留「已存在的外部檔案」路徑，不自動建立）
// ════════════════════════════════════════════════════════
const COOKIES_PATH    = path.join(__dirname, '..', 'cookies.txt');
const YT_COOKIES_PATH = path.join(__dirname, '..', 'yt_cookies.txt');

// ════════════════════════════════════════════════════════
//  Bilibili 防爬蟲設定
// ════════════════════════════════════════════════════════
const BILIBILI_HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer'        : 'https://www.bilibili.com/',
  'Origin'         : 'https://www.bilibili.com',
  'Accept'         : '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection'     : 'keep-alive',
  'Sec-Fetch-Dest' : 'empty',
  'Sec-Fetch-Mode' : 'cors',
  'Sec-Fetch-Site' : 'same-site',
};

// ── Bilibili Cookie（記憶體字串，初始化後設定）────────────
let BILIBILI_COOKIES_FILE   = null;
let BILIBILI_COOKIE_HEADER  = null;

// ════════════════════════════════════════════════════════
//  YouTube 防爬蟲設定
// ════════════════════════════════════════════════════════
const YOUTUBE_HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const YT_PO_TOKEN = process.env.YOUTUBE_PO_TOKEN || null;

// ── YouTube player_client 優先順序策略 ───────────────────
// 🎯 修改重點：將 default 設為第一順位，不指定參數讓 yt-dlp 自動選擇最佳客戶端繞過 DRM
const YT_CLIENT_STRATEGIES = [
  {
    name    : 'default',
    args    : [], // 不指定參數，使用 yt-dlp 預設
    needsPO : false,
    desc    : '預設 client（最穩定，繞過 TV DRM 限制）',
  },
  {
    name    : 'mweb+po',
    args    : ['--extractor-args', 'youtube:player_client=default,mweb'],
    needsPO : true,
    desc    : 'mweb client（需要 PO Token）',
  },
  {
    name    : 'tv',
    args    : ['--extractor-args', 'youtube:player_client=tv'],
    needsPO : false,
    desc    : 'TV client（容易遇到 DRM 限制，作為備用）',
  },
  {
    name    : 'tv_simply',
    args    : ['--extractor-args', 'youtube:player_client=tv_simply'],
    needsPO : false,
    desc    : 'TV Simply client',
  },
  {
    name    : 'web_embedded',
    args    : ['--extractor-args', 'youtube:player_client=web_embedded'],
    needsPO : false,
    desc    : 'web_embedded（僅可嵌入影片，最後備用）',
  },
];

const ytClientIndex = new Map();

let YT_COOKIES_FILE   = null;
let YT_COOKIE_HEADER  = null;

function isYouTubeUrl(url) {
  return /youtube\.com|youtu\.be/.test(url);
}

function prepareBilibiliCookies() {
  if (fs.existsSync(COOKIES_PATH)) {
    console.log('✅ [Bilibili] 找到 cookies.txt');
    BILIBILI_COOKIES_FILE  = COOKIES_PATH;
    BILIBILI_COOKIE_HEADER = null;
    return;
  }
  const sessdata   = process.env.BILIBILI_SESSDATA;
  const biliJct    = process.env.BILIBILI_BILI_JCT;
  const dedeUserId = process.env.BILIBILI_DEDEUSERID;
  if (sessdata) {
    console.log('✅ [Bilibili] 從環境變數載入 Cookies（記憶體模式）');
    const parts = [`SESSDATA=${sessdata}`];
    if (biliJct)    parts.push(`bili_jct=${biliJct}`);
    if (dedeUserId) parts.push(`DedeUserID=${dedeUserId}`);
    BILIBILI_COOKIES_FILE  = null;
    BILIBILI_COOKIE_HEADER = parts.join('; ');
    return;
  }
  console.warn('⚠️ [Bilibili] 未找到 Cookies，播放可能失敗');
  BILIBILI_COOKIES_FILE  = null;
  BILIBILI_COOKIE_HEADER = null;
}

function prepareYouTubeCookies() {
  if (fs.existsSync(YT_COOKIES_PATH)) {
    console.log('✅ [YouTube] 找到 yt_cookies.txt');
    YT_COOKIES_FILE   = YT_COOKIES_PATH;
    YT_COOKIE_HEADER  = null;
    return;
  }
  if (fs.existsSync(COOKIES_PATH)) {
    console.log('✅ [YouTube] 使用共用 cookies.txt');
    YT_COOKIES_FILE   = COOKIES_PATH;
    YT_COOKIE_HEADER  = null;
    return;
  }
  const ytSessId = process.env.YOUTUBE_SESSION_ID;
  const ytVisitor = process.env.YOUTUBE_VISITOR_INFO;
  if (ytSessId || ytVisitor) {
    console.log('✅ [YouTube] 從環境變數載入 Cookies（記憶體模式）');
    const parts = [];
    if (ytSessId)  parts.push(`SID=${ytSessId}`);
    if (ytVisitor) parts.push(`VISITOR_INFO1_LIVE=${ytVisitor}`);
    YT_COOKIES_FILE   = null;
    YT_COOKIE_HEADER  = parts.join('; ');
    return;
  }
  console.warn('⚠️ [YouTube] 未設定 Cookies，使用無帳號模式');
  YT_COOKIES_FILE   = null;
  YT_COOKIE_HEADER  = null;
}

function initCookies() {
  prepareBilibiliCookies();
  prepareYouTubeCookies();
  return { BILIBILI_COOKIES_FILE, YT_COOKIES_FILE };
}

function _appendCookieArgs(args, cookiesFile, cookieHeader) {
  if (cookiesFile) {
    args.push('--cookies', cookiesFile);
  } else if (cookieHeader) {
    args.push('--add-header', `Cookie:${cookieHeader}`);
  }
}

function getYtClientStrategy(guildId) {
  const idx = ytClientIndex.get(guildId) || 0;
  return { strategy: YT_CLIENT_STRATEGIES[idx], idx };
}

function rotateYtClient(guildId) {
  const current = ytClientIndex.get(guildId) || 0;
  const next    = current + 1;
  if (next < YT_CLIENT_STRATEGIES.length) {
    ytClientIndex.set(guildId, next);
    console.log(`🔄 [YouTube] 切換 client: ${YT_CLIENT_STRATEGIES[current].name} → ${YT_CLIENT_STRATEGIES[next].name}`);
    return true;
  }
  ytClientIndex.set(guildId, 0);
  console.warn('⚠️ [YouTube] 所有 client 均失敗，重置為 default');
  return false;
}

function resetYtClient(guildId) {
  ytClientIndex.delete(guildId);
}

function buildYouTubeArgs(url, strategy, streamMode = true) {
  const args = [];

  // ★ 修改 2：只有設定了才加入 --proxy，未設定則走本地網路
  if (WARP_PROXY) {
    args.push('--proxy', WARP_PROXY);
  }
  args.push('--js-runtimes', 'node');

  if (streamMode) {
    args.push('-f', 'bestaudio/best', '-o', '-', '--quiet', '--buffer-size', '16K');
  } else {
    args.push('-f', 'bestaudio/best', '-o', '__OUTPUT__', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
  }

  args.push('--no-playlist', '--no-warnings');
  args.push(...strategy.args);

  if (strategy.needsPO && YT_PO_TOKEN) {
    args.push('--extractor-args', `youtube:po_token=mweb.gvs+${YT_PO_TOKEN}`);
    console.log(`🔑 [YouTube] 附加 PO Token (${YT_PO_TOKEN.slice(0, 8)}...)`);
  }

  if (strategy.name !== 'tv_simply') {
    _appendCookieArgs(args, YT_COOKIES_FILE, YT_COOKIE_HEADER);
  }

  args.push(
    '--user-agent',  YOUTUBE_HEADERS['User-Agent'],
    '--add-header',  `Accept-Language:${YOUTUBE_HEADERS['Accept-Language']}`,
    '--sleep-requests',     '1',
    '--sleep-interval',     '1',
    '--max-sleep-interval', '3',
    '--no-check-certificate', '--ignore-errors'
  );

  args.push(url);
  return args;
}

function buildBilibiliArgs(url, streamMode = true) {
  const args = [];
  if (streamMode) {
    args.push('-f', 'bestaudio/best', '-o', '-', '--quiet', '--extract-audio', '--audio-format', 'opus', '--audio-quality', '0', '--buffer-size', '16K');
  } else {
    args.push('-f', 'bestaudio/best', '-o', '__OUTPUT__', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
  }

  args.push('--no-playlist', '--no-warnings');
  _appendCookieArgs(args, BILIBILI_COOKIES_FILE, BILIBILI_COOKIE_HEADER);

  args.push(
    '--user-agent', BILIBILI_HEADERS['User-Agent'],
    '--referer',    BILIBILI_HEADERS['Referer'],
    '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
    '--add-header', `Accept:${BILIBILI_HEADERS['Accept']}`,
    '--sleep-requests',     '2',
    '--sleep-interval',     '2',
    '--max-sleep-interval', '5',
    '--no-check-certificate',
    '--extractor-args', 'bilibili:getcomments=false',
    '--extractor-args', 'bilibili:getdanmaku=false'
  );

  args.push(url);
  return args;
}

// ════════════════════════════════════════════════════════
//  Bilibili 搜尋專用參數（僅 headers/cookies，不含下載/播放旗標）
// ════════════════════════════════════════════════════════
function buildBilibiliSearchArgs() {
  const args = [];

  _appendCookieArgs(args, BILIBILI_COOKIES_FILE, BILIBILI_COOKIE_HEADER);

  args.push(
    '--user-agent', BILIBILI_HEADERS['User-Agent'],
    '--referer',    BILIBILI_HEADERS['Referer'],
    '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
    '--add-header', `Accept:${BILIBILI_HEADERS['Accept']}`,
    '--no-check-certificate',
  );

  return args;
}

function buildInfoArgs(url) {
  const base = ['--dump-json', '--no-playlist', '--no-warnings', '--skip-download'];

  if (isYouTubeUrl(url)) {
    // ★ 修改 3：只有設定了才加入 --proxy
    if (WARP_PROXY) {
      base.push('--proxy', WARP_PROXY);
    }
    base.push('--js-runtimes', 'node');

    // 🎯 修改重點：改為尋找 default 策略
    const strategy = YT_CLIENT_STRATEGIES.find(s => s.name === 'default') || YT_CLIENT_STRATEGIES[0];
    base.push(...strategy.args);

    if (strategy.name !== 'tv_simply') {
      _appendCookieArgs(base, YT_COOKIES_FILE, YT_COOKIE_HEADER);
    }
    base.push('--user-agent', YOUTUBE_HEADERS['User-Agent'], '--no-check-certificate');
  } else {
    _appendCookieArgs(base, BILIBILI_COOKIES_FILE, BILIBILI_COOKIE_HEADER);
    base.push(
      '--user-agent', BILIBILI_HEADERS['User-Agent'],
      '--referer',    BILIBILI_HEADERS['Referer'],
      '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
      '--no-check-certificate',
      '--extractor-args', 'bilibili:getcomments=false',
      '--extractor-args', 'bilibili:getdanmaku=false',
      '--sleep-requests',     '2',
      '--sleep-interval',     '2',
      '--max-sleep-interval', '5'
    );
  }

  base.push(url);
  return base;
}

function classifyYouTubeError(errorOutput) {
  if (errorOutput.includes('Sign in to confirm') || errorOutput.includes('not a bot')) {
    return { type: 'BOT_DETECTED',   rotate: true,  msg: 'YouTube 偵測到機器人請求，嘗試切換 client' };
  }
  if (errorOutput.includes('403')) {
    return { type: 'FORBIDDEN_403',  rotate: true,  msg: '403 禁止存取（可能需要 PO Token 或 Cookie）' };
  }
  if (errorOutput.includes('429')) {
    return { type: 'RATE_LIMITED',   rotate: false, msg: '請求頻率過高 (429)，稍後重試' };
  }
  if (errorOutput.includes('Private video') || errorOutput.includes('private video')) {
    return { type: 'PRIVATE',        rotate: false, msg: '私人影片，無法播放' };
  }
  if (errorOutput.includes('Video unavailable') || errorOutput.includes('not available')) {
    return { type: 'UNAVAILABLE',    rotate: false, msg: '影片不可用（可能有地區限制）' };
  }
  if (errorOutput.includes('410') || errorOutput.includes('removed')) {
    return { type: 'REMOVED',        rotate: false, msg: '影片已被刪除' };
  }
  return   { type: 'UNKNOWN',        rotate: true,  msg: `未知錯誤: ${errorOutput.slice(-150)}` };
}

function classifyBilibiliError(errorOutput) {
  if (errorOutput.includes('412')) return { msg: 'Bilibili 反爬蟲限制 (412)' };
  if (errorOutput.includes('403')) return { msg: '影片無法訪問 (403)，可能有地區限制或需要大會員' };
  if (errorOutput.includes('404')) return { msg: '找不到影片 (404)' };
  return { msg: `未知錯誤: ${errorOutput.slice(-150)}` };
}

module.exports = {
  initCookies,
  isYouTubeUrl,
  YT_CLIENT_STRATEGIES,
  getYtClientStrategy,
  rotateYtClient,
  resetYtClient,
  buildYouTubeArgs,
  classifyYouTubeError,
  buildBilibiliArgs,
  buildBilibiliSearchArgs,   // ★ 新增匯出
  classifyBilibiliError,
  buildInfoArgs,
  getCookieStatus: () => ({
    bilibili : BILIBILI_COOKIES_FILE || BILIBILI_COOKIE_HEADER,
    youtube  : YT_COOKIES_FILE       || YT_COOKIE_HEADER,
    poToken  : YT_PO_TOKEN,
  }),
};
