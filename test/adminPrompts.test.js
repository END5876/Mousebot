'use strict';

// 管理 API 的 AI 人格（admin/api/prompts.js）：鎖定（單一人格）與不鎖定（多人格）各一組。
// 資料目錄指到暫存資料夾（一開始沒有任何人格檔）。
// 鎖定組：只有 AI_PERSONA 一個人格、從內建人格建立人格檔、FEATURES 沒有 voice → 共用規則只有 _general、_group。
// 不鎖定組：改成 AI_SCOPE_LOCK=off、刪掉 FEATURES（全開），persona._reset() 後重新註冊路由。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-admin-prompts-'));
process.env.MOUSEBOT_DATA_DIR = TMP;
process.env.AI_SCOPE_LOCK = 'single';
process.env.AI_PERSONA = 'testfish';
process.env.AI_RANDOM_SLOT = '0/2';
process.env.FEATURES = 'ai,autojoin,music';
process.env.LOG_LEVEL = 'error';
delete process.env.AI_USER_MODE_OVERRIDES;
delete process.env.AI_DEFAULT_MODE;

const { Router } = require('../admin/http');
const registerPrompts = require('../admin/api/prompts');
const promptStore = require('../handlers/ai/promptStore');
const persona = require('../handlers/ai/persona');
const features = require('../utils/features');

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

// ── 鎖定（單一人格）──────────────────────────────────────
const lockedRouter = new Router();
registerPrompts(lockedRouter);
const call = caller(lockedRouter);

test('鎖定：沒有人格檔時回傳內建人格（Bot 實際在用的內容）', async () => {
  const { result } = await call('GET', '/api/prompts');
  assert.equal(result.singlePersona, true);
  assert.equal(result.defaultMode, 'testfish');
  assert.deepEqual(result.modes, []);
  assert.equal(result.builtin.key, 'testfish');
  assert.equal(result.builtin.prompt, persona.getPersonaPrompt());
  assert.deepEqual(result.shared.map((s) => s.key), ['_general', '_group']);
  assert.equal(result.shared.find((s) => s.key === '_group').builtin, true);
  await assert.rejects(call('GET', '/api/prompts/modes/testfish'), (err) => err.status === 404);
});

test('鎖定：從內建內容建立人格檔後立即生效，清單改列人格檔', async () => {
  const { actions } = await call('PUT', '/api/prompts/modes/testfish', {
    name: '測試魚', shortDescription: '', clearMemoryMessage: '🐟 忘光了', prompt: '你是一條魚。', create: true, singleScope: 'off',
  });
  assert.match(actions[0], /建立 AI 人格「測試魚」/);
  promptStore.refresh?.(true);
  assert.equal(persona.getPersonaName(), '測試魚');
  assert.equal(persona.getPersonaPrompt(), '你是一條魚。');
  assert.equal(promptStore.getMode('testfish').singleScope, undefined); // 鎖定時不寫 singleScope

  const { result } = await call('GET', '/api/prompts');
  assert.equal(result.builtin, null);
  assert.deepEqual(result.modes.map((m) => m.key), ['testfish']);
  await assert.rejects(call('PUT', '/api/prompts/modes/testfish', { name: 'x', prompt: 'y', create: true }), (err) => err.status === 409);
});

test('鎖定：只能編輯鎖定的人格，不能刪除；錯誤訊息寫出設定人格的環境變數', async () => {
  await assert.rejects(call('PUT', '/api/prompts/modes/other', { name: 'x', prompt: 'y' }),
    (err) => err.status === 400 && /環境變數 AI_PERSONA/.test(err.message));
  await assert.rejects(call('GET', '/api/prompts/history/modes/other'), (err) => err.status === 400);
  await assert.rejects(call('DELETE', '/api/prompts/modes/testfish'),
    (err) => err.status === 400 && /AI_PERSONA/.test(err.message));
});

test('鎖定：共用規則只有 _general、_group；_group 空白時附上內建規則', async () => {
  let { result } = await call('GET', '/api/prompts/shared/_group');
  assert.equal(result.text, '');
  assert.equal(result.builtinText, persona.getGroupRules());
  await assert.rejects(call('GET', '/api/prompts/shared/_voice'), (err) => err.status === 404);
  await assert.rejects(call('GET', '/api/prompts/history/shared/_voice'), (err) => err.status === 404);

  await call('PUT', '/api/prompts/shared/_group', { text: '大家好好聊' });
  promptStore.refresh?.(true);
  ({ result } = await call('GET', '/api/prompts/shared/_group'));
  assert.equal(result.text, '大家好好聊');
  assert.equal(result.builtinText, null);

  // 修改前的版本留在版本紀錄
  const { result: hist } = await call('GET', '/api/prompts/history/modes/testfish');
  assert.ok(Array.isArray(hist.versions));
});

// ── 不鎖定（多人格）──────────────────────────────────────
let multi = null;
function multiRouter() {
  if (!multi) {
    process.env.AI_SCOPE_LOCK = 'off';
    delete process.env.FEATURES;
    persona._reset();
    multi = new Router();
    registerPrompts(multi);
  }
  return multi;
}
const callMulti = (...args) => caller(multiRouter())(...args);
const expectedShared = () => (features.isEnabled('voice') ? ['_general', '_voice', '_group'] : ['_general', '_group']);

test('不鎖定：列出所有模式；預設模式（default）沒有人格檔時附上內建人格', async () => {
  const { result } = await callMulti('GET', '/api/prompts');
  assert.equal(persona.isLocked(), false);
  assert.equal(result.singlePersona, undefined);
  assert.equal(result.defaultMode, 'default');
  assert.deepEqual(result.modes.map((m) => [m.key, m.users]), [['testfish', 0]]);
  assert.equal(result.builtin.key, 'default');
  assert.equal(result.builtin.prompt, persona.BUILTIN_PERSONA_PROMPT);
  assert.deepEqual(result.shared.map((s) => s.key), expectedShared());
  // _group.md 在鎖定組寫過了
  assert.equal(result.shared.find((s) => s.key === '_group').builtin, false);
  assert.ok(result.shared.filter((s) => s.key !== '_group').every((s) => s.builtin === false));
});

test('不鎖定：可以新增、刪除其他模式，寫入 singleScope；預設模式不能刪', async () => {
  await callMulti('PUT', '/api/prompts/modes/default', { name: '預設', prompt: '你是預設。', create: true });
  let { result } = await callMulti('GET', '/api/prompts');
  assert.equal(result.builtin, null);

  const { actions } = await callMulti('PUT', '/api/prompts/modes/other', { name: '別的', prompt: '你是別的。', singleScope: 'off', create: true });
  assert.match(actions[0], /建立 AI 人格「別的」/);
  assert.equal(promptStore.getMode('other').singleScope, 'off');
  ({ result } = await callMulti('GET', '/api/prompts/modes/other'));
  assert.equal(result.singleScope, 'off');

  await callMulti('DELETE', '/api/prompts/modes/other');
  assert.ok(!promptStore.getMode('other'));
  ({ result } = await callMulti('GET', '/api/prompts'));
  assert.ok(result.deleted.includes('other'));
  await assert.rejects(callMulti('DELETE', '/api/prompts/modes/default'), (err) => err.status === 400);
});

test('不鎖定：_voice 只在 voice 開啟時是共用規則', async () => {
  if (features.isEnabled('voice')) {
    const { result } = await callMulti('GET', '/api/prompts/shared/_voice');
    assert.equal(result.key, '_voice');
    assert.equal(result.builtinText, null);
  } else {
    await assert.rejects(callMulti('GET', '/api/prompts/shared/_voice'), (err) => err.status === 404);
    await assert.rejects(callMulti('GET', '/api/prompts/history/shared/_voice'), (err) => err.status === 400);
  }
  const { result } = await callMulti('GET', '/api/prompts/shared/_group');
  assert.equal(result.text, '大家好好聊');
  assert.equal(result.builtinText, null);
});
