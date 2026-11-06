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
  // 超過上限：伺服器回 413 並關閉連線、不再讀取。用戶端還在上傳時，有時收到的是連線被中斷而不是 413，兩種都算擋下
  const big = await call('PUT', '/api/things/abc', { body: JSON.stringify({ v: 'x'.repeat(9 * 1024 * 1024) }) })
    .then((res) => res.status, () => 'connection closed');
  assert.ok([413, 'connection closed'].includes(big), `超過上限沒有被擋下：${big}`);
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
  const PROBE = { ai: '/api/ai/settings', usage: '/api/ai/usage', voice: '/api/voice', status: '/api/presence', maintenance: '/api/system', logs: '/api/logs', overview: '/api/overview' };
  for (const f of api.features(client)) if (PROBE[f]) assert.ok(has(PROBE[f]), `${f} 沒有 ${PROBE[f]}`);
});

// 依 FEATURES 決定的頁面與路由：模組 setup／載入會掛計時器，所以在子程序裡跑（見 utils/features.js）
const PROBE_PATHS = [
  '/api/voice', '/api/voice/1/join', '/api/voice/1/wake-word', '/api/music/library', '/api/autojoin',
  '/api/tts', '/api/notify', '/api/time-announcer/1', '/api/ai/settings', '/api/prompts', '/api/responses',
];

const API_SCRIPT = `
const { Router } = require('./admin/http');
const api = require('./admin/api');
const client = { isReady: () => false, user: null, ws: { status: 5, ping: -1 },
  guilds: { cache: new Map() }, channels: { cache: new Map() }, users: { cache: new Map() } };
const router = new Router();
api.register(router, client);
const paths = ${JSON.stringify(PROBE_PATHS)};
const routes = Object.fromEntries(paths.map((p) => [p, router.routes.some((r) => r.re.test(p))]));
process.stdout.write(JSON.stringify({ app: api.app, features: api.features(client), routes }));
process.exit(0);
`;

function runApi(vars) {
  const { spawnSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-agent-api-'));
  try {
    const env = { ...process.env, MOUSEBOT_DATA_DIR: tmp, LOG_LEVEL: 'error', ...vars };
    delete env.FEATURES;
    if (vars.FEATURES !== undefined) env.FEATURES = vars.FEATURES;
    const res = spawnSync(process.execPath, ['-e', API_SCRIPT], {
      cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(res.status, 0, `子程序失敗：
${res.stderr}${res.error ? `
${res.error}` : ''}`);
    return JSON.parse(res.stdout);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const API_FULL_ENV = { GEMINI_API_KEY: 'x', GROQ_API_KEY: 'x', SPLITBILL_SERVICE_URL: 'http://splitbill.example' };
// 下面幾個案例斷言正式版才有的頁面（TTS、通知、自訂回應）與多人格的 AI 設定；精簡版的對應行為由 liteBaseline／adminAi 測試涵蓋
const MB_ONLY = { skip: require('../profile').app !== 'mousebot' && '只在正式版（Mousebot）成立' };

test('agent：沒設 FEATURES 時回報的頁面與原本相同，選用頁面的路由都有註冊', MB_ONLY, () => {
  const r = runApi(API_FULL_ENV);
  assert.equal(r.app, 'mousebot');
  assert.deepEqual([...r.features].sort(), [
    'overview', 'responses', 'prompts', 'ai', 'usage', 'voice', 'tts', 'notify', 'status', 'maintenance', 'logs',
    'voice:join', 'voice:wakeWord', 'maintenance:backup',
  ].sort());
  for (const [p, has] of Object.entries(r.routes)) assert.ok(has, `缺少 ${p}`);
});

test('agent：FEATURES=music,autojoin 只回報語音頁，不註冊 TTS、通知、AI 與手動加入／喚醒詞路由', () => {
  const r = runApi({ ...API_FULL_ENV, FEATURES: 'music,autojoin' });
  const has = new Set(r.features);
  assert.ok(has.has('voice'));
  for (const f of ['tts', 'notify', 'voice:join', 'voice:wakeWord', 'ai', 'prompts', 'usage', 'responses']) {
    assert.ok(!has.has(f), `不應回報 ${f}`);
  }
  assert.deepEqual(r.routes, {
    '/api/voice': true, '/api/voice/1/join': false, '/api/voice/1/wake-word': false,
    '/api/music/library': true, '/api/autojoin': true,
    '/api/tts': false, '/api/notify': false, '/api/time-announcer/1': false,
    '/api/ai/settings': false, '/api/prompts': false, '/api/responses': false,
  });
});

test('agent：FEATURES=notice 時通知頁沒有整點報時路由，語音頁不回報', MB_ONLY, () => {
  const r = runApi({ FEATURES: 'notice' });
  assert.ok(r.features.includes('notify'));
  assert.ok(!r.features.includes('voice'));
  assert.equal(r.routes['/api/notify'], true);
  assert.equal(r.routes['/api/time-announcer/1'], false);
  assert.equal(r.routes['/api/voice'], false);
});

// GET /api/voice：music 沒啟用時多回傳 musicControl:false（面板據此不顯示「點歌」），啟用時不加這個欄位
const VOICE_SCRIPT = `
const { Router } = require('./admin/http');
const api = require('./admin/api');
const client = { isReady: () => true, user: null, ws: { status: 0, ping: 1 },
  guilds: { cache: new Map() }, channels: { cache: new Map() }, users: { cache: new Map() } };
const router = new Router();
api.register(router, client);
const m = router.match('GET', '/api/voice');
Promise.resolve(m.handler({ params: m.params, query: new URLSearchParams(), body: null }))
  .then((r) => { process.stdout.write(JSON.stringify(r)); process.exit(0); });
`;

function runVoice(vars) {
  const { spawnSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-agent-voice-'));
  try {
    const env = { ...process.env, MOUSEBOT_DATA_DIR: tmp, LOG_LEVEL: 'error', ...vars };
    delete env.FEATURES;
    if (vars.FEATURES !== undefined) env.FEATURES = vars.FEATURES;
    const res = spawnSync(process.execPath, ['-e', VOICE_SCRIPT], {
      cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(res.status, 0, `子程序失敗：\n${res.stderr}`);
    return JSON.parse(res.stdout);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('agent：GET /api/voice 只在 music 沒啟用時回傳 musicControl:false', MB_ONLY, () => {
  assert.deepEqual(Object.keys(runVoice(API_FULL_ENV)).sort(), ['autoJoin', 'guilds']);
  const noMusic = runVoice({ ...API_FULL_ENV, FEATURES: 'voice' });
  assert.equal(noMusic.musicControl, false);
  assert.equal(noMusic.autoJoin, null);
});

// GET /api/ai/settings：AI_USER_MODE_OVERRIDES 的固定人格放在 fixedUserModes（取代舊的 specialUsers）
const AI_SETTINGS_SCRIPT = `
const fs = require('fs');
const path = require('path');
const dir = process.env.MOUSEBOT_DATA_DIR;
fs.mkdirSync(path.join(dir, 'prompts', 'modes'), { recursive: true });
fs.writeFileSync(path.join(dir, 'prompts', 'modes', 'special.md'), '---\\nname: 特別\\n---\\nSPECIAL');
fs.writeFileSync(path.join(dir, 'userModes.json'), JSON.stringify({ '900000000000000002': 'special' }));
const { Router } = require('./admin/http');
const api = require('./admin/api');
const known = { id: '900000000000000001', username: 'fixed', globalName: null, displayAvatarURL: () => null };
const client = { isReady: () => true, user: null, ws: { status: 0, ping: 1 },
  guilds: { cache: new Map() }, channels: { cache: new Map() },
  users: { cache: new Map([[known.id, known]]), fetch: async () => { throw new Error('unknown'); } } };
const router = new Router();
api.register(router, client);
const m = router.match('GET', '/api/ai/settings');
Promise.resolve(m.handler({ params: m.params, query: new URLSearchParams(), body: undefined, audit() {} })).then((r) => {
  process.stdout.write(JSON.stringify({ hasSpecial: 'specialUsers' in r, fixedUserModes: r.fixedUserModes }));
  process.exit(0);
});
`;

test('agent：/api/ai/settings 用 fixedUserModes 列出固定人格，沒有 specialUsers', MB_ONLY, () => {
  const { spawnSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-agent-ai-'));
  try {
    const env = {
      ...process.env, ...API_FULL_ENV, MOUSEBOT_DATA_DIR: tmp, LOG_LEVEL: 'error',
      AI_USER_MODE_OVERRIDES: '900000000000000001:special,900000000000000002:gone',
    };
    delete env.FEATURES;
    delete env.AI_DEFAULT_MODE;
    const res = spawnSync(process.execPath, ['-e', AI_SETTINGS_SCRIPT], {
      cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(res.status, 0, `子程序失敗：\n${res.stderr}`);
    const r = JSON.parse(res.stdout);
    assert.equal(r.hasSpecial, false);
    assert.ok(Array.isArray(r.fixedUserModes));
    assert.deepEqual(r.fixedUserModes.map(({ user, ...rest }) => ({ id: user.id, missing: user.missing, ...rest })), [
      { id: '900000000000000001', missing: false, mode: 'special', modeName: '特別', overridden: false },
      // 模式檔不存在 → modeName 為 null；這個人已用 /ai mode 指定 → overridden
      { id: '900000000000000002', missing: true, mode: 'gone', modeName: null, overridden: true },
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
