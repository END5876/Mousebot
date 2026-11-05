'use strict';

// 管理 API（admin/agent.js）的 HTTP 層：金鑰驗證、/api/me、操作紀錄標頭、檔案下載、錯誤狀態碼。
// 這個檔案在 Mousebot 與 mousebot-lite 完全相同。
// 不連線 Discord：用假的 client；測試路由自己註冊，最後只確認真正的 API 模組都載入得起來（不呼叫寫入的 API）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 40000 + Math.floor(Math.random() * 10000);
const TOKEN = 't'.repeat(40);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-agent-'));
Object.assign(process.env, {
  ADMIN_AGENT_TOKEN: TOKEN,
  ADMIN_PORT: String(PORT),
  ADMIN_HOST: '127.0.0.1',
  MOUSEBOT_DATA_DIR: TMP,
  GROQ_API_KEY: process.env.GROQ_API_KEY || 'test', // 正式版的 sttHandler 載入時就會建立 Groq client
  OWW_HTTP_URL: '',
  YT_POT_PROVIDER_URL: 'http://127.0.0.1:1',
  LOG_LEVEL: 'error',
});

const { startAgentServer } = require('../admin/agent');
const { Router, FileResponse, HttpError } = require('../admin/http');

const client = {
  isReady: () => false,
  user: null,
  ws: { status: 5, ping: -1 },
  guilds: { cache: new Map() },
  channels: { cache: new Map() },
  users: { cache: new Map() },
};

const BASE = `http://127.0.0.1:${PORT}`;
let server;

function call(method, p, { body, token = TOKEN, headers = {} } = {}) {
  return fetch(BASE + p, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const decodeAudit = (res) => JSON.parse(Buffer.from(res.headers.get('x-admin-audit'), 'base64url').toString('utf8'));

test.before(async () => {
  server = startAgentServer(client, {
    app: 'unit-test',
    features: () => ['overview', 'voice:join'],
    register(router) {
      router.put('/api/things/:id', ({ params, body, audit }) => {
        if (body.fail) throw new HttpError(400, '故意失敗');
        audit(`改了 ${params.id}`);
        audit('第二件事');
        return { id: params.id, value: body.value };
      });
      router.get('/api/download', ({ audit }) => {
        audit('下載檔案');
        return new FileResponse({ filename: 'a b.json', contentType: 'application/json', body: '{"x":1}' });
      });
      router.get('/api/boom', () => { throw new Error('爆炸'); });
    },
  });
  await new Promise((resolve) => server.once('listening', resolve));
});
test.after(() => {
  server.close();
  // 載入 Bot 的模組會留下常駐的計時器，程序不會自己結束；等測試框架寫完結果後再主動結束
  setTimeout(() => process.exit(), 500).unref();
});

test('agent：沒帶金鑰或金鑰錯誤一律 401（連不存在的路徑也一樣）', async () => {
  assert.equal((await call('GET', '/api/me', { token: null })).status, 401);
  assert.equal((await call('GET', '/api/me', { token: 'x'.repeat(40) })).status, 401);
  assert.equal((await call('GET', '/nope', { token: null })).status, 401);
  assert.equal((await call('GET', '/api/me', { token: null, headers: { authorization: TOKEN } })).status, 401);
});

test('agent：/api/me 回報協定版本、Bot 代號、功能與連線狀態', async () => {
  const res = await call('GET', '/api/me');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    protocol: 1, app: 'unit-test', features: ['overview', 'voice:join'], ready: false, ping: -1, bot: null,
  });
});

test('agent：成功的寫入把操作描述放在 x-admin-audit；失敗的不放', async () => {
  const ok = await call('PUT', '/api/things/abc', { body: { value: 3 }, headers: { 'x-admin-source': '1.2.3.4' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { id: 'abc', value: 3 });
  assert.deepEqual(decodeAudit(ok), ['改了 abc', '第二件事']);

  const bad = await call('PUT', '/api/things/abc', { body: { fail: true } });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, '故意失敗');
  assert.equal(bad.headers.get('x-admin-audit'), null);
});

test('agent：FileResponse 以下載回應，檔名只留安全字元', async () => {
  const res = await call('GET', '/api/download');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="a_b.json"');
  assert.deepEqual(decodeAudit(res), ['下載檔案']);
  assert.equal(await res.text(), '{"x":1}');
});

test('agent：路由與 body 錯誤回明確的狀態碼', async () => {
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await call('GET', '/elsewhere')).status, 404);
  assert.equal((await call('POST', '/api/things/abc', { body: {} })).status, 405);
  assert.equal((await call('POST', '/api/me', { body: {} })).status, 405);
  assert.equal((await call('PUT', '/api/things/abc', { body: '{', headers: {} })).status, 400);
  assert.equal((await call('PUT', '/api/things/abc', { body: '[]' })).status, 400);
  const wrongType = await fetch(`${BASE}/api/things/abc`, {
    method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' }, body: 'x',
  });
  assert.equal(wrongType.status, 415);
  const big = await call('PUT', '/api/things/abc', { body: JSON.stringify({ v: 'x'.repeat(300 * 1024) }) });
  assert.equal(big.status, 413);
  const boom = await call('GET', '/api/boom');
  assert.equal(boom.status, 500);
});

test('agent：這隻 Bot 的 API 模組都載入得起來，features 只列出有效的頁面代號', () => {
  const api = require('../admin/api');
  const router = new Router();
  api.register(router, client);
  assert.ok(router.routes.length > 5);
  assert.equal(typeof api.app, 'string');
  const pages = ['overview', 'responses', 'prompts', 'ai', 'usage', 'voice', 'tts', 'notify', 'status', 'maintenance', 'logs'];
  for (const f of api.features(client)) {
    assert.ok(pages.includes(f.split(':')[0]), `未知的功能 ${f}`);
  }
  // 回報的頁面都要有對應的 API
  const has = (p) => router.routes.some((r) => r.re.test(p));
  const PROBE = { usage: '/api/ai/usage', voice: '/api/voice', status: '/api/presence', maintenance: '/api/system', logs: '/api/logs', overview: '/api/overview' };
  for (const f of api.features(client)) if (PROBE[f]) assert.ok(has(PROBE[f]), `${f} 沒有 ${PROBE[f]}`);
});

test('agent：沒設定或太短的 ADMIN_AGENT_TOKEN 不啟動', () => {
  const saved = process.env.ADMIN_AGENT_TOKEN;
  try {
    process.env.ADMIN_AGENT_TOKEN = '';
    assert.equal(startAgentServer(client, { app: 'x', register() {}, features: () => [] }), null);
    process.env.ADMIN_AGENT_TOKEN = 'short';
    assert.equal(startAgentServer(client, { app: 'x', register() {}, features: () => [] }), null);
  } finally {
    process.env.ADMIN_AGENT_TOKEN = saved;
  }
});
