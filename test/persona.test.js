'use strict';

// persona.js（MouseBot 與 mousebot-lite 共用）：範圍鎖定的解析、鎖定時的 scopeKey 格式、
// 不鎖定時人格 prompt 的備援順序（人格檔 → DEFAULT_MODE → 內建人格）。
// prompts 放在暫存資料夾（MOUSEBOT_DATA_DIR），不讀正式的 data/。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-persona-lock-'));
const PROMPTS = path.join(TMP, 'prompts');
fs.mkdirSync(path.join(PROMPTS, 'modes'), { recursive: true });
fs.writeFileSync(path.join(PROMPTS, '_group.md'), 'GROUP');
fs.writeFileSync(path.join(PROMPTS, 'modes', 'fallback.md'), '---\nname: 備援\nclearMemoryMessage: 備援清除\n---\nFALLBACK');
fs.writeFileSync(path.join(PROMPTS, 'modes', 'chat.md'), '---\nname: 聊天\n---\nCHAT');

process.env.MOUSEBOT_DATA_DIR = TMP;
process.env.LOG_LEVEL = 'error';
process.env.AI_DEFAULT_MODE = 'fallback';
delete process.env.AI_USER_MODE_OVERRIDES;
delete process.env.AI_SCOPE_LOCK;
delete process.env.AI_PERSONA;

const persona = require('../handlers/ai/persona');
const profile = require('../profile');

const G = '100000000000000001';
const USER = '900000000000000099';

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** 設定 AI_SCOPE_LOCK／AI_PERSONA 後重新解析鎖定（undefined = 刪掉這個環境變數） */
function setLock(lock, personaKey) {
  if (lock === undefined) delete process.env.AI_SCOPE_LOCK; else process.env.AI_SCOPE_LOCK = lock;
  if (personaKey === undefined) delete process.env.AI_PERSONA; else process.env.AI_PERSONA = personaKey;
  persona._reset();
}

test('沒設 AI_SCOPE_LOCK（或空字串）時用 profile.aiScopeLock', () => {
  const expectLocked = !['', 'off', 'none'].includes(String(profile.aiScopeLock ?? '').toLowerCase());
  setLock(undefined);
  assert.equal(persona.isLocked(), expectLocked);
  setLock('   ');
  assert.equal(persona.isLocked(), expectLocked);
});

test('off／none 不鎖定（不分大小寫）', () => {
  for (const v of ['off', 'none', 'OFF', ' None ']) {
    setLock(v, 'chat');
    assert.equal(persona.getLock(), null, v);
    assert.equal(persona.isLocked(), false, v);
  }
});

test('single：人格是 AI_PERSONA，沒設時用 DEFAULT_MODE', () => {
  setLock('single', ' chat ');
  assert.deepEqual(persona.getLock(), { kind: 'single', persona: 'chat', source: 'AI_PERSONA' });
  assert.ok(Object.isFrozen(persona.getLock()));
  setLock('SINGLE');
  assert.deepEqual(persona.getLock(), { kind: 'single', persona: 'fallback', source: 'AI_PERSONA' });
});

test('single:<代號>：人格直接寫在鎖定值裡；代號不合法時視為不鎖定', () => {
  setLock('single:chat', 'other');
  assert.deepEqual(persona.getLock(), { kind: 'single', persona: 'chat', source: 'AI_SCOPE_LOCK' });
  const logger = require('../utils/logger');
  const since = logger.getLatestSeq();
  setLock('single:bad key!', 'chat');
  assert.equal(persona.getLock(), null);
  assert.ok(logger.getRecent(since).some(r => r.level === 'error' && r.msg.includes('bad key!')));
  setLock('single:../x');
  assert.equal(persona.getLock(), null);
  setLock('whatever');
  assert.equal(persona.getLock(), null);
});

test('鎖定時：scopeKey 是 g:<伺服器>:<人格>，範圍是凍結物件，所有人都用鎖定的人格', () => {
  setLock('single', 'chat');
  const scope = persona.scopeFor(G);
  assert.deepEqual(scope, { kind: 'single', persona: 'chat', scopeKey: `g:${G}:chat`, changedAt: 0 });
  assert.ok(Object.isFrozen(scope));
  assert.equal(persona.scopeFor(null).scopeKey, 'g:none:chat');
  assert.deepEqual(persona.defaultScope(), persona.scopeFor(null));

  // 討論串和頻道共用伺服器的 scopeKey
  const thread = { id: 'T', guildId: G, parentId: 'C', isThread: () => true };
  assert.equal(persona.resolveScope(thread, G).scopeKey, `g:${G}:chat`);
  assert.equal(persona.resolveScope(null, G).scopeKey, `g:${G}:chat`);

  assert.equal(persona.modeFor(USER, null), 'chat');
  assert.equal(persona.modeFor(USER, { kind: 'single', persona: 'fallback' }), 'chat');
  assert.equal(persona.defaultMode(), 'chat');
  assert.equal(persona.getPersonaKey(), 'chat');
});

test('鎖定時：人格檔不存在就直接用內建人格（不經過 DEFAULT_MODE）', () => {
  setLock('single:missing');
  assert.equal(persona.hasPersonaFile(), false);
  assert.equal(persona.getPersonaPrompt(), persona.BUILTIN_PERSONA_PROMPT);
  assert.equal(persona.getPersonaName(), persona.BUILTIN_PERSONA_NAME);
  assert.equal(persona.getClearMessage(), '🧠 已清除你的對話記憶。');

  setLock('single:chat');
  assert.equal(persona.hasPersonaFile(), true);
  assert.equal(persona.getPersonaPrompt(), 'CHAT');
  assert.equal(persona.getPersonaName(), '聊天');
});

test('鎖定時不載入 aiScope 與 modeSelector', () => {
  const loaded = Object.keys(require.cache).map(f => path.basename(f));
  assert.ok(!loaded.includes('aiScope.js'));
  assert.ok(!loaded.includes('modeSelector.js'));
});

test('不鎖定時：沒有固定範圍；單一人格範圍用範圍的人格，否則照 modeSelector（預設 DEFAULT_MODE）', () => {
  setLock('off');
  assert.equal(persona.scopeFor(G), null);
  assert.equal(persona.defaultScope(), null);
  assert.equal(persona.defaultMode(), 'fallback');
  assert.equal(persona.modeFor(USER, { kind: 'single', persona: 'chat' }), 'chat');
  assert.equal(persona.modeFor(USER, { kind: 'multi', persona: null }), 'fallback');
  assert.equal(persona.modeFor(USER, null), 'fallback');
  // 沒有 aiScope.json：伺服器預設多人格
  assert.equal(persona.resolveScope(null, G).kind, 'multi');
  assert.equal(persona.resolveScope({ id: 'C', guildId: G }, G).kind, 'multi');
});

test('不鎖定時：人格檔 → DEFAULT_MODE → 內建人格', (t) => {
  setLock('off');
  assert.equal(persona.getPersonaPrompt('chat'), 'CHAT');
  assert.equal(persona.getPersonaPrompt('nope'), 'FALLBACK');
  assert.equal(persona.getPersonaPrompt(), 'FALLBACK');
  assert.equal(persona.getPersonaName('nope'), persona.BUILTIN_PERSONA_NAME);
  assert.equal(persona.getClearMessage(), '備援清除');

  // DEFAULT_MODE 的檔案也不見了 → 內建人格（promptStore 每 2 秒才重新掃描，用假時間跳過）
  fs.rmSync(path.join(PROMPTS, 'modes', 'fallback.md'));
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 10_000 });
  assert.equal(persona.getPersonaPrompt('nope'), persona.BUILTIN_PERSONA_PROMPT);
  assert.equal(persona.hasPersonaFile(), false);
});

test('群聊規則：有 _group.md 用檔案，沒有就用內建規則', (t) => {
  assert.equal(persona.getGroupRules(), 'GROUP');
  fs.rmSync(path.join(PROMPTS, '_group.md'));
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 20_000 });
  assert.equal(persona.getGroupRules(), persona.BUILTIN_GROUP_RULES);
});
