// handlers/musicplayer/antibot/youtube.js
// 職責：YouTube 防爬蟲設定 — Headers、Cookies 準備、player_client 策略輪替、
// yt-dlp 參數組合、錯誤分類

const logger = require('../../../utils/logger');
const { fs, WARP_PROXY, COOKIES_PATH, YT_COOKIES_PATH, _appendCookieArgs } = require('./config');

const YOUTUBE_HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const YT_PO_TOKEN = process.env.YOUTUBE_PO_TOKEN || null;

// ── YouTube player_client 優先順序策略 ───────────────────
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

function prepareYouTubeCookies() {
  if (fs.existsSync(YT_COOKIES_PATH)) {
    logger.debug('YouTube', '找到 yt_cookies.txt');
    YT_COOKIES_FILE   = YT_COOKIES_PATH;
    YT_COOKIE_HEADER  = null;
    return;
  }
  if (fs.existsSync(COOKIES_PATH)) {
    logger.debug('YouTube', '使用共用 cookies.txt');
    YT_COOKIES_FILE   = COOKIES_PATH;
    YT_COOKIE_HEADER  = null;
    return;
  }
  const ytSessId = process.env.YOUTUBE_SESSION_ID;
  const ytVisitor = process.env.YOUTUBE_VISITOR_INFO;
  if (ytSessId || ytVisitor) {
    logger.debug('YouTube', '從環境變數載入 Cookies（記憶體模式）');
    const parts = [];
    if (ytSessId)  parts.push(`SID=${ytSessId}`);
    if (ytVisitor) parts.push(`VISITOR_INFO1_LIVE=${ytVisitor}`);
    YT_COOKIES_FILE   = null;
    YT_COOKIE_HEADER  = parts.join('; ');
    return;
  }
  logger.debug('YouTube', '未設定 Cookies，使用無帳號模式');
  YT_COOKIES_FILE   = null;
  YT_COOKIE_HEADER  = null;
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

// ════════════════════════════════════════════════════════
//  YouTube 搜尋專用參數（僅 headers/proxy/cookies，不含下載旗標）
// ════════════════════════════════════════════════════════
function buildYouTubeSearchArgs() {
  const args = [];

  if (WARP_PROXY) {
    args.push('--proxy', WARP_PROXY);
  }

  _appendCookieArgs(args, YT_COOKIES_FILE, YT_COOKIE_HEADER);

  args.push(
    '--user-agent',   YOUTUBE_HEADERS['User-Agent'],
    '--add-header',   `Accept-Language:${YOUTUBE_HEADERS['Accept-Language']}`,
    '--no-check-certificate',
  );

  return args;
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

module.exports = {
  YOUTUBE_HEADERS,
  YT_PO_TOKEN,
  YT_CLIENT_STRATEGIES,
  isYouTubeUrl,
  prepareYouTubeCookies,
  getYtClientStrategy,
  rotateYtClient,
  resetYtClient,
  buildYouTubeArgs,
  buildYouTubeSearchArgs,
  classifyYouTubeError,
  // 供 combined.js 的 buildInfoArgs / buildPlaylistCheckArgs 共用邏輯讀取狀態
  getYoutubeCookieState: () => ({ file: YT_COOKIES_FILE, header: YT_COOKIE_HEADER }),
};
