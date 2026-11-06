'use strict';

// 管理 API 的 AI 設定（admin/api/ai.js）：鎖定（單一人格）與不鎖定（多人格）各一組。
// 用假的 Discord client，直接呼叫路由的處理函式；資料檔寫到暫存資料夾。
// 先跑鎖定組（AI_SCOPE_LOCK=single，FEATURES 只開兩個 Bot 都有的功能），再改成 AI_SCOPE_LOCK=off、persona._reset() 跑不鎖定組。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-admin-ai-'));
process.env.MOUSEBOT_DATA_DIR = TMP;
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key'; // 讓 admin/api/index.js 註冊 AI 路由
process.env.LOG_LEVEL = 'error';
process.env.AI_SCOPE_LOCK = 'single';
process.env.AI_PERSONA = 'testfish';
process.env.AI_RANDOM_SLOT = '0/2';
process.env.FEATURES = 'ai,autojoin,music';
delete process.env.AI_USER_MODE_OVERRIDES;
delete process.env.AI_DEFAULT_MODE;

const { Router, HttpError } = require('../admin/http');
const aiChance = require('../handlers/ai/aiChance');
const aiMemoryState = require('../handlers/ai/aiMemoryState');
const persona = require('../handlers/ai/persona');
const { ChannelType } = require('discord.js');

const GUILD = '111111111111111111';
const TEXT = '222222222222222222';
const VOICE = '333333333333333333';
const USER = '444444444444444444';

function fakeChannel(id, name, type, rawPosition) {
  return { id, name, type, rawPosition, parent: null, guild: null, guildId: GUILD, viewable: true, permissionsFor: () => ({ has: () => true }) };
}

const channels = new Map([
  [TEXT, fakeChannel(TEXT, '聊天', ChannelType.GuildText, 0)],
  [VOICE, fakeChannel(VOICE, '語音', ChannelType.GuildVoice, 1)],
]);
const guild = {
  id: GUILD, name: '測試伺服器', memberCount: 3,
  iconURL: () => null,
  channels: { cache: channels },
  members: { me: { id: 'me' } },
};
for (const c of channels.values()) c.guild = guild;
const client = {
  isReady: () => true,
  user: null,
  ws: { status: 0, ping: 10 },
  guilds: { cache: new Map([[GUILD, guild]]) },
  channels: { cache: channels },
  users: { cache: new Map() },
};

const api = require('../admin/api');
const lockedRouter = new Router();
api.register(lockedRouter, client);

function caller(router) {
  return async (method, p, body = {}) => {
    const url = new URL(p, 'http://x');
    const m = router.match(method, url.pathname);
    assert.ok(m && !m.methodNotAllowed, `${method} ${p} 沒有路由`);
    const actions = [];
    const result = await m.handler({ params: m.params, query: url.searchParams, body, audit: (t) => actions.push(t) });
    return { result, actions };
  };
}

const hasRoute = (router, method, p) => {
  const m = router.match(method, p);
  return !!m && !m.methodNotAllowed;
};

const isCached = (rel) => Object.keys(require.cache).some((f) => f.replace(/\\/g, '/').endsWith(rel));

// ── 鎖定（單一人格）──────────────────────────────────────
const call = caller(lockedRouter);

test('鎖定：有 GEMINI_API_KEY 時回報 ai 與 usage 頁', () => {
  const features = api.features(client);
  assert.ok(features.includes('ai'));
  assert.ok(features.includes('usage'));
});

test('鎖定：設定總覽是單一人格的格式（沒有使用者人格、範圍、固定人格）', async () => {
  const { result } = await call('GET', '/api/ai/settings');
  assert.equal(typeof result.model, 'string');
  assert.equal(result.memoryScope, 'channel');
  assert.equal(result.persona.key, 'testfish');
  assert.equal(result.persona.fromFile, false);
  assert.equal(result.persona.name, persona.BUILTIN_PERSONA_NAME);
  assert.equal(result.userModes, undefined);
  assert.equal(result.modes, undefined);
  assert.equal(result.visionModel, undefined);
  assert.equal(result.fixedUserModes, undefined);
  assert.equal(result.replyChance.default, aiChance.DEFAULT_CHANCE);
  const [g] = result.replyChance.guilds;
  assert.equal(g.id, GUILD);
  assert.equal(g.chance, null);
  assert.equal(g.scope, undefined);
  assert.deepEqual(g.channels.map((c) => [c.id, c.disabled]), [[TEXT, false], [VOICE, false]]);
});

test('鎖定：插話機率設定、恢復預設、頻道開關都寫進操作紀錄', async () => {
  let r = await call('PUT', `/api/ai/chance/${GUILD}`, { chance: 0.25 });
  assert.equal(r.result.chance, 0.25);
  assert.match(r.actions[0], /測試伺服器.*25%/);
  assert.equal(aiChance.listReplyChances()[GUILD], 0.25);

  r = await call('DELETE', `/api/ai/chance/${GUILD}`);
  assert.equal(aiChance.listReplyChances()[GUILD], undefined);
  assert.match(r.actions[0], /恢復預設/);

  r = await call('PUT', `/api/ai/channels/${TEXT}`, { disabled: true });
  assert.equal(r.result.disabled, true);
  assert.ok(aiChance.listDisabledChannels().includes(TEXT));
  const { result } = await call('GET', '/api/ai/settings');
  assert.equal(result.replyChance.guilds[0].channels.find((c) => c.id === TEXT).disabled, true);
  await call('PUT', `/api/ai/channels/${TEXT}`, { disabled: false });

  await assert.rejects(call('PUT', `/api/ai/chance/${GUILD}`, { chance: 5 }), HttpError);
});

test('鎖定：清除頻道記憶（等同 /ai clear all:true）', async () => {
  const before = aiMemoryState.getChannelClearTime(TEXT);
  const { actions } = await call('POST', `/api/ai/memory/channel/${TEXT}`);
  assert.ok(aiMemoryState.getChannelClearTime(TEXT) > before);
  assert.match(actions[0], /測試伺服器 › #聊天/);
  await assert.rejects(call('POST', '/api/ai/memory/channel/999999999999999999'), (err) => err.status === 404);
});

test('鎖定：不註冊範圍、使用者人格、清除個人記憶、成員搜尋，也不載入 aiScope、modeSelector', () => {
  assert.equal(hasRoute(lockedRouter, 'PUT', `/api/ai/scope/${GUILD}`), false);
  assert.equal(hasRoute(lockedRouter, 'PUT', `/api/ai/scope/channel/${TEXT}`), false);
  assert.equal(hasRoute(lockedRouter, 'PUT', `/api/ai/user-modes/${USER}`), false);
  assert.equal(hasRoute(lockedRouter, 'POST', `/api/ai/memory/${USER}`), false);
  assert.equal(hasRoute(lockedRouter, 'GET', '/api/members/search'), false);
  assert.equal(hasRoute(lockedRouter, 'GET', '/api/ai/usage'), true);
  assert.equal(isCached('handlers/ai/aiScope.js'), false);
  assert.equal(isCached('handlers/ai/modeSelector.js'), false);
});

// ── 不鎖定（多人格）──────────────────────────────────────
let multi = null;
function multiRouter() {
  if (!multi) {
    process.env.AI_SCOPE_LOCK = 'off';
    persona._reset();
    multi = new Router();
    require('../admin/api/ai')(multi, client);
  }
  return multi;
}
const callMulti = (...args) => caller(multiRouter())(...args);

test('不鎖定：設定總覽是多人格的格式（模式清單、使用者人格、固定人格、範圍）', async () => {
  const { result } = await callMulti('GET', '/api/ai/settings');
  assert.equal(persona.isLocked(), false);
  assert.equal(typeof result.model, 'string');
  assert.ok('visionModel' in result);
  assert.ok(Array.isArray(result.modes));
  assert.equal(result.defaultMode, 'default');
  assert.deepEqual(result.userModes, []);
  assert.deepEqual(result.fixedUserModes, []);
  assert.equal(result.persona, undefined);
  assert.equal(result.memoryScope, undefined);
  assert.equal(result.specialUsers, undefined);
  const [g] = result.replyChance.guilds;
  assert.equal(g.id, GUILD);
  assert.equal(g.scope, null);
  assert.deepEqual(g.channelScopes, {});
  assert.deepEqual(g.channels.map((c) => [c.id, c.disabled]), [[TEXT, false], [VOICE, false]]);
});

test('不鎖定：範圍、使用者人格、清除個人記憶、成員搜尋都有註冊', () => {
  const router = multiRouter();
  assert.equal(hasRoute(router, 'PUT', `/api/ai/scope/${GUILD}`), true);
  assert.equal(hasRoute(router, 'DELETE', `/api/ai/scope/channel/${TEXT}`), true);
  assert.equal(hasRoute(router, 'PUT', `/api/ai/user-modes/${USER}`), true);
  assert.equal(hasRoute(router, 'POST', `/api/ai/memory/${USER}`), true);
  assert.equal(hasRoute(router, 'GET', '/api/members/search'), true);
  assert.equal(isCached('handlers/ai/aiScope.js'), true); // 上一組的「沒有載入」不是空過
  assert.equal(isCached('handlers/ai/modeSelector.js'), true);
});

test('不鎖定：範圍設為多人格後回報在伺服器上，恢復預設後清掉', async () => {
  let r = await callMulti('PUT', `/api/ai/scope/${GUILD}`, { kind: 'multi' });
  assert.match(r.actions[0], /測試伺服器.*多人格/);
  let { result } = await callMulti('GET', '/api/ai/settings');
  assert.equal(result.replyChance.guilds[0].scope.kind, 'multi');

  r = await callMulti('DELETE', `/api/ai/scope/${GUILD}`);
  assert.match(r.actions[0], /恢復預設/);
  ({ result } = await callMulti('GET', '/api/ai/settings'));
  assert.equal(result.replyChance.guilds[0].scope?.kind ?? null, null);

  await assert.rejects(callMulti('PUT', `/api/ai/scope/${GUILD}`, { kind: 'single', persona: 'nope' }), (err) => err.status === 400);
});

test('不鎖定：清除個人記憶與頻道記憶都有效', async () => {
  const before = aiMemoryState.getMemoryClearTime(USER);
  const { actions } = await callMulti('POST', `/api/ai/memory/${USER}`);
  assert.ok(aiMemoryState.getMemoryClearTime(USER) > before);
  assert.match(actions[0], /清除 .* 的 AI 對話記憶/);

  const ch = aiMemoryState.getChannelClearTime(VOICE);
  await callMulti('POST', `/api/ai/memory/channel/${VOICE}`);
  assert.ok(aiMemoryState.getChannelClearTime(VOICE) > ch);
});
