// handlers/musicAntiBot.js
// 職責：Bilibili & YouTube 防爬蟲邏輯
//       Headers 偽裝、Cookies 準備、yt-dlp 參數組合、錯誤分類、client 輪換
// 被 musicPlayer.js 引用

const fs   = require('fs');
const path = require('path');

// ════════════════════════════════════════════════════════
//  Cookies 檔案路徑
// ════════════════════════════════════════════════════════
const COOKIES_PATH         = path.join(__dirname, '..', 'cookies.txt');
const TEMP_COOKIES_PATH    = path.join(__dirname, '..', 'cookies_temp.txt');
const YT_COOKIES_PATH      = path.join(__dirname, '..', 'yt_cookies.txt');
const YT_TEMP_COOKIES_PATH = path.join(__dirname, '..', 'yt_cookies_temp.txt');

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

// ── Bilibili Cookie 檔（初始化後設定）────────────────────
let BILIBILI_COOKIES_FILE = null;

// ════════════════════════════════════════════════════════
//  YouTube 防爬蟲設定
// ════════════════════════════════════════════════════════
const YOUTUBE_HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ── YouTube PO Token（從環境變數讀取）────────────────────
//    取得方式：瀏覽器 F12 → Network → 過濾 v1/player
//              → 最新 player 請求 → serviceIntegrityDimensions.poToken
const YT_PO_TOKEN = process.env.YOUTUBE_PO_TOKEN || null;

// ── YouTube player_client 優先順序策略 ───────────────────
const YT_CLIENT_STRATEGIES = [
  {
    name    : 'tv',
    args    : ['--extractor-args', 'youtube:player_client=tv'],
    needsPO : false,
    desc    : 'TV client（最穩定，不需 PO Token）',
  },
  {
    name    : 'tv_simply',
    args    : ['--extractor-args', 'youtube:player_client=tv_simply'],
    needsPO : false,
    desc    : 'TV Simply client（不需 PO Token，不支援帳號 Cookie）',
  },
  {
    name    : 'mweb+po',
    args    : ['--extractor-args', 'youtube:player_client=default,mweb'],
    needsPO : true,
    desc    : 'mweb client（需要 PO Token）',
  },
  {
    name    : 'web_embedded',
    args    : ['--extractor-args', 'youtube:player_client=web_embedded'],
    needsPO : false,
    desc    : 'web_embedded（僅可嵌入影片，最後備用）',
  },
];

// ── 每個 Guild 目前使用的 client 索引 ────────────────────
const ytClientIndex = new Map(); // guildId -> number

// ── YouTube Cookie 檔（初始化後設定）─────────────────────
let YT_COOKIES_FILE = null;

// ════════════════════════════════════════════════════════
//  工具：判斷是否為 YouTube URL
// ════════════════════════════════════════════════════════
function isYouTubeUrl(url) {
  return /youtube\.com|youtu\.be/.test(url);
}

// ════════════════════════════════════════════════════════
//  Bilibili Cookies 準備
//  優先順序：cookies.txt → 環境變數 → null
// ════════════════════════════════════════════════════════
function prepareBilibiliCookies() {
  if (fs.existsSync(COOKIES_PATH)) {
    console.log('✅ [Bilibili] 找到 cookies.txt');
    return COOKIES_PATH;
  }

  const sessdata   = process.env.BILIBILI_SESSDATA;
  const biliJct    = process.env.BILIBILI_BILI_JCT;
  const dedeUserId = process.env.BILIBILI_DEDEUSERID;

  if (sessdata) {
    console.log('✅ [Bilibili] 從環境變數生成 Cookies');
    let content = '# Netscape HTTP Cookie File\n';
    content += `.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\t${sessdata}\n`;
    if (biliJct)    content += `.bilibili.com\tTRUE\t/\tFALSE\t0\tbili_jct\t${biliJct}\n`;
    if (dedeUserId) content += `.bilibili.com\tTRUE\t/\tFALSE\t0\tDedeUserID\t${dedeUserId}\n`;
    try {
      fs.writeFileSync(TEMP_COOKIES_PATH, content);
      return TEMP_COOKIES_PATH;
    } catch (err) {
      console.error('❌ [Bilibili] 無法寫入 Cookies:', err);
      return null;
    }
  }

  console.warn('⚠️ [Bilibili] 未找到 Cookies，播放可能失敗');
  return null;
}

// ════════════════════════════════════════════════════════
//  YouTube Cookies 準備
//  優先順序：yt_cookies.txt → cookies.txt → 環境變數 → null
// ════════════════════════════════════════════════════════
function prepareYouTubeCookies() {
  if (fs.existsSync(YT_COOKIES_PATH)) {
    console.log('✅ [YouTube] 找到 yt_cookies.txt');
    return YT_COOKIES_PATH;
  }
  if (fs.existsSync(COOKIES_PATH)) {
    console.log('✅ [YouTube] 使用共用 cookies.txt');
    return COOKIES_PATH;
  }

  const ytSessId = process.env.YOUTUBE_SESSION_ID;
  const ytVisitor = process.env.YOUTUBE_VISITOR_INFO;

  if (ytSessId || ytVisitor) {
    console.log('✅ [YouTube] 從環境變數生成 Cookies');
    let content = '# Netscape HTTP Cookie File\n';
    if (ytSessId)  content += `.youtube.com\tTRUE\t/\tTRUE\t0\tSID\t${ytSessId}\n`;
    if (ytVisitor) content += `.youtube.com\tTRUE\t/\tFALSE\t0\tVISITOR_INFO1_LIVE\t${ytVisitor}\n`;
    try {
      fs.writeFileSync(YT_TEMP_COOKIES_PATH, content);
      return YT_TEMP_COOKIES_PATH;
    } catch (err) {
      console.error('❌ [YouTube] 無法寫入 Cookie 臨時檔:', err);
    }
  }

  console.warn('⚠️ [YouTube] 未設定 Cookies，使用無帳號模式（tv client）');
  return null;
}

// ════════════════════════════════════════════════════════
//  初始化所有 Cookies（由 musicPlayer 呼叫一次）
// ════════════════════════════════════════════════════════
function initCookies() {
  BILIBILI_COOKIES_FILE = prepareBilibiliCookies();
  YT_COOKIES_FILE       = prepareYouTubeCookies();
  return { BILIBILI_COOKIES_FILE, YT_COOKIES_FILE };
}

// ════════════════════════════════════════════════════════
//  YouTube client 輪換
// ════════════════════════════════════════════════════════
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
  console.warn('⚠️ [YouTube] 所有 client 均失敗，重置為 tv');
  return false;
}

function resetYtClient(guildId) {
  ytClientIndex.delete(guildId);
}

// ════════════════════════════════════════════════════════
//  組合 YouTube yt-dlp 參數
//
//  streamMode = true  → 串流輸出（-o -）
//  streamMode = false → 下載到檔案（輸出路徑用 '__OUTPUT__' 佔位）
// ════════════════════════════════════════════════════════
function buildYouTubeArgs(url, strategy, streamMode = true) {
  const args = [];

  // ── 1. 格式 & 輸出 ────────────────────────────────────
  if (streamMode) {
    args.push(
      '-f', 'bestaudio/best',
      '-o', '-',
      '--quiet',
      '--buffer-size', '16K',
    );
  } else {
    args.push(
      '-f', 'bestaudio/best',
      '-o', '__OUTPUT__',   // 由 musicCache.downloadAndCache 替換
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
    );
  }

  args.push('--no-playlist', '--no-warnings');

  // ── 2. player_client 策略 ─────────────────────────────
  args.push(...strategy.args);

  // ── 3. PO Token ───────────────────────────────────────
  if (strategy.needsPO && YT_PO_TOKEN) {
    args.push('--extractor-args', `youtube:po_token=mweb.gvs+${YT_PO_TOKEN}`);
    console.log(`🔑 [YouTube] 附加 PO Token (${YT_PO_TOKEN.slice(0, 8)}...)`);
  }

  // ── 4. Cookies（tv_simply 不支援帳號 Cookie）──────────
  if (strategy.name !== 'tv_simply' && YT_COOKIES_FILE) {
    args.push('--cookies', YT_COOKIES_FILE);
  }

  // ── 5. Headers 偽裝 ───────────────────────────────────
  args.push(
    '--user-agent',  YOUTUBE_HEADERS['User-Agent'],
    '--add-header',  `Accept-Language:${YOUTUBE_HEADERS['Accept-Language']}`,
  );

  // ── 6. 速率限制（避免觸發 429）────────────────────────
  args.push(
    '--sleep-requests',     '1',
    '--sleep-interval',     '1',
    '--max-sleep-interval', '3',
  );

  // ── 7. 其他穩定性設定 ─────────────────────────────────
  args.push('--no-check-certificate', '--ignore-errors');

  args.push(url);
  return args;
}

// ════════════════════════════════════════════════════════
//  組合 Bilibili yt-dlp 參數
//
//  streamMode = true  → 串流輸出（-o -）
//  streamMode = false → 下載到檔案（輸出路徑用 '__OUTPUT__' 佔位）
// ════════════════════════════════════════════════════════
function buildBilibiliArgs(url, streamMode = true) {
  const args = [];

  // ── 1. 格式 & 輸出 ────────────────────────────────────
  if (streamMode) {
    args.push(
      '-f', 'bestaudio/best',
      '-o', '-',
      '--quiet',
      '--extract-audio',
      '--audio-format', 'opus',
      '--audio-quality', '0',
      '--buffer-size', '16K',
    );
  } else {
    args.push(
      '-f', 'bestaudio/best',
      '-o', '__OUTPUT__',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
    );
  }

  args.push('--no-playlist', '--no-warnings');

  // ── 2. Cookies ────────────────────────────────────────
  if (BILIBILI_COOKIES_FILE) args.push('--cookies', BILIBILI_COOKIES_FILE);

  // ── 3. Headers 偽裝 ───────────────────────────────────
  args.push(
    '--user-agent', BILIBILI_HEADERS['User-Agent'],
    '--referer',    BILIBILI_HEADERS['Referer'],
    '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
    '--add-header', `Accept:${BILIBILI_HEADERS['Accept']}`,
  );

  // ── 4. 速率限制 ───────────────────────────────────────
  args.push(
    '--sleep-requests',     '2',
    '--sleep-interval',     '2',
    '--max-sleep-interval', '5',
  );

  // ── 5. 其他設定 ───────────────────────────────────────
  args.push(
    '--no-check-certificate',
    '--extractor-args', 'bilibili:getcomments=false',
    '--extractor-args', 'bilibili:getdanmaku=false',
  );

  args.push(url);
  return args;
}

// ════════════════════════════════════════════════════════
//  組合 getInfo 用參數（兩個平台共用入口）
// ════════════════════════════════════════════════════════
function buildInfoArgs(url) {
  const base = ['--dump-json', '--no-playlist', '--no-warnings', '--skip-download'];

  if (isYouTubeUrl(url)) {
    const strategy = YT_CLIENT_STRATEGIES.find(s => s.name === 'tv') || YT_CLIENT_STRATEGIES[0];
    base.push(...strategy.args);
    if (strategy.name !== 'tv_simply' && YT_COOKIES_FILE) {
      base.push('--cookies', YT_COOKIES_FILE);
    }
    base.push(
      '--user-agent', YOUTUBE_HEADERS['User-Agent'],
      '--no-check-certificate',
    );
  } else {
    if (BILIBILI_COOKIES_FILE) base.push('--cookies', BILIBILI_COOKIES_FILE);
    base.push(
      '--user-agent', BILIBILI_HEADERS['User-Agent'],
      '--referer',    BILIBILI_HEADERS['Referer'],
      '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
      '--no-check-certificate',
      '--extractor-args', 'bilibili:getcomments=false',
      '--extractor-args', 'bilibili:getdanmaku=false',
      '--sleep-requests',     '2',
      '--sleep-interval',     '2',
      '--max-sleep-interval', '5',
    );
  }

  base.push(url);
  return base;
}

// ════════════════════════════════════════════════════════
//  YouTube 錯誤分類
//  rotate: true  → 應嘗試切換 client
//  rotate: false → 不需切換，直接報錯或等待
// ════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════
//  Bilibili 錯誤分類
// ════════════════════════════════════════════════════════
function classifyBilibiliError(errorOutput) {
  if (errorOutput.includes('412')) return { msg: 'Bilibili 反爬蟲限制 (412)' };
  if (errorOutput.includes('403')) return { msg: '影片無法訪問 (403)，可能有地區限制或需要大會員' };
  if (errorOutput.includes('404')) return { msg: '找不到影片 (404)' };
  return { msg: `未知錯誤: ${errorOutput.slice(-150)}` };
}

module.exports = {
  // 初始化
  initCookies,
  // 工具
  isYouTubeUrl,
  // YouTube
  YT_CLIENT_STRATEGIES,
  getYtClientStrategy,
  rotateYtClient,
  resetYtClient,
  buildYouTubeArgs,
  classifyYouTubeError,
  // Bilibili
  buildBilibiliArgs,
  classifyBilibiliError,
  // 共用
  buildInfoArgs,
  // 狀態 getter（供 musicPlayer 讀取設定資訊）
  getCookieStatus: () => ({
    bilibili : BILIBILI_COOKIES_FILE,
    youtube  : YT_COOKIES_FILE,
    poToken  : YT_PO_TOKEN,
  }),
};