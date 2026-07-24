// handlers/musicplayer/antibot/bilibili.js
// 職責：Bilibili 防爬蟲設定 — Headers、Cookies 準備、yt-dlp 參數組合、錯誤分類

const logger = require('../../../utils/logger');
const { fs, COOKIES_PATH, _appendCookieArgs } = require('./config');

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

function prepareBilibiliCookies() {
  if (fs.existsSync(COOKIES_PATH)) {
    logger.debug('Bilibili', '找到 cookies.txt');
    BILIBILI_COOKIES_FILE  = COOKIES_PATH;
    BILIBILI_COOKIE_HEADER = null;
    return;
  }
  const sessdata   = process.env.BILIBILI_SESSDATA;
  const biliJct    = process.env.BILIBILI_BILI_JCT;
  const dedeUserId = process.env.BILIBILI_DEDEUSERID;
  if (sessdata) {
    logger.debug('Bilibili', '從環境變數載入 Cookies（記憶體模式）');
    const parts = [`SESSDATA=${sessdata}`];
    if (biliJct)    parts.push(`bili_jct=${biliJct}`);
    if (dedeUserId) parts.push(`DedeUserID=${dedeUserId}`);
    BILIBILI_COOKIES_FILE  = null;
    BILIBILI_COOKIE_HEADER = parts.join('; ');
    return;
  }
  logger.debug('Bilibili', '未找到 Cookies，播放可能失敗');
  BILIBILI_COOKIES_FILE  = null;
  BILIBILI_COOKIE_HEADER = null;
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

function classifyBilibiliError(errorOutput) {
  if (errorOutput.includes('412')) return { msg: 'Bilibili 反爬蟲限制 (412)' };
  if (errorOutput.includes('403')) return { msg: '影片無法訪問 (403)，可能有地區限制或需要大會員' };
  if (errorOutput.includes('404')) return { msg: '找不到影片 (404)' };
  return { msg: `未知錯誤: ${errorOutput.slice(-150)}` };
}

module.exports = {
  BILIBILI_HEADERS,
  prepareBilibiliCookies,
  buildBilibiliArgs,
  buildBilibiliSearchArgs,
  classifyBilibiliError,
  // 供 youtube.js 的 buildInfoArgs / buildPlaylistCheckArgs 共用邏輯讀取狀態
  getBilibiliCookieState: () => ({ file: BILIBILI_COOKIES_FILE, header: BILIBILI_COOKIE_HEADER }),
};
