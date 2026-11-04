'use strict';

// 長期記憶的背景萃取（memoryExtractor）：去抖動／數量觸發、預算與每日上限、額度錯誤安靜放棄、壞 JSON、
// epoch／generation 中途改變整批丟棄、Mode A 永遠不寫進 scopes、代述降級、偽造 id、memory:off、萃取開關、
// 對其他 bot 說的話不進 payload。Gemini 與用量統計換成假的；資料目錄指到暫存資料夾，不碰正式的 data/。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-memextract-'));
const PROMPTS = path.join(TMP, 'prompts');
fs.mkdirSync(path.join(PROMPTS, 'modes'), { recursive: true });
fs.writeFileSync(path.join(PROMPTS, 'modes', 'loss.md'), '---\nname: 預設\n---\nLOSS');
fs.writeFileSync(path.join(PROMPTS, 'modes', 'strictp.md'), '---\nname: 戀人\nmemory: strict\n---\nSTRICT');
fs.writeFileSync(path.join(PROMPTS, 'modes', 'offp.md'), '---\nname: 關閉\nmemory: off\n---\nOFF');

Object.assign(process.env, { MOUSEBOT_DATA_DIR: TMP, LOG_LEVEL: 'error' });

const genCalls = [];
const usageCalls = [];
let nextOutput = null;          // 物件會被 JSON.stringify；字串原樣回傳
let onGenerate = null;          // 模型呼叫期間要做的事（模擬切換範圍、清除）
function stub(relPath, exports) {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('../handlers/ai/geminiClient', {
  generate: async (opts) => {
    genCalls.push(opts);
    if (onGenerate) onGenerate(opts);
    return { text: typeof nextOutput === 'string' ? nextOutput : JSON.stringify(nextOutput ?? { add: [], update: [], remove: [] }) };
  },
  MODEL_NAME: 'test-model',
  MEMORY_MODEL_NAME: 'memory-model',
});
stub('../handlers/ai/tokenTracker', {
  recordUsage: (...a) => usageCalls.push(a),
  getTodayTotal: () => 0,
  getTodayUserTotal: () => 0,
});

const { Collection } = require('discord.js');
const extractor = require('../handlers/ai/memoryExtractor');
const memState = require('../handlers/ai/aiMemoryState');
const { getMemoryStore } = require('../handlers/ai/memoryStore');
const { AiQuotaError } = require('../handlers/ai/aiQuota');
const { snowflakeFromTs } = extractor._internal;

const G1 = '100000000000000001';
const BOT = '500000000000000001';
const OTHER_BOT = '500000000000000002';
let seq = 0;
const uid = () => `9000000000000${String(++seq).padStart(5, '0')}`;
const store = getMemoryStore();

const quotaCalls = [];
let ratio = 0;
let scopeNow = null;
function reset(extra = {}) {
  genCalls.length = 0;
  usageCalls.length = 0;
  quotaCalls.length = 0;
  nextOutput = null;
  onGenerate = null;
  ratio = 0;
  extractor._reset({
    deps: {
      budgetRatio: () => ratio,
      consumeQuota: (id) => { quotaCalls.push(id); },
      getScopeForChannel: () => scopeNow,
      ...extra,
    },
  });
}

test.after(() => {
  extractor._reset();
  store.flush();
  fs.rmSync(TMP, { recursive: true, force: true });
  setTimeout(() => process.exit(), 500).unref();
});

const LONG = '我下個月十號要去日本東京玩五天，順便去大阪看以前的大學朋友，好期待喔';

// ════════════════════════════════════════════════════════
//  Mode A
// ════════════════════════════════════════════════════════

test('Mode A：累積 8 則就萃取；模型、設定、額度與用量統計照計畫', async () => {
  reset();
  const u = uid();
  nextOutput = { add: [{ subject: 'u1', text: '11/10 要去日本東京五天', category: 'plan', evidence: '要去日本東京玩五天', msg: 'm1', expires: '2099-11-15' }], update: [], remove: [] };
  extractor.note({ userId: u, guildId: G1, text: LONG, msgId: 'x1', persona: 'loss' });
  for (let i = 0; i < 7; i++) extractor.note({ userId: u, guildId: G1, text: `第 ${i} 則聊天`, persona: 'loss' });
  await extractor.flushNow();

  assert.equal(genCalls.length, 1);
  const call = genCalls[0];
  assert.equal(call.model, 'memory-model');
  assert.equal(call.config.temperature, 0.2);
  assert.equal(call.config.maxOutputTokens, 800);
  assert.equal(call.config.responseMimeType, 'application/json');
  assert.ok(call.config.responseSchema);
  assert.equal(call.timeoutMs, 20000);
  assert.match(call.systemInstruction, /記憶整理器/);
  assert.match(call.systemInstruction, /目前人格：預設/);
  assert.match(call.contents[0].parts[0].text, /\[m1\|u1\] 我下個月十號/);
  assert.doesNotMatch(call.contents[0].parts[0].text, new RegExp(u), '模型看不到 userId');
  assert.deepEqual(quotaCalls, [null], 'consumeQuota(null)：只檢查全體預算');
  assert.equal(usageCalls[0][0], 'memory');
  assert.deepEqual(usageCalls[0][2], { userId: null, mode: null });

  const facts = store.listUserFacts(u, { origin: G1 });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].originGuildId, G1);
  assert.equal(facts[0].persona, 'loss');
  assert.equal(store.listUserFacts(u, { origin: 'dm' }).length, 0, '依伺服器隔離');
  assert.equal(store.listAllScopes().length, 0, 'Mode A 永遠不寫進 scopes');
});

test('Mode A：閒置 10 分鐘才萃取；不同伺服器分開排程', async (t) => {
  reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const u = uid();
  extractor.note({ userId: u, guildId: G1, text: LONG, persona: 'loss' });
  extractor.note({ userId: u, guildId: null, text: LONG, persona: 'loss' });
  assert.equal(extractor._internal.pending.size, 2, 'u:<uid>:<伺服器> 與 u:<uid>:dm 各一個');
  t.mock.timers.tick(extractor._internal.USER_IDLE_MS - 1000);
  assert.equal(genCalls.length, 0);
  t.mock.timers.tick(2000);
  t.mock.timers.reset();
  await extractor.flushNow();
  assert.equal(genCalls.length, 2);
});

test('Mode A：有效文字少於 30 字、memory:off 人格、optOut 都不萃取', async () => {
  reset();
  const u = uid();
  extractor.note({ userId: u, guildId: G1, text: '好喔', persona: 'loss' });
  await extractor.flushNow();
  assert.equal(genCalls.length, 0, '太短');

  extractor.note({ userId: u, guildId: G1, text: LONG, persona: 'offp' });
  assert.equal(extractor._internal.pending.size, 0, 'memory:off 不排程');

  const v = uid();
  memState.setOptOut(v, true);
  extractor.note({ userId: v, guildId: G1, text: LONG, persona: 'loss' });
  assert.equal(extractor._internal.pending.size, 0, 'optOut 不排程');
});

test('Mode A：預算 ≥ 80%、每日上限時跳過；額度錯誤安靜放棄', async () => {
  reset();
  ratio = 0.8;
  extractor.note({ userId: uid(), guildId: G1, text: LONG, persona: 'loss' });
  await extractor.flushNow();
  assert.equal(genCalls.length, 0);
  assert.equal(quotaCalls.length, 0);

  reset();
  extractor._reset({ deps: { budgetRatio: () => 0, consumeQuota: () => {} }, dailyMax: 1 });
  extractor.note({ userId: uid(), guildId: G1, text: LONG, persona: 'loss' });
  extractor.note({ userId: uid(), guildId: G1, text: LONG, persona: 'loss' });
  await extractor.flushNow();
  assert.equal(genCalls.length, 1, '第二個超過每日上限');

  reset({ consumeQuota: () => { throw new AiQuotaError('daily'); } });
  extractor.note({ userId: uid(), guildId: G1, text: LONG, persona: 'loss' });
  await assert.doesNotReject(extractor.flushNow());
  assert.equal(genCalls.length, 0);
});

test('Mode A：壞 JSON 不 throw；evidence 不符、subject 不是 u1、偽造的 id 都被忽略', async () => {
  reset();
  const u = uid();
  nextOutput = '這不是 JSON';
  extractor.note({ userId: u, guildId: G1, text: LONG, persona: 'loss' });
  await assert.doesNotReject(extractor.flushNow());
  assert.equal(store.listUserFacts(u).length, 0);

  nextOutput = {
    add: [
      { subject: 'u1', text: '喜歡吃拉麵', category: 'preference', evidence: '我超愛吃拉麵', msg: 'm1' },   // 原文沒有
      { subject: 'group', text: '要去日本', category: 'plan', evidence: '要去日本東京', msg: 'm1' },       // Mode A 沒有 group
      { subject: 'u1', text: '要去日本', category: 'plan', evidence: '要去日本東京', msg: 'm9' },          // 沒有 m9
    ],
    update: [{ id: 'ffffff', text: '偽造', evidence: '日本', msg: 'm1' }],
    remove: ['eeeeee'],
  };
  extractor.note({ userId: u, guildId: G1, text: LONG, persona: 'loss' });
  await extractor.flushNow();
  assert.equal(genCalls.length, 2);
  assert.equal(store.listUserFacts(u).length, 0);
});

test('Mode A：strict 人格只收 profile／preference；萃取途中 /ai clear（generation 改變）整批丟棄', async () => {
  reset();
  const u = uid();
  nextOutput = { add: [
    { subject: 'u1', text: '要去日本東京', category: 'plan', evidence: '要去日本東京', msg: 'm1' },
    { subject: 'u1', text: '期待去日本', category: 'preference', evidence: '好期待', msg: 'm1' },
  ], update: [], remove: [] };
  extractor.note({ userId: u, guildId: G1, text: LONG, persona: 'strictp' });
  await extractor.flushNow();
  const facts = store.listUserFacts(u, { origin: G1 });
  assert.deepEqual(facts.map(f => f.category), ['preference']);
  assert.ok(facts[0].expiresAt > Date.now(), 'strict 預設會過期');

  const v = uid();
  onGenerate = () => store.forgetAllUser(v, { origin: G1 });
  nextOutput = { add: [{ subject: 'u1', text: '要去日本東京', category: 'plan', evidence: '要去日本東京', msg: 'm1' }], update: [], remove: [] };
  extractor.note({ userId: v, guildId: G1, text: LONG, persona: 'loss' });
  await extractor.flushNow();
  assert.equal(store.listUserFacts(v).length, 0);

  // 登記後才 /ai clear（clear time 晚於訊息）：那些訊息不送
  const w = uid();
  extractor.note({ userId: w, guildId: G1, text: LONG, persona: 'loss' });
  memState.clearUserMemory(w, Date.now() + 1);
  genCalls.length = 0;
  await extractor.flushNow();
  assert.equal(genCalls.length, 0);
});

// ════════════════════════════════════════════════════════
//  Mode B
// ════════════════════════════════════════════════════════

const user = (id, name, bot = false) => ({ id, username: name, globalName: name, bot });
const coll = (list) => new Collection(list.map(u => [u.id, u]));

function makeChannel(id, messages) {
  const fetchCalls = [];
  return {
    id, guildId: G1, isThread: () => false, fetchCalls,
    messages: {
      fetch: async (opts) => {
        fetchCalls.push(opts);
        const after = opts.after ? BigInt(opts.after) : 0n;
        const list = messages.filter(m => BigInt(m.id) > after).slice(0, opts.limit);
        return new Collection(list.map(m => [m.id, m]));
      },
    },
  };
}

let tsBase = Date.now() - 5 * 60 * 1000;
function msg(author, content, { mentions = [], repliedUser = null, refId = null } = {}) {
  tsBase += 1000;
  return {
    id: (BigInt(snowflakeFromTs(tsBase)) + 1n).toString(),
    author, content, createdTimestamp: tsBase,
    member: { displayName: author.globalName },
    mentions: { users: coll(mentions), members: new Collection(), repliedUser },
    reference: refId ? { messageId: refId } : null,
  };
}

function singleScope(key, extra = {}) {
  return { kind: 'single', persona: 'loss', scopeKey: key, epoch: 5, changedAt: 0, memoryExtract: true, ...extra };
}

test('Mode B：萃取開關關閉、多人格、memory:off 人格時 noteActivity 不建立計數器', () => {
  reset();
  const ch = makeChannel('300000000000000001', []);
  extractor.noteActivity({ channel: ch, scope: singleScope('c:300000000000000001', { memoryExtract: false }), botId: BOT });
  extractor.noteActivity({ channel: ch, scope: { kind: 'multi', scopeKey: null, memoryExtract: true }, botId: BOT });
  extractor.noteActivity({ channel: ch, scope: singleScope('c:300000000000000001', { persona: 'offp' }), botId: BOT });
  assert.equal(extractor._internal.pending.size, 0);
  extractor.noteActivity({ channel: ch, scope: singleScope('c:300000000000000001'), botId: BOT });
  assert.equal(extractor._internal.pending.size, 1);
});

test('Mode B：30 則觸發；payload 只有人類原文（不含對其他 bot 說的話、指令、bot 訊息），代述降級成群組事實', async () => {
  reset();
  const CH = '300000000000000002';
  const KEY = `c:${CH}`;
  scopeNow = singleScope(KEY);
  const MING = user(uid(), '小明');
  const HUA = user(uid(), '小華');
  const otherBot = user(OTHER_BOT, 'MusicBot', true);
  const me = user(BOT, 'Mousebot', true);
  const botMsg = msg(otherBot, '正在播放：晴天');
  const list = [
    msg(MING, '我不吃香菜，每次點餐都要特別講'),
    msg(HUA, '<@' + OTHER_BOT + '> 我的戀人今天好可愛', { mentions: [otherBot] }),
    msg(HUA, '!play 晴天'),
    botMsg,
    msg(HUA, '回覆音樂 bot 的話', { repliedUser: otherBot, refId: botMsg.id }),
    msg(me, '我是本 bot 的回覆'),
    msg(MING, `<@${HUA.id}> 下週六生日，大家記得幫他慶生`, { mentions: [HUA] }),
    msg(HUA, '我們每週五晚上固定一起打 Valorant 喔'),
  ];
  const ch = makeChannel(CH, list);

  nextOutput = {
    add: [
      { subject: 'u1', text: '不吃香菜', category: 'preference', evidence: '我不吃香菜', msg: 'm1' },
      { subject: 'u2', text: '下週六生日', category: 'profile', evidence: '下週六生日', msg: 'm2' },      // 小明說小華：降級
      { subject: 'group', text: '每週五晚上一起打 Valorant', category: 'group', evidence: '每週五晚上固定一起打 Valorant', msg: 'm3' },
      { subject: 'u2', text: '戀人很可愛', category: 'other', evidence: '我的戀人今天好可愛', msg: 'm2' }, // 原文不在 payload
    ],
    update: [{ id: 'abcdef', text: '偽造', evidence: '香菜', msg: 'm1' }],
    remove: ['123456'],
  };
  for (let i = 0; i < extractor._internal.CHANNEL_BATCH_MAX; i++) {
    extractor.noteActivity({ channel: ch, scope: scopeNow, botId: BOT, authorId: MING.id });
  }
  await extractor.flushNow();

  assert.equal(genCalls.length, 1);
  const payload = genCalls[0].contents[0].parts[0].text;
  assert.match(payload, /u1 = 小明/);
  assert.match(payload, /u2 = 小華/);
  assert.match(payload, /\[m1\|u1\] 我不吃香菜/);
  assert.match(payload, /\[m2\|u1\] @小華 下週六生日/);
  assert.match(payload, /\[m3\|u2\] 我們每週五晚上/);
  for (const bad of ['戀人', '!play', '正在播放', '回覆音樂 bot', '本 bot 的回覆']) assert.ok(!payload.includes(bad), bad);
  assert.doesNotMatch(payload, /\d{17,}/, 'payload 不含任何 snowflake');
  assert.match(genCalls[0].systemInstruction, /被描述者的 u 編號/);

  const pool = store.listScopeFacts(KEY);
  assert.deepEqual(pool.members[MING.id].facts.map(f => f.text), ['不吃香菜']);
  assert.equal(pool.members[HUA.id], undefined, '別人說的事不寫進本人的成員事實');
  const bday = pool.groupFacts.find(f => f.text.includes('生日'));
  assert.equal(bday.text, '小華：下週六生日');
  assert.equal(bday.reportedBy, MING.id);
  assert.equal(bday.about, HUA.id);
  const val = pool.groupFacts.find(f => f.text.includes('Valorant'));
  assert.equal(val.reportedBy, HUA.id);
  assert.equal(pool.groupFacts.length, 2);
  assert.equal(store.getChannelCursor(KEY, CH), list[list.length - 1].id, '游標推進到最後一則（snowflake）');

  // 下一次只抓游標之後的訊息
  genCalls.length = 0;
  extractor.noteActivity({ channel: ch, scope: scopeNow, botId: BOT });
  await extractor.flushNow();
  assert.equal(ch.fetchCalls[1].after, list[list.length - 1].id);
  assert.equal(genCalls.length, 0, '沒有新訊息');
});

test('Mode B：萃取途中切換範圍（epoch 改變）或池被清除（generation 改變）整批丟棄；執行了工具的訊息不送', async () => {
  reset();
  const CH = '300000000000000003';
  const KEY = `c:${CH}`;
  scopeNow = singleScope(KEY);
  const A = user(uid(), '阿德');
  const toolMsg = msg(A, '幫我放周杰倫的晴天，然後音量開大一點謝謝');
  const list = [msg(A, '我養了一隻叫做豆豆的柴犬，已經三歲了，每天早上都要帶牠去公園散步'), toolMsg];
  const ch = makeChannel(CH, list);
  extractor.excludeMessage(toolMsg.id);
  nextOutput = { add: [{ subject: 'u1', text: '養了一隻叫豆豆的柴犬', category: 'profile', evidence: '叫做豆豆的柴犬', msg: 'm1' }], update: [], remove: [] };

  onGenerate = () => { scopeNow = singleScope(KEY, { epoch: 6 }); };
  extractor.noteActivity({ channel: ch, scope: scopeNow, botId: BOT });
  await extractor.flushNow();
  assert.equal(genCalls.length, 1);
  assert.doesNotMatch(genCalls[0].contents[0].parts[0].text, /周杰倫/);
  assert.equal(store.listScopeFacts(KEY).members[A.id], undefined, 'epoch 改變：丟棄');
  assert.equal(store.getChannelCursor(KEY, CH), null, '游標不動，之後重抓');

  onGenerate = () => store.forgetMember(KEY, A.id);
  extractor.noteActivity({ channel: ch, scope: scopeNow, botId: BOT });
  await extractor.flushNow();
  assert.equal(store.listScopeFacts(KEY).members[A.id], undefined, 'generation 改變：丟棄');
  assert.equal(store.getChannelCursor(KEY, CH), null, 'generation 改變：游標也不動（其他人的訊息之後重抓）');

  onGenerate = null;
  // 清除時間之後的新訊息照常
  list.push(msg(A, '我養了一隻叫做豆豆的柴犬，已經三歲了喔，每天早上都要帶牠去公園散步'));
  nextOutput = { add: [{ subject: 'u1', text: '養了一隻叫豆豆的柴犬', category: 'profile', evidence: '叫做豆豆的柴犬', msg: 'm1' }], update: [], remove: [] };
  extractor.noteActivity({ channel: ch, scope: scopeNow, botId: BOT });
  await extractor.flushNow();
  assert.equal(store.listScopeFacts(KEY).members[A.id].facts.length, 1);
});

test('Mode B：成員事實只能由本人更新；optOut 的人的訊息不送', async () => {
  reset();
  const CH = '300000000000000004';
  const KEY = `c:${CH}`;
  scopeNow = singleScope(KEY);
  const A = user(uid(), '阿德');
  const B = user(uid(), '阿貝');
  const C = user(uid(), '阿西');
  memState.setOptOut(C.id, true);
  store.applyScopeOps(KEY, { members: { [A.id]: { name: '阿德', ops: { add: [{ text: '喜歡喝美式咖啡', category: 'preference' }] } } } });
  const factId = store.listScopeFacts(KEY).members[A.id].facts[0].id;

  const list = [msg(B, '阿德其實改喝拿鐵了啦，美式太苦了他說，下次買咖啡記得幫他買拿鐵'), msg(C, '我住在台北市信義區某某路一段五號')];
  const ch = makeChannel(CH, list);
  nextOutput = { add: [], update: [{ id: factId, text: '喜歡喝拿鐵', evidence: '改喝拿鐵', msg: 'm1' }], remove: [factId] };
  extractor.noteActivity({ channel: ch, scope: scopeNow, botId: BOT });
  await extractor.flushNow();
  const payload = genCalls[0].contents[0].parts[0].text;
  assert.doesNotMatch(payload, /台北/);
  assert.doesNotMatch(payload, /美式咖啡/, '不在這批的成員的事實不給模型看');
  assert.deepEqual(store.listScopeFacts(KEY).members[A.id].facts.map(f => f.text), ['喜歡喝美式咖啡']);
});

test('Mode B：整頁 100 則幾乎都是指令（可用文字 < 30 字）也要推進游標，不會永遠卡在同一頁', async () => {
  reset();
  const CH = '300000000000000005';
  const KEY = `c:${CH}`;
  scopeNow = singleScope(KEY);
  const A = user(uid(), '阿德');
  const list = [msg(A, 'ok')];
  while (list.length < extractor._internal.FETCH_LIMIT) list.push(msg(A, `!play 第 ${list.length} 首`));
  const ch = makeChannel(CH, list);
  extractor.noteActivity({ channel: ch, scope: scopeNow, botId: BOT });
  await extractor.flushNow();
  assert.equal(genCalls.length, 0);
  assert.equal(store.getChannelCursor(KEY, CH), list[list.length - 1].id);

  // 沒滿一頁時一點點內容先留著，等之後跟新訊息一起
  const CH2 = '300000000000000006';
  const KEY2 = `c:${CH2}`;
  scopeNow = singleScope(KEY2);
  const ch2 = makeChannel(CH2, [msg(A, 'ok'), msg(A, '!play 晴天')]);
  extractor.noteActivity({ channel: ch2, scope: scopeNow, botId: BOT });
  await extractor.flushNow();
  assert.equal(store.getChannelCursor(KEY2, CH2), null);
});

test('Mode B：群組事實只能由回報者／被描述者刪改；別人的 update 改成新增一條', () => {
  const { translateScopeOps } = extractor._internal;
  const A = '900000000000000901';
  const B = '900000000000000902';
  const C = '900000000000000903';
  const uMap = new Map([['u1', { uid: B, name: '阿貝' }], ['u2', { uid: C, name: '阿西' }]]);
  const known = new Map([['g1', 'group'], ['g2', 'group'], ['g3', 'group']]);
  const groupMeta = new Map([
    ['g1', { reportedBy: A, category: 'plan' }],          // 阿德回報的
    ['g2', { reportedBy: A, about: B, category: 'group' }], // 阿德說阿貝的事
    ['g3', {}],                                            // 不知道是誰的
  ]);

  // 只有阿西（跟這些事實無關）發言：不能刪、不能改，update 變成他回報的新事實
  let msgs = new Map([['m1', { text: '週六聚餐改到週日晚上七點', uid: C }]]);
  let r = translateScopeOps({
    add: [], update: [{ id: 'g1', text: '週日晚上七點聚餐', evidence: '改到週日晚上七點', msg: 'm1' }], remove: ['g1', 'g2', 'g3'],
  }, { msgs, uMap, known, groupMeta });
  assert.equal(r.batch.group.update.length, 0);
  assert.equal(r.batch.group.remove.length, 0);
  assert.deepEqual(r.batch.group.add, [{ text: '週日晚上七點聚餐', category: 'plan', expires: null, reportedBy: C }]);
  assert.equal(r.dropped, 3);

  // 被描述者（阿貝）發言：可以改、可以刪 g2；g3 沒有當事人，誰都不能動
  msgs = new Map([['m1', { text: '我已經不打 Valorant 了', uid: B }]]);
  r = translateScopeOps({
    add: [], update: [{ id: 'g2', text: '阿貝不打 Valorant 了', evidence: '不打 Valorant', msg: 'm1' }], remove: ['g2', 'g3'],
  }, { msgs, uMap, known, groupMeta });
  assert.deepEqual(r.batch.group.update, [{ id: 'g2', text: '阿貝不打 Valorant 了' }]);
  assert.deepEqual(r.batch.group.remove, ['g2']);
  assert.equal(r.batch.group.add.length, 0);
  assert.equal(r.dropped, 1);
});

test('Mode B：執行了工具的排除名單會存檔，重啟後仍然排除', () => {
  reset();
  const id = '300000000000009999';
  extractor.excludeMessage(id);
  extractor._reloadExcluded();
  assert.equal(extractor._internal.isExcluded(id), true);
  assert.equal(extractor._internal.isExcluded('300000000000009998'), false);
});

test('snowflakeFromTs：換算後的時間與 Discord 一致', () => {
  const ts = 1730700000000;
  const sf = BigInt(snowflakeFromTs(ts));
  assert.equal(Number((sf >> 22n) + 1420070400000n), ts);
});
