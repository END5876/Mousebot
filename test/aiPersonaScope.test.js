'use strict';

// 人格分岔：single 範圍時所有人都用範圍指定的人格；system instruction 在 single 時接上 _group 規則。
// prompts 與範圍設定都放在暫存資料夾（MOUSEBOT_DATA_DIR），不讀正式的 data/。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 預設人格要用中性代號 default（AI_DEFAULT_MODE 沒設定時的預設）
delete process.env.AI_DEFAULT_MODE;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-persona-'));
const PROMPTS = path.join(TMP, 'prompts');
fs.mkdirSync(path.join(PROMPTS, 'modes'), { recursive: true });
fs.writeFileSync(path.join(PROMPTS, '_general.md'), 'GENERAL');
fs.writeFileSync(path.join(PROMPTS, '_voice.md'), 'VOICE');
fs.writeFileSync(path.join(PROMPTS, '_group.md'), 'GROUP');
fs.writeFileSync(path.join(PROMPTS, 'modes', 'default.md'), '---\nname: 預設\n---\nDEFAULT');
fs.writeFileSync(path.join(PROMPTS, 'modes', 'chat.md'), '---\nname: 聊天\n---\nCHAT');
fs.writeFileSync(path.join(PROMPTS, 'modes', 'special.md'), '---\nname: 特別\nsingleScope: off\n---\nSPECIAL');

Object.assign(process.env, {
  MOUSEBOT_DATA_DIR: TMP,
  LOG_LEVEL: 'error',
  // 測 MouseBot 的多人格／單一人格切換：明確不鎖定，不依賴 profile.aiScopeLock
  AI_SCOPE_LOCK: 'off',
  AI_USER_MODE_OVERRIDES: '900000000000000001:special',
  GROQ_API_KEY: process.env.GROQ_API_KEY || 'test',
});

const { getUserMode, buildSystemInstruction } = require('../handlers/ai/aiCore');
const aiScope = require('../handlers/ai/aiScope');
const { DEFAULT_MODE } = require('../handlers/ai/aiSettings');
const { BUILTIN_GROUP_RULES } = require('../handlers/ai/persona');

const G = '100000000000000001';
const C = '200000000000000001';
const FIXED_USER = '900000000000000001';
const PLAIN_USER = '900000000000000099'; // 不在任何名單、也沒有個人設定的使用者

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  // aiCore / aiHandler 會載入常駐計時器（例如 AI 圖片快取的定期清理），程序不會自己結束；
  // 等測試框架寫完結果與結束碼後再主動結束（同 admin.test.js）
  setTimeout(() => process.exit(), 500).unref();
});

test('多人格：照原本的 selectMode（固定人格仍有效）', () => {
  const scope = aiScope.getScope(G, C);
  assert.equal(scope.kind, 'multi');
  assert.equal(getUserMode(FIXED_USER, scope), 'special');
  assert.equal(getUserMode(PLAIN_USER, scope), DEFAULT_MODE);
  assert.equal(getUserMode(PLAIN_USER), DEFAULT_MODE); // 沒傳 scope 等同多人格
});

test('單一人格：所有人都用範圍的人格，忽略固定人格', () => {
  aiScope.setChannelScope(C, G, { kind: 'single', persona: 'chat' }, 'u1');
  const scope = aiScope.getScope(G, C);
  assert.equal(getUserMode(FIXED_USER, scope), 'chat');
  assert.equal(getUserMode(PLAIN_USER, scope), 'chat');
});

test('system instruction：順序 persona → _general → _voice → _group；多人格不接 _group', () => {
  const multi = aiScope.getScope(G, '200000000000000009');
  const single = aiScope.getScope(G, C);
  assert.equal(buildSystemInstruction({ mode: 'default', scope: multi }), 'DEFAULT\n\nGENERAL');
  assert.equal(buildSystemInstruction({ mode: 'chat', scope: single }), 'CHAT\n\nGENERAL\n\nGROUP');
  assert.equal(buildSystemInstruction({ mode: 'chat', isVoice: true, scope: single }), 'CHAT\n\nGENERAL\n\nVOICE\n\nGROUP');
  assert.equal(
    buildSystemInstruction({ mode: 'chat', scope: single, roster: 'ROSTER' }),
    'CHAT\n\nGENERAL\n\nGROUP\n\nROSTER',
  );
});

test('_group.md 不存在時使用內建的群聊規則（P1 差異 2，MB-10）', async () => {
  fs.rmSync(path.join(PROMPTS, '_group.md'));
  // promptStore 每 2 秒才檢查一次檔案變動
  await new Promise((r) => setTimeout(r, 2100));
  const single = aiScope.getScope(G, C);
  const multi = aiScope.getScope(G, '200000000000000009');
  assert.equal(buildSystemInstruction({ mode: 'chat', scope: single }), `CHAT\n\nGENERAL\n\n${BUILTIN_GROUP_RULES}`);
  // 多人格不受影響
  assert.equal(buildSystemInstruction({ mode: 'default', scope: multi }), 'DEFAULT\n\nGENERAL');
});

test('/ai 指令包含 scope 子指令群組（show / set / reset）', () => {
  // aiHandler 會載入整個 AI 模組；只檢查指令定義，不連線 Discord
  const { setupAICommands } = require('../handlers/ai/aiHandler');
  let registered = null;
  const fakeClient = { commands: new Map(), on() {} };
  fakeClient.commands.set = (k, v) => { registered = v; };
  // 沒有 GEMINI_API_KEY 時 setupAICommands 直接回報 off、不註冊指令
  process.env.GEMINI_API_KEY ||= 'x';
  setupAICommands(fakeClient);
  const json = registered.data.toJSON();
  const scope = json.options.find((o) => o.name === 'scope');
  assert.ok(scope, '缺少 scope 群組');
  assert.deepEqual(scope.options.map((o) => o.name).sort(), ['reset', 'set', 'show']);
  const set = scope.options.find((o) => o.name === 'set');
  assert.deepEqual(set.options.map((o) => [o.name, o.required]), [['kind', true], ['persona', false], ['channel', false]]);
  assert.equal(json.options.find((o) => o.name === 'memory'), undefined);
});
