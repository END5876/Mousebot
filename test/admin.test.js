'use strict';

// 管理面板的 HTTP 層：登入、Cookie、CSRF、限流、靜態檔案、路由錯誤
// （不連線 Discord：用假的 client；只呼叫唯讀 API，不會寫入 data/）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 40000 + Math.floor(Math.random() * 10000);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-admin-'));
Object.assign(process.env, {
  ADMIN_PASSWORD: 'unit-test-password',
  ADMIN_PORT: String(PORT),
  ADMIN_HOST: '127.0.0.1',
  ADMIN_SESSION_SECRET: 's'.repeat(40), // 不產生 data/admin-session-secret
  ADMIN_AUDIT_FILE: path.join(TMP, 'audit.json'), // 操作紀錄寫到暫存資料夾
  ADMIN_REVOKED_FILE: path.join(TMP, 'revoked.json'), // 登出清單也是
  GROQ_API_KEY: process.env.GROQ_API_KEY || 'test', // sttHandler 載入時就會建立 Groq client，沒有金鑰會直接丟例外
  OWW_HTTP_URL: '',
  YT_POT_PROVIDER_URL: 'http://127.0.0.1:1',
  LOG_LEVEL: 'error',
});

const { startAdminServer } = require('../admin/server');
const { _ipv6Prefix64, _clientKey, createAuth } = require('../admin/auth');
const audit = require('../admin/audit');

const client = {
  isReady: () => false,
  user: null,
  ws: { status: 5, ping: -1 },
  guilds: { cache: new Map() },
  channels: { cache: new Map() },
  users: { cache: new Map() },
};

const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { 'x-mousebot-admin': '1', 'content-type': 'application/json' };
let server;
let xff = 0;

// 每個測試用不同的 X-Forwarded-For（連線來自本機＝私有網段，會採信它），登入限流彼此不干擾
function call(method, path, { body, cookie, headers = ADMIN, source } = {}) {
  return fetch(BASE + path, {
    method,
    headers: { ...headers, ...(cookie ? { cookie } : {}), ...(source ? { 'x-forwarded-for': source } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function login(password = 'unit-test-password', source = `10.0.0.${++xff}`) {
  const res = await call('POST', '/api/login', { body: { password }, source });
  return { res, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

test.before(async () => {
  server = startAdminServer(client);
  await new Promise((resolve) => server.once('listening', resolve));
});
test.after(() => {
  server.close();
  // 管理面板會載入整個 Bot 的模組，其中有常駐的計時器（例如 AI 圖片快取的定期清理），
  // 程序不會自己結束；等測試框架寫完結果與結束碼後再主動結束
  setTimeout(() => process.exit(), 500).unref();
});

test('admin：未登入讀 API → 401；寫入沒帶 CSRF header → 403', async () => {
  assert.equal((await call('GET', '/api/me')).status, 401);
  const res = await call('POST', '/api/login', { body: { password: 'x' }, headers: { 'content-type': 'application/json' } });
  assert.equal(res.status, 403);
});

test('admin：密碼正確才發 Cookie（HttpOnly、SameSite=Strict），登入後可讀 API', async () => {
  assert.equal((await login('wrong-password')).res.status, 401);
  const { res, cookie } = await login();
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /^mb_admin=\d+\.[\w-]+;/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.doesNotMatch(setCookie, /Secure/); // 純 HTTP 連線不加 Secure，否則瀏覽器不會存

  const me = await call('GET', '/api/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).ready, false);
});

test('admin：HTTPS 代理後面發的 Cookie 帶 Secure', async () => {
  const res = await call('POST', '/api/login', {
    body: { password: 'unit-test-password' },
    headers: { ...ADMIN, 'x-forwarded-proto': 'https' },
  });
  assert.match(res.headers.get('set-cookie'), /; Secure$/);
});

test('admin：竄改或過期的 Cookie 一律 401；登出後原本的 Cookie 失效', async () => {
  const { cookie } = await login();
  const [exp, mac] = cookie.slice('mb_admin='.length).split('.');
  assert.equal((await call('GET', '/api/me', { cookie: `mb_admin=${Number(exp) + 1}.${mac}` })).status, 401);
  assert.equal((await call('GET', '/api/me', { cookie: `mb_admin=1.${mac}` })).status, 401);
  assert.equal((await call('GET', '/api/me', { cookie: 'mb_admin=garbage' })).status, 401);

  assert.equal((await call('POST', '/api/logout', { cookie, body: {} })).status, 200);
  assert.equal((await call('GET', '/api/me', { cookie })).status, 401);
});

test('admin：同一來源連續失敗 10 次後被擋（429），其他來源不受影響', async () => {
  const source = '203.0.113.7';
  for (let i = 0; i < 10; i++) {
    assert.equal((await call('POST', '/api/login', { body: { password: 'nope' }, source })).status, 401);
  }
  const blocked = await call('POST', '/api/login', { body: { password: 'unit-test-password' }, source });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await login()).res.status, 200);
});

test('admin：靜態檔案帶安全標頭、擋路徑穿越、只提供已知類型', async () => {
  const index = await fetch(`${BASE}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(index.headers.get('x-frame-options'), 'DENY');

  const js = await fetch(`${BASE}/js/app.js`);
  assert.match(js.headers.get('content-type'), /^text\/javascript/);
  const etag = js.headers.get('etag');
  assert.equal((await fetch(`${BASE}/js/app.js`, { headers: { 'if-none-match': etag } })).status, 304);

  for (const p of ['/%2e%2e/package.json', '/..%2f..%2fpackage.json', '/js/', '/nope.txt']) {
    assert.equal((await fetch(BASE + p)).status, 404, p);
  }
});

test('admin：路由錯誤回明確的狀態碼', async () => {
  const { cookie } = await login();
  assert.equal((await call('GET', '/api/nope', { cookie })).status, 404);
  assert.equal((await call('POST', '/api/me', { cookie, body: {} })).status, 405);
  assert.equal((await call('PUT', '/api/responses', { cookie, body: '[]' })).status, 400);
  assert.equal((await call('PUT', '/api/responses', { cookie, body: 'x=1', headers: { 'x-mousebot-admin': '1', 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call('GET', '/api/voice', { cookie })).status, 503); // Discord 尚未就緒
});

test('admin：限流來源——IPv6 以 /64 為單位；私有網段連線才採信 X-Forwarded-For', () => {
  assert.equal(_ipv6Prefix64('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(_ipv6Prefix64('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(_ipv6Prefix64('::1'), '0:0:0:0::/64');

  const req = (remoteAddress, forwarded) => ({ socket: { remoteAddress }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });
  assert.equal(_clientKey(req('::ffff:10.42.0.1', '198.51.100.9, 203.0.113.5')), '203.0.113.5');
  assert.equal(_clientKey(req('198.51.100.20', '203.0.113.5')), '198.51.100.20');
  assert.equal(_clientKey(req('2001:db8:aa:bb:1:2:3:4')), '2001:db8:aa:bb::/64');
});

test('admin：登出清單存檔，重新啟動後已登出的 Cookie 仍然無效', () => {
  const opts = { password: 'unit-test-password', secretFile: path.join(TMP, 'secret'), sessionHours: 1, revokedFile: path.join(TMP, 'revoked-restart.json') };
  const req = (cookie) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: cookie ? { cookie } : {} });
  const before = createAuth(opts);
  const issue = () => before.login(req(), { password: 'unit-test-password' }).headers['Set-Cookie'][0].split(';')[0];
  const out = issue();
  let kept;
  do kept = issue(); while (kept === out); // 同一毫秒發的 Cookie 會一模一樣
  assert.equal(before.logout(req(out)).revoked, true);

  const after = createAuth(opts); // 模擬重新啟動：記憶體清空、金鑰不變
  assert.equal(after.isAuthenticated(req(out)), false);
  assert.equal(after.isAuthenticated(req(kept)), true);
});

test('admin：登入失敗在操作紀錄裡另有上限，擠不掉管理操作；同一來源連續失敗合併成一筆', () => {
  audit.record('測試用管理操作');
  for (let i = 0; i < 300; i++) audit.record('登入失敗（密碼錯誤）', { source: `198.51.100.${i}`, level: 'warn', unauth: true });
  audit.record('登入失敗（密碼錯誤）', { source: '198.51.100.299', level: 'warn', unauth: true });
  const all = audit.list({ limit: 2000 });
  assert.ok(all.some((e) => e.action === '測試用管理操作'));
  assert.ok(all.filter((e) => e.unauth).length <= 200);
  assert.equal(all.find((e) => e.source === '198.51.100.299').count, 2);
});
