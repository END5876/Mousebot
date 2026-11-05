'use strict';
// admin/agent.js
// ─────────────────────────────────────────────────────────────
// 管理 API（agent）：給中央管理面板（admin-panel 服務）呼叫的 Bot 端 HTTP API。
// 這個檔案在 Mousebot 與 mousebot-lite 完全相同；各 Bot 不同的部分在 admin/api/（路由與 features）。
//
// 為什麼 API 還是留在 Bot 程序內：
//   各模組的設定都快取在記憶體裡（aiChance、autojoin、播放佇列…），從外部改 data/*.json 不會生效；
//   語音連線、播放佇列、log 也只存在這個程序裡。直接呼叫各模組的函式，記憶體與檔案才會一致。
//   網頁、登入、操作紀錄則都在 admin-panel：一個面板就能管理所有 Bot。
//
// 預設關閉：只有設定了 ADMIN_AGENT_TOKEN 才會啟動。
//
// 環境變數：
//   ADMIN_AGENT_TOKEN   管理面板呼叫時帶的金鑰（Authorization: Bearer …；未設定＝不啟動；至少 32 個字元）。
//                       要和 admin-panel 的 PANEL_BOTS 裡這隻 Bot 的 token 相同
//   ADMIN_PORT          監聽埠（預設 3940）
//   ADMIN_HOST          監聽位址（預設 127.0.0.1）。在 Docker 裡讓面板連進來時設 0.0.0.0，
//                       但不要讓反向代理把這個 port 對外公開——網頁一律經由 admin-panel
//
// 協定（protocol 1）：
//   GET  /api/me        Bot 身分、Discord 連線狀態、這隻 Bot 支援的功能（features）
//   其餘 /api/*         見 admin/api/*.js；寫入請求的 body 是 JSON
//   請求標頭 x-admin-source：面板看到的使用者來源（URL 編碼，只用來寫 log）
//   回應標頭 x-admin-audit：這次請求做了哪些變更（base64url 編碼的 JSON 字串陣列），由面板寫進操作紀錄

const crypto = require('crypto');
const http = require('http');
const logger = require('../utils/logger');
const bootSummary = require('../utils/bootSummary');
const { Router, HttpError, FileResponse } = require('./http');
const { botSummary } = require('./discordInfo');

const PROTOCOL = 1;
const MIN_TOKEN_LENGTH = 32;
// 還原設定備份時整份備份檔會放在 body 裡（含統計資料、多個人格檔時可能到幾 MB）
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_LENGTH = 200;
const SUMMARY_NAME = '管理 API';

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

// 固定長度雜湊後再 timingSafeEqual，避免長度不同時洩漏資訊
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
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

async function parseJsonBody(req) {
  const raw = await readBody(req, MAX_BODY_BYTES);
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

/** 面板帶來的來源（URL 編碼）只用來寫 log：解碼後去掉控制字元、限制長度 */
function sourceOf(req) {
  let raw = String(req.headers['x-admin-source'] || '');
  try { raw = decodeURIComponent(raw); } catch {}
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, MAX_SOURCE_LENGTH);
  return clean || null;
}

function isAuthorized(req, token) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return false;
  return safeEqual(header.slice(7), token);
}

function encodeAudit(actions) {
  return Buffer.from(JSON.stringify(actions), 'utf8').toString('base64url');
}

/**
 * @param {{ token: string, router: Router, client: import('discord.js').Client, app: string, features: () => string[] }} deps
 */
function createHandler({ token, router, client, app, features }) {
  return async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://agent.local');
    } catch {
      sendJson(res, 400, { error: '網址格式錯誤' });
      return;
    }

    try {
      // 金鑰錯誤一律 401，不透露路由是否存在
      if (!isAuthorized(req, token)) throw new HttpError(401, '管理 API 金鑰錯誤');
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, '找不到這個 API');

      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      const body = mutating ? await parseJsonBody(req) : {};

      if (url.pathname === '/api/me') {
        if (req.method !== 'GET') throw new HttpError(405, '不支援的方法');
        sendJson(res, 200, {
          protocol: PROTOCOL,
          app,
          features: features(),
          ready: client.isReady(),
          ping: client.ws.ping,
          bot: botSummary(client),
        });
        return;
      }

      const match = router.match(req.method, url.pathname);
      if (!match) throw new HttpError(404, '找不到這個 API');
      if (match.methodNotAllowed) throw new HttpError(405, '不支援的方法');

      // 處理函式用 audit('…') 描述這次做了什麼；整個請求成功才交給面板寫進操作紀錄
      const actions = [];
      const result = await match.handler({
        params: match.params,
        query: url.searchParams,
        body,
        audit: (text) => actions.push(String(text)),
      });

      const source = sourceOf(req);
      for (const action of actions) logger.info('Admin', `📝 ${action}${source ? `（${source}）` : ''}`);
      const auditHeader = actions.length ? { 'X-Admin-Audit': encodeAudit(actions) } : {};

      if (result instanceof FileResponse) {
        const data = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body, 'utf8');
        res.writeHead(200, {
          'Content-Type': result.contentType,
          'Content-Length': data.length,
          'Content-Disposition': `attachment; filename="${result.filename.replace(/[^\w.-]/g, '_')}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ...auditHeader,
        });
        res.end(data);
        return;
      }
      sendJson(res, 200, result ?? { ok: true }, auditHeader);
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
 * @param {{ app: string, register: (router: Router, client: any) => void, features: (client: any) => string[] }} api
 * @returns {http.Server|null}
 */
function startAgentServer(client, { app, register, features }) {
  const token = process.env.ADMIN_AGENT_TOKEN || '';
  if (!token) {
    bootSummary.report(SUMMARY_NAME, 'off', '未設定 ADMIN_AGENT_TOKEN');
    return null;
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    bootSummary.report(SUMMARY_NAME, 'warn', `ADMIN_AGENT_TOKEN 至少要 ${MIN_TOKEN_LENGTH} 個字元，未啟動`);
    return null;
  }

  const port = Number.parseInt(process.env.ADMIN_PORT ?? '3940', 10);
  if (!Number.isFinite(port) || port <= 0) {
    bootSummary.report(SUMMARY_NAME, 'off', 'ADMIN_PORT=0');
    return null;
  }
  const host = process.env.ADMIN_HOST || '127.0.0.1';

  const router = new Router();
  register(router, client);

  const server = http.createServer(createHandler({ token, router, client, app, features: () => features(client) }));
  server.requestTimeout = 60 * 1000;

  server.on('error', (err) => {
    logger.warn('Admin', `管理 API 啟動失敗：${err.message}`);
    bootSummary.report(SUMMARY_NAME, 'warn', `無法監聽 ${host}:${port}（${err.code || err.message}）`);
  });
  server.listen(port, host, () => {
    logger.debug('Admin', `管理 API：http://${host}:${port}/api/`);
    bootSummary.report(SUMMARY_NAME, 'ok', `監聽 ${host}:${port}（由 admin-panel 呼叫）`);
  });
  server.unref();
  return server;
}

module.exports = { startAgentServer, PROTOCOL };
