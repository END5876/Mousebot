// handlers/musicplayer/antibot/config.js
// 職責：Proxy 設定、Cookies 檔案路徑準備（Bilibili / YouTube 共用的
// 讀取邏輯與記憶體狀態），供 bilibili.js / youtube.js 共用

const fs   = require('fs');
const path = require('path');
const logger = require('../../../utils/logger');

// ════════════════════════════════════════════════════════
//  Proxy 設定 (Cloudflare WARP)
// ════════════════════════════════════════════════════════
const WARP_PROXY = process.env.WARP_PROXY_URL;

if (WARP_PROXY) {
  logger.debug('Proxy', `已設定 WARP_PROXY_URL，YouTube 請求將透過 Proxy 轉發: ${WARP_PROXY}`);
} else {
  logger.debug('Proxy', '未設定 WARP_PROXY_URL，YouTube 請求將直接使用本地網路連線');
}

// ════════════════════════════════════════════════════════
//  Cookies 檔案路徑（僅保留「已存在的外部檔案」路徑，不自動建立）
// ════════════════════════════════════════════════════════
const COOKIES_PATH    = path.join(__dirname, '..', '..', 'cookies.txt');
const YT_COOKIES_PATH = path.join(__dirname, '..', '..', 'yt_cookies.txt');

// ── 共用的 Cookie 附加工具 ─────────────────────────────
function _appendCookieArgs(args, cookiesFile, cookieHeader) {
  if (cookiesFile) {
    args.push('--cookies', cookiesFile);
  } else if (cookieHeader) {
    args.push('--add-header', `Cookie:${cookieHeader}`);
  }
}

module.exports = {
  fs,
  WARP_PROXY,
  COOKIES_PATH,
  YT_COOKIES_PATH,
  _appendCookieArgs,
};
