'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// 先換掉 Gemini 與用量統計：不打真的 API，也不寫入 data/tokenUsage.json
const generateCalls = [];
let nextResponse = {};
function stub(relPath, exports) {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('../handlers/ai/geminiClient', {
  generate: async (opts) => { generateCalls.push(opts); return nextResponse; },
  MODEL_NAME: 'test-model',
});
stub('../handlers/ai/tokenTracker', { recordUsage: () => {} });

const tools = require('../handlers/ai/tools');
const { _cache: freeGamesCache } = require('../handlers/ai/tools/freeGames');
const { _buildExpense, _findMemberByName } = require('../handlers/ai/tools/splitbill');

const guild = { id: 'g1', members: { me: { voice: { channelId: null } }, cache: new Map() } };
const ctxOf = (overrides = {}) => ({
  guild, member: { id: 'u1', voice: { channel: null, channelId: null } },
  textChannel: null, userId: 'u1', source: 'text', ...overrides,
});
const userParts = (text) => [{ text: `【發言者：tester】\n${text}` }];

test.beforeEach(() => {
  generateCalls.length = 0;
  nextResponse = {};
  delete process.env.AI_TOOLS;
});

test('needsTools：相關的要求會命中預篩，一般聊天不會', () => {
  for (const s of ['放周杰倫的晴天', '幫我記帳 晚餐 900', '現在 Epic 送什麼', '進來語音陪我', '跳過這首', '我欠你多少', '200塊', '幫我跟大家說晚安']) {
    assert.equal(tools.needsTools(s), true, s);
  }
  for (const s of ['今天好累', '哈哈哈你好笨', '晚安', '你覺得貓可愛嗎', '', null]) {
    assert.equal(tools.needsTools(s), false, String(s));
  }
});

test('runToolStage：預篩沒命中、沒有 member、AI_TOOLS=0 時不呼叫模型', async () => {
  assert.equal(await tools.runToolStage({ history: [], parts: userParts('晚安'), text: '晚安', ctx: ctxOf() }), null);
  assert.equal(await tools.runToolStage({ history: [], parts: userParts('放歌'), text: '放歌', ctx: ctxOf({ member: null }) }), null);
  process.env.AI_TOOLS = '0';
  assert.equal(await tools.runToolStage({ history: [], parts: userParts('放歌'), text: '放歌', ctx: ctxOf() }), null);
  assert.equal(generateCalls.length, 0);
});

test('runToolStage：模型判斷不需要工具時，回傳「沒有執行動作」的提醒', async () => {
  nextResponse = { text: 'NONE' };
  const out = await tools.runToolStage({ history: [], parts: userParts('昨天那首歌好好聽'), text: '昨天那首歌好好聽', ctx: ctxOf() });
  assert.match(out, /這次沒有替使用者/);
  assert.equal(generateCalls.length, 1);
  assert.equal(generateCalls[0].systemInstruction, tools._ROUTER_PROMPT);
});

test('runToolStage：執行模型要求的工具，結果整理成給人格的文字', async () => {
  const now = Date.now();
  freeGamesCache.set('epic', { at: now, games: [{ name: 'Game A', url: 'https://store.example/a', endDate: '2026-11-10T15:00:00.000Z' }] });
  freeGamesCache.set('steam', { at: now, games: [] });
  nextResponse = { functionCalls: [{ name: 'free_games', args: { platform: 'all' } }] };

  const out = await tools.runToolStage({ history: [], parts: userParts('現在有什麼免費遊戲'), text: '現在有什麼免費遊戲', ctx: ctxOf() });
  assert.match(out, /剛剛替使用者執行的動作/);
  assert.match(out, /查免費遊戲：成功。/);
  assert.match(out, /Game A（到 .+）https:\/\/store\.example\/a/);
  assert.match(out, /Steam：目前沒有限時免費的遊戲/);
});

test('runToolStage：預期內的失敗回報原因，不支援的工具名稱會被忽略', async () => {
  nextResponse = { functionCalls: [{ name: 'voice_join', args: {} }, { name: 'rm_rf', args: {} }] };
  const out = await tools.runToolStage({ history: [], parts: userParts('進來語音'), text: '進來語音', ctx: ctxOf() });
  assert.match(out, /加入語音：沒有執行，原因：使用者不在語音頻道裡/);
  assert.doesNotMatch(out, /rm_rf/);
});

test('runToolStage：語音對話不提供 voice_say；判斷階段只送文字', async () => {
  nextResponse = {};
  const history = [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'x' } }, { text: '看這個' }] }];
  await tools.runToolStage({ history, parts: userParts('幫我跟大家說晚安'), text: '幫我跟大家說晚安', ctx: ctxOf({ source: 'voice' }) });
  const names = generateCalls[0].config.tools[0].functionDeclarations.map(d => d.name);
  assert.ok(!names.includes('voice_say'));
  assert.ok(names.includes('music_play'));
  assert.ok(generateCalls[0].contents.every(c => c.parts.every(p => typeof p.text === 'string')));

  generateCalls.length = 0;
  await tools.runToolStage({ history: [], parts: userParts('幫我跟大家說晚安'), text: '幫我跟大家說晚安', ctx: ctxOf() });
  assert.ok(generateCalls[0].config.tools[0].functionDeclarations.some(d => d.name === 'voice_say'));
});

test('contextFrom：沒有 guild 或 member（私訊）時不帶工具', () => {
  assert.equal(tools.contextFrom('text', { guild: null, member: {} }), null);
  assert.equal(tools.contextFrom('text', { guild, member: null }), null);
  const ctx = tools.contextFrom('voice', { guild, member: { id: 'u9' }, channel: null });
  assert.deepEqual({ userId: ctx.userId, source: ctx.source, textChannel: ctx.textChannel }, { userId: 'u9', source: 'voice', textChannel: null });
});

test('分帳 buildExpense：平分加總等於總額，格式與面板記帳相同', () => {
  const exp = _buildExpense({
    id: 'id_x', description: '晚餐', amount: 1000, currency: 'JPY', rate: 0.21, rateSource: '網路即時',
    payerId: 'm1', participantIds: ['m1', 'm2', 'm3'], createdBy: 'u1',
  });
  const sum = exp.participants.reduce((s, p) => s + p.amount, 0);
  assert.equal(Math.round(sum * 100) / 100, exp.amount);
  assert.deepEqual(exp.payers, [{ userId: 'm1', amount: exp.amount }]);
  assert.equal(exp.amountInBase, Math.round(exp.amount * 0.21 * 100) / 100);
  assert.deepEqual(Object.keys(exp).sort(), [
    'amount', 'amountInBase', 'createdAt', 'createdBy', 'currency', 'description',
    'exchangeRate', 'id', 'participants', 'payers', 'rateSource',
  ]);
});

test('分帳 findMemberByName：比對成員名稱與已連結成員的 Discord 名稱', () => {
  const g = {
    members: { cache: new Map([['d2', { user: { username: 'bobby', globalName: 'Bob' }, displayName: '阿伯' }]]) },
  };
  const trip = { members: [{ id: 'm1', name: '小明' }, { id: 'm2', name: 'Robert', discordId: 'd2' }] };
  assert.equal(_findMemberByName(trip, g, '小明').id, 'm1');
  assert.equal(_findMemberByName(trip, g, '@bobby').id, 'm2');
  assert.equal(_findMemberByName(trip, g, '阿伯').id, 'm2');
  assert.equal(_findMemberByName(trip, g, '路人'), null);
});
