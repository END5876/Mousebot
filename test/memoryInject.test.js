'use strict';

// 長期記憶的注入（aiCore）：只進人格那一次呼叫（搜尋階段不帶）、多人格依伺服器隔離、optOut 不注入、
// 單一人格只帶名冊上成員的成員記憶。Gemini 與用量統計換成假的；資料目錄指到暫存資料夾，不碰正式的 data/。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-meminject-'));
const PROMPTS = path.join(TMP, 'prompts');
fs.mkdirSync(path.join(PROMPTS, 'modes'), { recursive: true });
fs.writeFileSync(path.join(PROMPTS, '_general.md'), 'GENERAL');
fs.writeFileSync(path.join(PROMPTS, '_group.md'), 'GROUP');
fs.writeFileSync(path.join(PROMPTS, 'modes', 'loss.md'), '---\nname: 預設\n---\nLOSS');
fs.writeFileSync(path.join(PROMPTS, 'modes', 'chat.md'), '---\nname: 聊天\n---\nCHAT');

const G1 = '100000000000000001';
const G2 = '100000000000000002';
const C1 = '200000000000000001';
const BOT = '500000000000000001';
const MING = '900000000000000001';
const HUA = '900000000000000002';

Object.assign(process.env, {
  MOUSEBOT_DATA_DIR: TMP,
  LOG_LEVEL: 'error',
  GROQ_API_KEY: process.env.GROQ_API_KEY || 'test',
  GEMINI_SEARCH_GUILD_IDS: G1,   // G1 會先跑搜尋階段：確認記憶不會跟著送進去
  AI_TOOLS: '0',
});

const calls = [];
function stub(relPath, exports) {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('../handlers/ai/geminiClient', {
  generate: async (opts) => { calls.push(opts); return { text: '好喔' }; },
  MODEL_NAME: 'test-model',
});
stub('../handlers/ai/tokenTracker', { recordUsage: () => {} });

const { Collection } = require('discord.js');
const { getGeminiResponse, getGeminiResponseVoice } = require('../handlers/ai/aiCore');
const aiScope = require('../handlers/ai/aiScope');
const memState = require('../handlers/ai/aiMemoryState');
const { getMemoryStore, MEMORY_FRAME_HEAD } = require('../handlers/ai/memoryStore');
const { RESEARCH_PROMPT } = require('../handlers/ai/searchGrounding');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  // aiCore 會載入常駐計時器，等測試框架寫完結果後主動結束（同 admin.test.js）
  setTimeout(() => process.exit(), 500).unref();
});
test.beforeEach(() => { calls.length = 0; });

const fakeChannel = (guildId, id = C1) => ({
  id, guildId, isThread: () => false,
  guild: { members: { cache: new Collection() } },
  messages: { fetch: async () => new Collection() },
});
const personaCall = () => calls.find((c) => c.systemInstruction !== RESEARCH_PROMPT);
const store = getMemoryStore();
const add = (...texts) => ({ add: texts.map((text) => ({ text, category: 'preference' })) });

store.applyUserOps(MING, add('不吃香菜'), { origin: G1 });
store.applyUserOps(MING, add('在第二個伺服器說過的秘密'), { origin: G2 });
store.applyUserOps(MING, add('私訊裡說過的事'), { origin: 'dm' });

test('多人格：只注入同一個伺服器的個人記憶，且只進人格那一次呼叫（搜尋階段不帶）', async () => {
  const scope = aiScope.getScope(G1, C1);
  assert.equal(scope.kind, 'multi');
  await getGeminiResponse(MING, '你好', [], fakeChannel(G1), 'm1', BOT, null, 'loss', null, { scope, userName: 'ming' });

  const research = calls.find((c) => c.systemInstruction === RESEARCH_PROMPT);
  assert.ok(research, '應該有搜尋階段');
  assert.ok(!JSON.stringify(research).includes('香菜'), '搜尋階段不帶記憶');

  const sys = personaCall().systemInstruction;
  assert.ok(sys.startsWith('LOSS\n\nGENERAL\n\n'));
  assert.ok(sys.includes(MEMORY_FRAME_HEAD));
  assert.ok(sys.includes('- 不吃香菜'));
  assert.ok(sys.includes('【你記得關於 ming 的事】'));
  assert.ok(!sys.includes('秘密'), '其他伺服器的記憶不注入');
  assert.ok(!sys.includes('私訊'), '私訊的記憶不注入');
});

test('多人格：私訊只注入私訊的記憶；沒有記憶時不加任何區塊', async () => {
  const dm = aiScope.getScope(null, null);
  await getGeminiResponse(MING, '你好', [], null, null, BOT, null, 'loss', null, { scope: dm });
  const sys = personaCall().systemInstruction;
  assert.ok(sys.includes('私訊裡說過的事'));
  assert.ok(!sys.includes('香菜'));

  calls.length = 0;
  await getGeminiResponse(HUA, '你好', [], fakeChannel(G2), 'm2', BOT, null, 'loss', null, { scope: aiScope.getScope(G2, C1) });
  assert.equal(personaCall().systemInstruction, 'LOSS\n\nGENERAL');
});

test('optOut：不注入；重新開啟後恢復', async () => {
  const scope = aiScope.getScope(G2, C1);
  memState.setOptOut(MING, true);
  await getGeminiResponse(MING, '你好', [], fakeChannel(G2), 'm3', BOT, null, 'loss', null, { scope });
  assert.ok(!personaCall().systemInstruction.includes(MEMORY_FRAME_HEAD));

  memState.setOptOut(MING, false);
  calls.length = 0;
  await getGeminiResponse(MING, '你好', [], fakeChannel(G2), 'm4', BOT, null, 'loss', null, { scope });
  assert.ok(personaCall().systemInstruction.includes('秘密'));
});

test('單一人格：群組記憶＋名冊上成員的成員記憶，不帶個人記憶與不在場的人；順序在 _group 之後、名冊之前', async () => {
  aiScope.setChannelScope(C1, G2, { kind: 'single', persona: 'chat' }, 'admin');
  const scope = aiScope.getScope(G2, C1);
  assert.equal(scope.scopeKey, `c:${C1}`);
  store.applyScopeOps(scope.scopeKey, {
    group: add('每週五晚上打 Valorant'),
    members: { [MING]: { name: '小明', ops: add('養了一隻貓') }, [HUA]: { name: '小華', ops: add('會彈吉他') } },
  });

  await getGeminiResponse(MING, '你好', [], fakeChannel(G2), 'm5', BOT, null, 'chat', null, { scope, userName: '明明 (@ming)' });
  const sys = personaCall().systemInstruction;
  assert.ok(sys.startsWith('CHAT\n\nGENERAL\n\nGROUP\n\n' + MEMORY_FRAME_HEAD));
  assert.ok(sys.includes('【群組共同記憶】\n- 每週五晚上打 Valorant'));
  assert.ok(sys.includes('- 明明 (@ming)：養了一隻貓'));
  assert.ok(!sys.includes('吉他'), '不在名冊上的成員不帶');
  assert.ok(!sys.includes('秘密') && !sys.includes('香菜'), '單一人格不帶個人記憶');
  assert.ok(sys.indexOf('【記憶資料結束】') < sys.indexOf('【目前這段對話中的成員】'));
});

test('語音：單一人格注入群組記憶＋說話者的成員記憶（用存檔裡的名字）；多人格注入說話者在該伺服器的記憶', async () => {
  aiScope.setGuildScope(G2, { kind: 'single', persona: 'chat' }, 'admin');
  store.applyScopeOps(`g:${G2}`, { members: { [HUA]: { name: '小華', ops: add('喜歡爵士樂') } } });
  await getGeminiResponseVoice(HUA, '你好', null, null, BOT, null, G2, null);
  const sys = personaCall().systemInstruction;
  assert.ok(sys.includes('- 小華：喜歡爵士樂'));

  calls.length = 0;
  await getGeminiResponseVoice(MING, '你好', null, null, BOT, null, G1, null);
  const voiceA = personaCall().systemInstruction;
  assert.ok(voiceA.includes('不吃香菜'));
  assert.ok(voiceA.includes('【你記得關於 現在跟你說話的人 的事】'));
});
