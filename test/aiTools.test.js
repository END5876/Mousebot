'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

// 工具群組依模組決定是否可用（utils/features.js）：分帳要 SPLITBILL_SERVICE_URL，aiTools 要 ai（GEMINI_API_KEY）。
// 這個檔案在 FEATURES 沒設定（全開）的情況下測；FEATURES 的組合在下面的子程序裡測
process.env.SPLITBILL_SERVICE_URL ||= 'http://splitbill.example';
process.env.GEMINI_API_KEY ||= 'x';
delete process.env.FEATURES;

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
const { _rankLocal, _rankOnline } = require('../handlers/ai/tools/music');
const { zhFold } = require('../utils/zhFold');
// voice_say 要有能用的 TTS 引擎；測試不實際偵測 edge-tts，直接當成已安裝
require('../handlers/voice/ttsHandler/edgeTTS').setHasEdgeTTS(true);

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
  const { text: out, skipTTS } = await tools.runToolStage({ history: [], parts: userParts('昨天那首歌好好聽'), text: '昨天那首歌好好聽', ctx: ctxOf() });
  assert.match(out, /這次沒有替使用者/);
  assert.equal(skipTTS, false);
  assert.equal(generateCalls.length, 1);
  assert.equal(generateCalls[0].systemInstruction, tools._ROUTER_PROMPT);
});

test('runToolStage：執行模型要求的工具，結果整理成給人格的文字', async () => {
  const now = Date.now();
  freeGamesCache.set('epic', { at: now, games: [{ name: 'Game A', url: 'https://store.example/a', endDate: '2026-11-10T15:00:00.000Z' }] });
  freeGamesCache.set('steam', { at: now, games: [] });
  nextResponse = { functionCalls: [{ name: 'free_games', args: { platform: 'all' } }] };

  const { text: out, skipTTS } = await tools.runToolStage({ history: [], parts: userParts('現在有什麼免費遊戲'), text: '現在有什麼免費遊戲', ctx: ctxOf() });
  assert.match(out, /剛剛替使用者執行的動作/);
  assert.match(out, /不要自己編 YouTube 網址/);
  assert.match(out, /查免費遊戲：成功。/);
  assert.match(out, /Game A（到 .+）https:\/\/store\.example\/a/);
  assert.match(out, /Steam：目前沒有限時免費的遊戲/);
  assert.equal(skipTTS, false, '非音樂工具照常朗讀');
});

test('runToolStage：用到音樂工具時不朗讀（失敗也一樣）', async () => {
  nextResponse = { functionCalls: [{ name: 'music_control', args: { action: 'skip' } }] };
  const { text: out, skipTTS } = await tools.runToolStage({ history: [], parts: userParts('跳過這首'), text: '跳過這首', ctx: ctxOf() });
  assert.match(out, /控制播放：沒有執行，原因：Bot 現在不在語音頻道/);
  assert.equal(skipTTS, true);
});

test('runToolStage：預期內的失敗回報原因，不支援的工具名稱會被忽略', async () => {
  nextResponse = { functionCalls: [{ name: 'voice_join', args: {} }, { name: 'rm_rf', args: {} }] };
  const { text: out } = await tools.runToolStage({ history: [], parts: userParts('進來語音'), text: '進來語音', ctx: ctxOf() });
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

// ── 點歌比對 ─────────────────────────────────────────────
// getMusicFiles() 的格式：name（顯示名稱）、filename（含資料夾的相對路徑），已依播放次數排序
const lib = (...names) => names.map(n => (typeof n === 'string' ? { name: n, filename: `${n}.mp3` } : n));

test('zhFold：繁簡與大小寫互通', () => {
  assert.equal(zhFold('周杰倫 晴天 ABC'), zhFold('周杰伦 晴天 abc'));
  assert.equal(zhFold('後來'), zhFold('后来'));
  assert.equal(zhFold('plain ascii'), 'plain ascii');
});

test('本地比對：字的順序不同、繁簡不同都找得到', () => {
  const files = lib('晴天 - 周杰倫', '七里香 - 周杰伦');
  assert.equal(_rankLocal(files, '周杰倫 晴天').name, '晴天 - 周杰倫');
  assert.equal(_rankLocal(files, '周杰伦-晴天').name, '晴天 - 周杰倫');
  assert.equal(_rankLocal(files, '七里香 周杰倫').name, '七里香 - 周杰伦');
  assert.equal(_rankLocal(files, '晴天 林俊傑'), null, '每個關鍵字都要出現');
  assert.equal(_rankLocal(files, '  '), null);
});

test('本地比對：完全相同 > 名稱較短 > 播放次數', () => {
  // 清單順序就是播放次數順序：越前面播越多次
  const files = lib('晴天娃娃', '晴天 (Live)', '晴天');
  assert.equal(_rankLocal(files, '晴天').name, '晴天', '完全相同優先，即使播放次數最少');
  assert.equal(_rankLocal(lib('晴天 (Live 版)', '晴天 Live'), 'live').name, '晴天 Live', '都命中時名稱短的優先');
  assert.equal(_rankLocal(lib('晴天A', '晴天B'), '晴天').name, '晴天A', '一樣長時播放次數多的優先');
});

test('本地比對：關鍵字可以命中資料夾名稱', () => {
  const files = [{ name: '晴天', filename: '周杰倫/晴天.mp3' }, { name: '晴天', filename: '其他/晴天.mp3' }];
  assert.equal(_rankLocal(files, '周杰伦 晴天').filename, '周杰倫/晴天.mp3');
});

const yt = (title, durationSec = 240, author = 'someone') => ({ title, author, durationSec, url: `https://y/${title}` });

test('線上排序：超過 15 分鐘的排除，沒有長度的保留', () => {
  const out = _rankOnline([yt('晴天 1小時循環', 3600), yt('晴天', null), yt('晴天 MV', 269)], '晴天');
  assert.deepEqual(out.map(r => r.title), ['晴天', '晴天 MV']);
  assert.deepEqual(_rankOnline([yt('long', 901)], 'long'), []);
});

test('線上排序：live／cover／翻唱／1 hour 往後排，除非關鍵字本身就有', () => {
  const results = [yt('晴天 Live'), yt('晴天 Cover'), yt('晴天 翻唱'), yt('晴天 1 hour', 800), yt('晴天 Official MV')];
  assert.equal(_rankOnline(results, '晴天')[0].title, '晴天 Official MV');
  assert.equal(_rankOnline(results, '晴天 live')[0].title, '晴天 Live');
  // 只豁免「翻唱」這一類，Cover 仍往後排；又只有「晴天 翻唱」包含全部關鍵字
  assert.equal(_rankOnline(results, '晴天 翻唱')[0].title, '晴天 翻唱');
  assert.deepEqual(_rankOnline(results, '晴天').map(r => r.title).slice(0, 2), ['晴天 Official MV', '晴天 Live'], '受罰的維持原順序排在後面');
});

test('線上排序：標題或上傳者包含所有關鍵字的優先，繁簡互通；其餘維持原順序', () => {
  const results = [yt('晴天 Sunny Day', 269, 'Random'), yt('晴天', 269, '周杰伦 Jay Chou'), yt('Oliver 晴天', 269, 'x')];
  assert.equal(_rankOnline(results, '周杰倫 晴天')[0].author, '周杰伦 Jay Chou');
  assert.deepEqual(_rankOnline(results, '晴天').map(r => r.title), ['晴天 Sunny Day', '晴天', 'Oliver 晴天'], 'Oliver 不算 live');
});

test('判斷階段只帶最近 3 輪對話，而且從使用者開始', async () => {
  // 歷史已經合併過連續同角色（mergeConsecutiveRoles），所以是 user / model 交替
  const history = [];
  for (let i = 1; i <= 8; i++) {
    history.push({ role: 'user', parts: [{ text: `u${i}` }] });
    history.push({ role: 'model', parts: [{ text: `m${i}` }] });
  }
  nextResponse = {};
  await tools.runToolStage({ history, parts: userParts('放那首'), text: '放那首', ctx: ctxOf() });
  const sent = generateCalls[0].contents.map(c => c.parts[0].text);
  assert.deepEqual(sent.slice(0, -1), ['u6', 'm6', 'u7', 'm7', 'u8', 'm8']);
  assert.match(sent.at(-1), /放那首/);

  // 切到的開頭是 Bot 的話就丟掉
  assert.deepEqual(tools._recentTurns([{ role: 'model' }, { role: 'user' }, { role: 'model' }], 1).map(c => c.role), ['user', 'model']);
  assert.deepEqual(tools._recentTurns([{ role: 'model' }], 3), []);
  assert.deepEqual(tools._recentTurns([], 3), []);
});

// ── 依模組決定可用的工具（子程序：FEATURES 在載入時以外也會重新判斷，但每個情境用乾淨的 env 比較清楚）──
const TOOLS_SCRIPT = `
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const generateCalls = [];
stub('./handlers/ai/geminiClient', { generate: async (o) => { generateCalls.push(o); return {}; }, MODEL_NAME: 'test-model' });
stub('./handlers/ai/tokenTracker', { recordUsage: () => {} });
require('./handlers/voice/ttsHandler/edgeTTS').setHasEdgeTTS(process.env.TEST_EDGE_TTS === '1');
const features = require('./utils/features');
const tools = require('./handlers/ai/tools');
const guild = { id: 'g1', members: { me: { voice: { channelId: null } }, cache: new Map() } };
const ctx = { guild, member: { id: 'u1', voice: { channel: null, channelId: null } }, textChannel: null, userId: 'u1', source: 'text' };
const parts = (t) => [{ text: '【發言者：tester】\\n' + t }];
(async () => {
  const out = { aiTools: features.isEnabled('aiTools'), needs: {}, declared: null, stage: null };
  for (const t of ['幫我記帳 晚餐 900', '放晴天', '現在 Epic 送什麼', '進來語音陪我']) out.needs[t] = tools.needsTools(t);
  const text = '放晴天 然後幫我跟大家說晚安';
  out.stage = await tools.runToolStage({ history: [], parts: parts(text), text, ctx });
  out.declared = generateCalls[0] ? generateCalls[0].config.tools[0].functionDeclarations.map(d => d.name) : null;
  out.generateCalls = generateCalls.length;
  out.noAction = tools._noActionRule();
  process.stdout.write(JSON.stringify(out));
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
`;

const PASS_ENV = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG'];

function runTools(extraEnv) {
  const env = { LOG_LEVEL: 'error', GEMINI_API_KEY: 'x', SPLITBILL_SERVICE_URL: 'http://splitbill.example', TEST_EDGE_TTS: '1' };
  for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, extraEnv);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const res = spawnSync(process.execPath, ['-e', TOOLS_SCRIPT], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

const FULL_NO_ACTION = '【注意】這次沒有替使用者播放音樂、記帳、查遊戲或進出語音頻道。'
  + '只有在使用者明顯是要你做這些事時才需要理會這段：不要假裝已經做了，可以請他把要求說清楚（例如要放哪首歌）。'
  + '使用者只是在聊天的話，完全忽略這段，也不要提起。';

test('模組全開：宣告全部工具，NO_ACTION 字串和原本逐字相同', () => {
  const out = runTools({});
  assert.equal(out.aiTools, true);
  assert.deepEqual(out.declared, [
    'music_play', 'music_random', 'music_control', 'music_status',
    'splitbill_my_balance', 'splitbill_add_expense', 'free_games', 'voice_join', 'voice_leave', 'voice_say',
  ], '宣告順序維持音樂、分帳、免費遊戲、語音');
  assert.equal(out.noAction, FULL_NO_ACTION);
  assert.equal(out.stage.text, FULL_NO_ACTION, '模型沒有呼叫工具時附上同一段提醒');
  assert.equal(tools._noActionRule(), FULL_NO_ACTION, '本程序（全開）也一樣');
  assert.ok(Object.values(out.needs).every(Boolean));
});

test('FEATURES=ai,music：只宣告 music_*，分帳的關鍵字不再命中預篩', () => {
  const out = runTools({ FEATURES: 'ai,music' });
  assert.ok(out.declared.length > 0);
  assert.ok(out.declared.every(n => n.startsWith('music_')), out.declared.join(','));
  assert.equal(out.needs['幫我記帳 晚餐 900'], false);
  assert.equal(out.needs['放晴天'], true);
  assert.equal(out.needs['現在 Epic 送什麼'], false);
  assert.equal(out.needs['進來語音陪我'], false);
  assert.equal(out.noAction.startsWith('【注意】這次沒有替使用者播放音樂。'), true, out.noAction);
});

test('FEATURES=ai：沒有任何工具群組時不跑判斷階段', () => {
  const out = runTools({ FEATURES: 'ai' });
  assert.equal(out.aiTools, true);
  assert.ok(Object.values(out.needs).every(v => v === false));
  assert.equal(out.stage, null);
  assert.equal(out.generateCalls, 0);
});

test('FEATURES 不含 tts：沒有 voice_say；不含 voice：沒有 voice_join／voice_leave', () => {
  const noTts = runTools({ FEATURES: 'all,-tts' });
  assert.ok(!noTts.declared.includes('voice_say'));
  assert.ok(noTts.declared.includes('voice_join') && noTts.declared.includes('voice_leave'));
  assert.equal(noTts.noAction, FULL_NO_ACTION);

  const ttsOnly = runTools({ FEATURES: 'ai,tts' });
  assert.deepEqual(ttsOnly.declared, ['voice_say'], 'Bot 可能是 autojoin／music 帶進語音的，voice_say 不要求 voice 模組');
  assert.equal(ttsOnly.noAction.startsWith('【注意】這次沒有替使用者進出語音頻道。'), true);

  const noEngine = runTools({ FEATURES: 'ai,tts', TEST_EDGE_TTS: '0' });
  assert.equal(noEngine.declared, null, '沒有 TTS 引擎時沒有可宣告的工具，不呼叫模型');
  assert.equal(noEngine.stage, null);
});

test('沒有 GEMINI_API_KEY 時 aiTools 停用（需要 ai）', () => {
  const out = runTools({ GEMINI_API_KEY: undefined });
  assert.equal(out.aiTools, false);
});
