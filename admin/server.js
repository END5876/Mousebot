'use strict';
// admin/server.js
// ─────────────────────────────────────────────────────────────
// 管理面板：在 Bot 程序裡開一個小型 HTTP 伺服器，提供網頁介面設定與管理 Bot。
//
// 為什麼放在 Bot 程序內，而不是像分帳 / 音樂庫那樣拆成獨立服務：
//   各模組的設定都快取在記憶體裡（aiChance、modeSelector、noticeService…），從外部改 data/*.json
//   不會生效；語音連線、播放佇列、log 也只存在這個程序裡。直接呼叫各模組的函式，記憶體與檔案才會一致。
//
// 預設關閉：只有設定了 ADMIN_PASSWORD 才會啟動。
//
// 環境變數：
//   ADMIN_PASSWORD        登入密碼（未設定＝不啟動；至少 12 個字元）
//   ADMIN_PORT            監聽埠（預設 3940）
//   ADMIN_HOST            監聽位址（預設 127.0.0.1＝只有本機連得到）。要從其他裝置連線時設 0.0.0.0，
//                         並務必經由 HTTPS（部署平台的網域、反向代理）存取，否則密碼會以明文傳送
//   ADMIN_SESSION_HOURS   登入有效時數（預設 168＝7 天）
//   ADMIN_SESSION_SECRET  簽 Cookie 用的金鑰（選填；未設定時自動產生並存在 data/admin-session-secret）
//
// 路由：
//   GET  /、/css/*、/js/*   管理面板網頁（admin/public）
//   POST /api/login         { password } → 設定 Cookie
//   POST /api/logout
//   其餘 /api/*             需要登入，見 admin/api/*.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const bootSummary = require('../utils/bootSummary');
const { createAuth, describeSource } = require('./auth');
const { Router, HttpError, FileResponse } = require('./http');
const audit = require('./audit');
const registerApi = require('./api');

const PUBLIC_DIR = path.join(__dirname, 'public');
const SECRET_FILE = path.join(__dirname, '..', 'data', 'admin-session-secret');
// 已登出的 Cookie（ADMIN_REVOKED_FILE：改放到別的位置，給測試用）
const REVOKED_FILE = process.env.ADMIN_REVOKED_FILE || path.join(__dirname, '..', 'data', 'admin-revoked.json');
const MIN_PASSWORD_LENGTH = 12;
const MAX_BODY_BYTES = 256 * 1024;
const LOGIN_BODY_BYTES = 2 * 1024;
// 所有寫入請求都要帶這個 header（CSRF 防護，見 auth.js）
const CSRF_HEADER = 'x-mousebot-admin';
const SUMMARY_NAME = '管理面板';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// 網頁只載入自己的檔案；圖片放行 https（Discord 頭像、限免遊戲封面）
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, data, headers = {}) {
  send(res, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  }, JSON.stringify(data));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // 不再讀取；回應時帶 Connection: close，送完就關閉連線
        req.off('data', onData);
        req.pause();
        reject(new HttpError(413, '資料太大'));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseJsonBody(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw) return {};
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, '只接受 JSON');
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch {
    throw new HttpError(400, 'JSON 格式錯誤');
  }
}

// ════════════════════════════════════════════════════════
//  靜態檔案
// ════════════════════════════════════════════════════════
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { Allow: 'GET, HEAD' });
    return;
  }

  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    send(res, 400, {});
    return;
  }
  // path.resolve 會把 .. 正規化掉；結果不在 public 目錄裡就當作不存在
  const file = path.resolve(PUBLIC_DIR, `.${rel}`);
  const type = MIME[path.extname(file).toLowerCase()];
  if (rel.includes('\0') || !file.startsWith(PUBLIC_DIR + path.sep) || !type) {
    send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
    return;
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
      return;
    }
    // 每次都向伺服器確認有沒有更新（部署後不會卡在舊版），沒變就回 304
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag };
    if (req.headers['if-none-match'] === etag) {
      send(res, 304, headers);
      return;
    }
    if (req.method === 'HEAD') {
      send(res, 200, { ...headers, 'Content-Length': stat.size });
      return;
    }
    res.writeHead(200, { ...SECURITY_HEADERS, ...headers, 'Content-Length': stat.size });
    fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  });
}

// ════════════════════════════════════════════════════════
//  API
// ════════════════════════════════════════════════════════
async function handleApi(req, res, url, { auth, router }) {
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  if (mutating && req.headers[CSRF_HEADER] !== '1') {
    throw new HttpError(403, '請從管理面板網頁操作');
  }

  // 稽核紀錄的來源：經由反向代理時一併記下 TCP 連線位址（見 auth.describeSource）
  const source = describeSource(req);

  if (url.pathname === '/api/login' || url.pathname === '/api/logout') {
    if (req.method !== 'POST') throw new HttpError(405, '不支援的方法');
    const isLogin = url.pathname === '/api/login';
    const result = isLogin ? auth.login(req, await parseJsonBody(req, LOGIN_BODY_BYTES)) : auth.logout(req);
    // 🔒 只有真的登出了一個有效的 session 才記錄：以前沒登入的請求也會寫一筆「登出」，
    // 送 1000 次就能把稽核紀錄（與日誌頁）裡真正的管理操作全部擠掉
    if (!isLogin) { if (result.revoked) audit.record('登出', { source }); }
    else if (result.status === 200) audit.record('登入成功', { source });
    // 🔒 登入失敗不需要登入就能觸發：標成 unauth，在操作紀錄裡另有上限，擠不掉真正的管理操作（見 audit.js）
    else if (result.status === 401) audit.record('登入失敗（密碼錯誤）', { source, level: 'warn', unauth: true });
    sendJson(res, result.status, result.body, result.headers);
    return;
  }

  // 先驗證登入才讀取 body：未登入的請求不必等它上傳完
  if (!auth.isAuthenticated(req)) throw new HttpError(401, '請先登入');
  const body = mutating ? await parseJsonBody(req, MAX_BODY_BYTES) : {};

  const match = router.match(req.method, url.pathname);
  if (!match) throw new HttpError(404, '找不到這個 API');
  if (match.methodNotAllowed) throw new HttpError(405, '不支援的方法');

  // 處理函式用 audit('…') 描述這次做了什麼；整個請求成功才寫進操作紀錄
  const actions = [];
  const result = await match.handler({
    params: match.params,
    query: url.searchParams,
    body,
    audit: (text) => actions.push(text),
  });
  for (const action of actions) audit.record(action, { source });

  if (result instanceof FileResponse) {
    const data = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body, 'utf8');
    send(res, 200, {
      'Content-Type': result.contentType,
      'Content-Length': data.length,
      'Content-Disposition': `attachment; filename="${result.filename.replace(/[^\w.-]/g, '_')}"`,
      'Cache-Control': 'no-store',
    }, data);
    return;
  }
  sendJson(res, 200, result ?? { ok: true });
}

function createHandler(deps) {
  return async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://admin.local');
    } catch {
      send(res, 400, {});
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      serveStatic(req, res, url.pathname);
      return;
    }

    try {
      await handleApi(req, res, url, deps);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message }, err.status === 413 ? { Connection: 'close' } : {});
        return;
      }
      logger.error('Admin', `${req.method} ${url.pathname} 失敗：`, err);
      sendJson(res, 500, { error: `伺服器錯誤：${err.message}` });
    }
  };
}

/**
 * @param {import('discord.js').Client} client
 * @returns {http.Server|null}
 */
function startAdminServer(client) {
  const password = process.env.ADMIN_PASSWORD || '';
  if (!password) {
    bootSummary.report(SUMMARY_NAME, 'off', '未設定 ADMIN_PASSWORD');
    return null;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    bootSummary.report(SUMMARY_NAME, 'warn', `ADMIN_PASSWORD 至少要 ${MIN_PASSWORD_LENGTH} 個字元，未啟動`);
    return null;
  }

  const port = Number.parseInt(process.env.ADMIN_PORT ?? '3940', 10);
  if (!Number.isFinite(port) || port <= 0) {
    bootSummary.report(SUMMARY_NAME, 'off', 'ADMIN_PORT=0');
    return null;
  }
  const host = process.env.ADMIN_HOST || '127.0.0.1';
  const sessionHours = Math.max(1, Number.parseFloat(process.env.ADMIN_SESSION_HOURS || '168') || 168);

  const auth = createAuth({ password, secretFile: SECRET_FILE, sessionHours, revokedFile: REVOKED_FILE });
  const router = new Router();
  registerApi(router, client);

  const server = http.createServer(createHandler({ auth, router }));
  server.requestTimeout = 60 * 1000;

  // 開機摘要在 Discord 就緒後才印，監聽的結果（成功或失敗）在那之前就會回報
  server.on('error', (err) => {
    logger.warn('Admin', `管理面板啟動失敗：${err.message}`);
    bootSummary.report(SUMMARY_NAME, 'warn', `無法監聽 ${host}:${port}（${err.code || err.message}）`);
  });
  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    logger.debug('Admin', `管理面板：http://${shown}:${port}/`);
    bootSummary.report(SUMMARY_NAME, 'ok', `http://${shown}:${port}/${host === shown ? '' : `（監聽 ${host}）`}`);
  });
  server.unref();
  return server;
}

module.exports = { startAdminServer };
