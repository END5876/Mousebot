'use strict';

// 範圍鎖定（AI_SCOPE_LOCK=single）時的 AI：MouseBot 與 mousebot-lite 共用這份測試（mousebot-lite 預設就是鎖定）。
//   - /ai 只有 ask／clear／chance（MouseBot 另有 gugu 模組時多一個 gugu），只能在伺服器內使用
//   - 範圍一律是單一人格，scopeKey 依伺服器並帶上人格代號；私訊不回覆
//   - 不載入 aiScope、modeSelector（不讀寫 aiScope.json、userModes.json）
// 不打 Gemini（geminiClient 的 generate 換成假的）；資料目錄指到暫存資料夾，不碰正式的 data/。
// 環境變數一律在這裡明確設定，不依賴 profile.js 的預設值，兩個 repo 跑出來的結果才會相同。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-scope-lock-'));

const BOT_ID = '500000000000000001';
const OWNER_ID = '900000000000000009';
const GUILD_ID = '111111111111111111';

for (const key of [
  'AI_DEFAULT_MODE', 'AI_USER_MODE_OVERRIDES', 'GEMINI_MODEL', 'GEMINI_SEARCH_GUILD_IDS',
  'MEME_PUBLIC_URL', 'MEME_DISPLAY_SIZE', 'AI_GROUP_MSG_LIMIT',
  'AI_USER_RATE_WINDOW_SEC', 'AI_USER_DAILY_TOKEN_BUDGET', 'AI_DAILY_TOKEN_BUDGET',
  'SOVITS_HOST', 'GROQ_API_KEY', 'SPLITBILL_SERVICE_URL',
]) delete process.env[key];
Object.assign(process.env, {
  MOUSEBOT_DATA_DIR: TMP,
  LOG_LEVEL: 'error',
  AI_SCOPE_LOCK: 'single',
  AI_PERSONA: 'chat',
  AI_RANDOM_SLOT: '0/2',
  FEATURES: 'ai,autojoin,music',
  AI_USER_RATE_LIMIT: '3',
  OWNER_USER_ID: OWNER_ID,
  GEMINI_API_KEY: 'x',
});

function writeData(rel, content) {
  const file = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// ── 假的 Gemini ──────────────────────────────────────────
const geminiPath = require.resolve('../handlers/ai/geminiClient');
const realGemini = require(geminiPath);
const calls = [];
// 本次訊息最前面的「現在時間」每分鐘都不同：記錄前抽掉，另外記下抽到的內容（test/currentTime.test.js 測格式）
const TIME_PREFIX = '【現在時間：';
const timeParts = [];
function stripTimePart(contents) {
  const last = contents.at(-1);
  if (!last?.parts) return contents;
  const parts = last.parts.filter(p => {
    if (typeof p.text === 'string' && p.text.startsWith(TIME_PREFIX)) { timeParts.push(p.text); return false; }
    return true;
  });
  return [...contents.slice(0, -1), { ...last, parts }];
}
let respond = () => 'OK';
function response(text, extra = {}) {
  return {
    text,
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    candidates: [{ finishReason: 'STOP', ...extra }],
  };
}
require.cache[geminiPath].exports = {
  ...realGemini,
  async generate({ contents, systemInstruction, config = {} }) {
    contents = stripTimePart(contents);
    calls.push(structuredClone({ systemInstruction, contents, config }));
    if (config.tools?.some(t => t.googleSearch)) return response('NONE', { groundingMetadata: {} });
    const out = respond({ contents, systemInstruction, config });
    return typeof out === 'string' ? response(out) : out;
  },
};
function track() {
  const start = calls.length;
  return () => calls.slice(start);
}

// ── token 統計只記參數，不寫檔（要在 aiCore 載入前換掉）──
const tokenTracker = require('../handlers/ai/tokenTracker');
const usage = [];
tokenTracker.recordUsage = (source, _res, meta = {}) => { usage.push({ source, mode: meta.mode ?? null }); };

const { Collection, MessageFlags } = require('discord.js');
const promptStore = require('../handlers/ai/promptStore');
const persona = require('../handlers/ai/persona');
const memeStore = require('../handlers/ai/memeStore');
const aiChance = require('../handlers/ai/aiChance');
const aiMessageLog = require('../handlers/ai/aiMessageLog');
const bootSummary = require('../utils/bootSummary');
const features = require('../utils/features');
const { buildSystemInstruction, _internal: { CURRENT_TURN_DIVIDER } } = require('../handlers/ai/aiCore');
const { setupAICommands, isAIEnabled } = require('../handlers/ai/aiHandler');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  // aiUtils 有常駐的圖片快取清理計時器，等測試框架寫完結果後主動結束
  setTimeout(() => process.exit(), 500).unref();
});

// ════════════════════════════════════════════════════════
//  假的 Discord 物件
// ════════════════════════════════════════════════════════
let clock = Date.now() - 20 * 60 * 1000;
const tick = () => (clock += 1000);
let idSeq = 1;
const nextId = () => String(700000000000000000n + BigInt(idSeq++));
let channelSeq = 1;
const nextChannelId = () => String(300000000000000000n + BigInt(channelSeq++));

const BOT_USER = { id: BOT_ID, username: 'testbot', globalName: null, bot: true };
const user = (id, username, globalName = null, bot = false) => ({ id, username, globalName, bot });
const U = {
  ming:   user('900000000000000001', 'ming', '小明'),
  hua:    user('900000000000000002', 'hua'),
  spam:   user('900000000000000005', 'spam'),
  // 每人每分鐘只有 3 次額度（AI_USER_RATE_LIMIT=3）：錯誤處理的案例各用自己的帳號
  e1:     user('900000000000000011', 'e1'),
  e2:     user('900000000000000012', 'e2'),
  e3:     user('900000000000000013', 'e3'),
  e4:     user('900000000000000014', 'e4'),
  e5:     user('900000000000000015', 'e5'),
  t1:     user('900000000000000021', 't1'),
  t2:     user('900000000000000022', 't2'),
  admin:  user('900000000000000006', 'admin'),
  member: user('900000000000000007', 'member'),
  owner:  user(OWNER_ID, 'boss'),
  other:  user('900000000000000008', 'otherbot', null, true),
};
const memberOf = u => (u.id === U.ming.id ? { displayName: '明明' } : null);
const GUILD = { id: GUILD_ID, name: '測試伺服器', members: { cache: new Collection() } };

function mentionsOf(users = [], repliedUser = null) {
  const col = new Collection(users.map(u => [u.id, u]));
  return {
    users: col, roles: new Collection(), channels: new Collection(), repliedUser,
    has: (u) => col.has(u.id) || repliedUser?.id === u.id,
  };
}

// 送出的內容：附件路徑換成相對資料目錄的寫法
function normPayload(p) {
  const out = { ...p };
  if (p.files) out.files = p.files.map(f => ({ ...f, attachment: path.relative(TMP, f.attachment).replaceAll('\\', '/') }));
  return out;
}

function botMessage(payload, channel) {
  const attachments = new Collection((payload.files ?? []).map(f => {
    const id = nextId();
    return [id, { id, name: f.name, url: `https://cdn.discordapp.com/attachments/1/${id}/${f.name}` }];
  }));
  return {
    id: nextId(), author: BOT_USER, member: null,
    content: payload.content ?? '', cleanContent: payload.content ?? '',
    createdTimestamp: tick(), attachments, embeds: [], mentions: mentionsOf(), reference: null,
    guild: channel.guild, guildId: channel.guild?.id ?? null, channel,
    delete: async () => {},
  };
}

function fakeChannel({ guild = GUILD } = {}) {
  const col = new Collection();
  const channel = {
    id: nextChannelId(), guild, guildId: guild?.id ?? null,
    isThread: () => false,
    sent: [],
    failSend: null,
    add(m) { col.set(m.id, m); },
    messages: {
      async fetch(arg) {
        if (typeof arg === 'string') {
          if (!col.has(arg)) throw new Error('Unknown Message');
          return col.get(arg);
        }
        return new Collection(col);
      },
    },
    sendTyping: async () => {},
    async send(payload) {
      channel.sent.push(normPayload(payload));
      if (channel.failSend?.(payload)) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
      const m = botMessage(payload, channel);
      col.set(m.id, m);
      return m;
    },
  };
  return channel;
}

function userMsg(channel, author, content, { id = nextId(), mentions = [], reference = null, guild = channel.guild } = {}) {
  const msg = {
    id, author, member: author.bot ? null : memberOf(author),
    content, cleanContent: content, createdTimestamp: tick(),
    attachments: new Collection(), embeds: [],
    mentions: mentionsOf(mentions, reference ? reference.author : null),
    reference: reference ? { messageId: reference.id } : null,
    guild, guildId: guild?.id ?? null, channel,
    replies: [],
    async reply(payload) { msg.replies.push(payload); return { delete: async () => {} }; },
  };
  channel.add(msg);
  return msg;
}

const listeners = new Map();
const client = {
  user: BOT_USER,
  commands: new Collection(),
  on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); return client; },
  once(event, fn) { return client.on(event, fn); },
};
async function emitMessage(msg) {
  for (const fn of listeners.get('messageCreate') ?? []) await fn(msg);
}

function fakeInteraction({ user: u, admin = false, channel, sub, group = null, opts = {} }) {
  const log = [];
  const interaction = {
    id: nextId(), user: u, member: memberOf(u),
    guild: channel.guild, guildId: channel.guild.id, channel, channelId: channel.id,
    client: { user: BOT_USER },
    memberPermissions: { has: () => admin },
    options: {
      getSubcommand: () => sub,
      getSubcommandGroup: () => group,
      getString: n => opts[n] ?? null,
      getAttachment: n => opts[n] ?? null,
      getBoolean: n => opts[n] ?? null,
      getNumber: n => opts[n] ?? null,
    },
    log,
    failEdit: null,
    async reply(p) { log.push(['reply', p]); },
    async deferReply() { log.push(['deferReply']); },
    async editReply(p) {
      log.push(['editReply', normPayload(p)]);
      if (interaction.failEdit?.(p)) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
      const m = botMessage(p, channel);
      channel.add(m);
      return m;
    },
    async followUp(p) {
      log.push(['followUp', normPayload(p)]);
      const m = botMessage(p, channel);
      channel.add(m);
      return m;
    },
    async deleteReply() { log.push(['deleteReply']); },
  };
  return interaction;
}
const runAi = interaction => client.commands.get('ai').execute(interaction);

const EMPTY_RESPONSE_MESSAGE = '🤔 這次沒有產生任何回覆（可能被內容過濾擋下了），換個說法再試一次吧。';
const userTurn = (...texts) => ({ role: 'user', parts: texts.map(text => ({ text })) });
const memeFile = { attachment: 'memes/chat/.cache/small-160/aaaaaa0001.png', name: `meme-${require('crypto').createHash('sha1').update('kai').digest('hex').slice(0, 10)}.png` };

// ════════════════════════════════════════════════════════
//  啟用條件與指令
// ════════════════════════════════════════════════════════
test('鎖定設定：AI_SCOPE_LOCK=single 時人格取自 AI_PERSONA', () => {
  assert.deepEqual({ ...persona.getLock() }, { kind: 'single', persona: 'chat', source: 'AI_PERSONA' });
  assert.equal(persona.isLocked(), true);
});

test('沒有 GEMINI_API_KEY（或只有空白）：不註冊 /ai、不監聽訊息', () => {
  try {
    for (const key of [undefined, '', '   ']) {
      if (key === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = key;
      assert.equal(isAIEnabled(), false);
      const events = [];
      const c = { commands: new Collection(), on: (name) => events.push(name) };
      assert.equal(setupAICommands(c), false);
      assert.equal(c.commands.size, 0);
      assert.deepEqual(events, []);
    }
  } finally {
    process.env.GEMINI_API_KEY = 'x';
  }
});

test('範圍：一律單一人格，scopeKey 依伺服器並帶上人格代號', () => {
  const s = persona.scopeFor('123');
  assert.deepEqual({ ...s }, { kind: 'single', persona: 'chat', scopeKey: 'g:123:chat', changedAt: 0 });
  assert.ok(Object.isFrozen(s));
  assert.notEqual(persona.scopeFor('456').scopeKey, s.scopeKey);
  assert.equal(persona.resolveScope({ guildId: '123' }, '123').scopeKey, 'g:123:chat');
  assert.equal(persona.modeFor('任何人', null), 'chat');
});

test('沒有人格檔與 _group.md：用內建的通用人格與內建群聊規則', () => {
  assert.equal(persona.hasPersonaFile(), false);
  assert.equal(persona.getPersonaName(), '預設人格');
  const si = buildSystemInstruction({ roster: '【目前這段對話中的成員】\n- A' });
  assert.equal(si, [persona.BUILTIN_PERSONA_PROMPT, persona.BUILTIN_GROUP_RULES, '【目前這段對話中的成員】\n- A'].join('\n\n'));
});

test('有人格檔時：順序 persona → _general → _group → 名冊；clearMemoryMessage 取自人格檔', () => {
  promptStore.saveMode('chat', { name: '聊天鼠', clearMemoryMessage: '忘光光了', prompt: '你是聊天鼠。' });
  promptStore.saveShared('_general', '一律用繁體中文。');
  promptStore.saveShared('_group', '群聊規則。');

  assert.equal(persona.hasPersonaFile(), true);
  assert.equal(persona.getPersonaName(), '聊天鼠');
  assert.equal(persona.getClearMessage(), '忘光光了');
  assert.equal(buildSystemInstruction({ roster: 'R' }), '你是聊天鼠。\n\n一律用繁體中文。\n\n群聊規則。\n\nR');
  assert.equal(buildSystemInstruction(), '你是聊天鼠。\n\n一律用繁體中文。\n\n群聊規則。');
});

test('有 GEMINI_API_KEY：註冊 /ai（ask / clear / chance，限伺服器內）並監聽 messageCreate；開機摘要用單一人格的文字', () => {
  // 表情包圖庫（套組清單 + 已經縮好的圖，不會連網下載）
  const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  writeData('memes/chat/memes.json', JSON.stringify({
    stickers: [{ id: 'kai', name: '開心', emotion: '開心', tags: [], use: '被誇的時候', url: 'https://memes.example.com/kai.png', hash: 'aaaaaa0001' }],
  }));
  writeData('memes/chat/.cache/small-160/aaaaaa0001.png', PNG_1PX);
  memeStore._internal.resetCache?.();

  bootSummary.reset();
  assert.equal(setupAICommands(client), true);
  const json = JSON.parse(JSON.stringify(client.commands.get('ai').data.toJSON()));
  // gugu 是 MouseBot 才有的模組（hidden，只要 AI 開著就有）
  const expected = ['ask', 'clear', 'chance', ...(features.isEnabled('gugu') ? ['gugu'] : [])];
  assert.deepEqual(json.options.map(o => o.name), expected);
  assert.deepEqual(json.contexts, [0]); // InteractionContextType.Guild
  assert.deepEqual(json.options[1].options.map(o => o.name), ['all']);
  assert.equal(json.options[1].description, '清除你在這個頻道與 AI 的對話記憶');
  assert.deepEqual([...listeners.keys()], ['messageCreate']);

  const rows = bootSummary.getItems().filter(i => i.name === 'AI 對話 (/ai)' || i.name === 'AI 表情包');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'ok');
  assert.match(rows[0].detail, /^Gemini \(.+\) 單一人格；人格：聊天鼠（chat）；額度：每人 3 次\/60s；搜尋接地：停用$/);
  assert.deepEqual(rows[1], { name: 'AI 表情包', status: 'ok', detail: '1 張，送附件（手機版會拉滿寬度；設 MEME_PUBLIC_URL=https://… 改送網址）' });
});

// ════════════════════════════════════════════════════════
//  B2：/ai clear
// ════════════════════════════════════════════════════════
test('/ai clear：all 只有管理員或擁有者能用，一般清除只清自己（以頻道為單位）', async () => {
  const BASE = '忘光光了';
  const ALL_OK = { content: `${BASE}\n> 已清除**這個頻道所有人**的對話記憶。` };
  const ALL_DENIED = { content: '❌ 清除整個頻道的對話記憶需要管理員權限。', flags: MessageFlags.Ephemeral };
  const SELF_OK = { content: `${BASE}\n> 只清除了**你自己**在這個頻道的對話記憶，其他人的不受影響。` };
  for (const [u, admin, all, expected] of [
    [U.admin, true, true, ALL_OK],
    [U.owner, false, true, ALL_OK],
    [U.member, false, true, ALL_DENIED],
    [U.admin, true, null, SELF_OK],
    [U.member, false, null, SELF_OK],
  ]) {
    const i = fakeInteraction({ user: u, admin, channel: fakeChannel(), sub: 'clear', opts: { all } });
    await runAi(i);
    assert.deepEqual(i.log, [['reply', expected]], `${u.username} all=${all}`);
  }
});

// ════════════════════════════════════════════════════════
//  B3：/ai chance
// ════════════════════════════════════════════════════════
test('/ai chance：擁有者不是管理員也能用，一般成員被拒絕', async () => {
  const guild = { id: '111111111111111113', name: '機率伺服器', members: { cache: new Collection() } };
  const channel = fakeChannel({ guild });
  const run = async (u, admin, sub, opts = {}) => {
    const i = fakeInteraction({ user: u, admin, channel, sub, group: 'chance', opts });
    await runAi(i);
    return i.log;
  };
  const eph = content => [['reply', { content, flags: MessageFlags.Ephemeral }]];

  assert.deepEqual(await run(U.member, false, 'set', { chance: 30 }), eph('❌ 你沒有權限使用此指令。'));
  assert.deepEqual(await run(U.member, false, 'toggle'), eph('❌ 你沒有權限使用此指令。'));
  assert.deepEqual(await run(U.owner, false, 'set', { chance: 30 }), eph('✅ 已將本伺服器的 AI 隨機回覆機率設為 **30.0%**'));
  assert.equal(aiChance.getReplyChance(guild.id), 0.3);
  assert.deepEqual(await run(U.admin, true, 'set'), eph(`🔄 已重置本伺服器的隨機回覆機率為預設值：**${(aiChance.DEFAULT_CHANCE * 100).toFixed(1)}%**`));
  assert.deepEqual(await run(U.owner, false, 'toggle'), eph(`🔕 已關閉 <#${channel.id}> 的 AI 隨機回覆（@ 提及仍有效）`));
  assert.deepEqual(await run(U.owner, false, 'toggle'), eph(`🔔 已開啟 <#${channel.id}> 的 AI 隨機回覆`));
});

// ════════════════════════════════════════════════════════
//  B4：送給 Gemini 的請求
// ════════════════════════════════════════════════════════
test('@ 提及：群組歷史帶分隔、system instruction 含表情包，回覆帶表情包附件並記下範圍', async () => {
  const channel = fakeChannel();
  userMsg(channel, U.hua, '大家晚上打球嗎');
  userMsg(channel, U.other, '!play 完成');                 // 其他 bot：不進歷史
  respond = () => '當然要！\n[表情:開心]';
  const msg = userMsg(channel, U.ming, `<@${BOT_ID}> 你也來嗎`, { mentions: [BOT_USER] });
  const got = track();
  const timeBefore = timeParts.length;
  await emitMessage(msg);

  assert.equal(got().length, 1);
  // 本次訊息帶了一行現在時間（被 stripTimePart 抽掉，所以下面的 contents 看不到）
  assert.equal(timeParts.length, timeBefore + 1);
  assert.match(timeParts.at(-1), /^【現在時間：\d{4}年\d{1,2}月\d{1,2}日（星期[日一二三四五六]）\d{2}:\d{2}，時區 .+】$/);
  const [call] = got();
  assert.equal(call.systemInstruction, [
    '你是聊天鼠。', '一律用繁體中文。', '群聊規則。', memeStore.getMemePrompt('chat'),
    '【目前這段對話中的成員】\n- hua (@hua)\n- 明明 (@ming)',
  ].join('\n\n'));
  assert.deepEqual(call.contents, [userTurn('【發言者：hua (@hua)】\n大家晚上打球嗎', CURRENT_TURN_DIVIDER, '【發言者：明明 (@ming)】\n你也來嗎')]);
  assert.deepEqual(channel.sent, [{ content: '當然要！', files: [memeFile] }]);

  const replyMsg = [...(await channel.messages.fetch()).values()].at(-1);
  const ctx = aiMessageLog.getBotMessageContext(replyMsg.id);
  assert.equal(ctx.mode, 'chat');
  assert.equal(ctx.kind, 'single');
  assert.equal(ctx.scopeKey, `g:${GUILD_ID}:chat`);
});

test('只 @ 沒打字：沒有引用是打招呼，有引用是想聽對引用內容的反應', async () => {
  respond = () => '嗨';
  const channel = fakeChannel();
  let got = track();
  await emitMessage(userMsg(channel, U.hua, `<@${BOT_ID}>`, { mentions: [BOT_USER] }));
  assert.deepEqual(got()[0].contents, [userTurn('【發言者：hua (@hua)】\n（只 @ 了你，沒有說任何話）')]);

  const channel2 = fakeChannel();
  const quoted = userMsg(channel2, U.ming, '今天的晚餐是咖哩');
  got = track();
  await emitMessage(userMsg(channel2, U.hua, `<@${BOT_ID}>`, { mentions: [BOT_USER], reference: quoted }));
  const parts = got()[0].contents.at(-1).parts.map(p => p.text);
  assert.equal(parts.at(-1), '【發言者：hua (@hua)】\n（只 @ 了你，沒打字，想聽你對上面引用內容的反應）');
  assert.ok(parts.some(t => t.startsWith('【hua (@hua) 引用的舊訊息】')), parts.join('\n'));
});

test('/ai ask：askText、scopeKey、表情包 payload', async () => {
  const channel = fakeChannel();
  userMsg(channel, U.hua, '有人在嗎');
  respond = () => '會游泳\n[表情:開心]';
  const i = fakeInteraction({ user: U.ming, channel, sub: 'ask', opts: { question: '魚會做什麼' } });
  const got = track();
  await runAi(i);
  assert.deepEqual(got()[0].contents, [userTurn('【發言者：hua (@hua)】\n有人在嗎', CURRENT_TURN_DIVIDER, '【發言者：明明 (@ming)】\n魚會做什麼')]);
  assert.deepEqual(i.log, [['deferReply'], ['editReply', { content: '會游泳', files: [memeFile] }]]);

  const replyMsg = [...(await channel.messages.fetch()).values()].at(-1);
  const ctx = aiMessageLog.getBotMessageContext(replyMsg.id);
  assert.equal(ctx.mode, 'chat');
  assert.equal(ctx.scopeKey, `g:${GUILD_ID}:chat`);
  assert.equal(ctx.askText, '魚會做什麼');
});

test('隨機回覆：maxOutputTokens 300，回覆送到頻道', async () => {
  const guild = { id: '111111111111111114', name: '插話伺服器', members: { cache: new Collection() } };
  aiChance.setReplyChance(guild.id, 1);
  const channel = fakeChannel({ guild });
  userMsg(channel, U.hua, '今天好熱');
  respond = () => '真的熱';
  const got = track();
  await emitMessage(userMsg(channel, U.ming, '熱到不想動'));
  assert.equal(got().length, 1);
  assert.equal(got()[0].config.maxOutputTokens, 300);
  assert.deepEqual(channel.sent, [{ content: '真的熱' }]);
});

test('回覆照抄【現在時間】標籤：送出前拿掉；只剩標籤時當成空回覆不送出', async () => {
  const tag = '【現在時間：2026年11月8日（星期日）14:05，時區 Asia/Taipei】';
  const channel = fakeChannel();
  respond = () => `${tag}\n兩點了，該午睡`;
  // 每人每分鐘只有 3 次額度：用自己的帳號
  await emitMessage(userMsg(channel, U.t1, `<@${BOT_ID}> 幾點了`, { mentions: [BOT_USER] }));
  assert.deepEqual(channel.sent, [{ content: '兩點了，該午睡' }]);

  const i = fakeInteraction({ user: U.t2, channel: fakeChannel(), sub: 'ask', opts: { question: '幾點了' } });
  respond = () => tag;
  await runAi(i);
  assert.ok(i.log.length > 0, '應該有回應（空回覆的提示）');
  assert.ok(!JSON.stringify(i.log).includes('現在時間'), JSON.stringify(i.log));
});

// ════════════════════════════════════════════════════════
//  B5：會被忽略的訊息
// ════════════════════════════════════════════════════════
test('私訊、Bot、只 @ 別人、回覆別人、含連結、頻道已停用：都不呼叫 Gemini', async () => {
  const guild = { id: '111111111111111115', name: '忽略伺服器', members: { cache: new Collection() } };
  aiChance.setReplyChance(guild.id, 1);   // 沒被擋下的話一定會隨機回覆
  respond = () => '不該出現';
  const cases = [];

  const dm = fakeChannel({ guild: null });
  cases.push(['私訊', dm, userMsg(dm, U.hua, `<@${BOT_ID}> 嗨`, { mentions: [BOT_USER], guild: null })]);
  const ch1 = fakeChannel({ guild });
  cases.push(['Bot 發的訊息', ch1, userMsg(ch1, U.other, `<@${BOT_ID}> 嗨`, { mentions: [BOT_USER] })]);
  const ch2 = fakeChannel({ guild });
  cases.push(['只 @ 別人', ch2, userMsg(ch2, U.hua, `<@${U.ming.id}> 來玩`, { mentions: [U.ming] })]);
  const ch3 = fakeChannel({ guild });
  const mingMsg = userMsg(ch3, U.ming, '我先睡了');
  cases.push(['回覆別人', ch3, userMsg(ch3, U.hua, '晚安', { reference: mingMsg })]);
  const ch4 = fakeChannel({ guild });
  cases.push(['含連結', ch4, userMsg(ch4, U.hua, '看這個 https://example.com/a')]);
  const ch5 = fakeChannel({ guild });
  aiChance.setChannelDisabled(ch5.id, true);
  cases.push(['頻道已停用', ch5, userMsg(ch5, U.hua, '有人嗎')]);

  for (const [name, channel, msg] of cases) {
    const got = track();
    await emitMessage(msg);
    assert.equal(got().length, 0, name);
    assert.deepEqual(channel.sent, [], name);
    assert.deepEqual(msg.replies, [], name);
  }
  aiChance.setChannelDisabled(ch5.id, false);
});

// ════════════════════════════════════════════════════════
//  B7：錯誤提示
// ════════════════════════════════════════════════════════
test('額度用完：@ 提及回覆頻率提示', async () => {
  const channel = fakeChannel();
  respond = () => '好';
  for (let n = 0; n < 3; n++) {
    await emitMessage(userMsg(channel, U.spam, `<@${BOT_ID}> 第 ${n} 次`, { mentions: [BOT_USER] }));
  }
  assert.equal(channel.sent.length, 3);
  const msg = userMsg(channel, U.spam, `<@${BOT_ID}> 再一次`, { mentions: [BOT_USER] });
  const got = track();
  await emitMessage(msg);
  assert.equal(got().length, 0);
  assert.equal(channel.sent.length, 3);
  assert.match(msg.replies[0].content, /^⏳ 你問得太快了，請 \d+ 秒後再試。$/);
});

test('空回應：回覆空回應提示；只有表情包但送不出去：安靜放棄；文字 + 表情包送不出去：改送純文字', async () => {
  const notice = { content: EMPTY_RESPONSE_MESSAGE, allowedMentions: { repliedUser: false } };

  let channel = fakeChannel();
  respond = () => response('', { finishReason: 'SAFETY' });
  let msg = userMsg(channel, U.e1, `<@${BOT_ID}> 說點什麼`, { mentions: [BOT_USER] });
  await emitMessage(msg);
  assert.deepEqual(msg.replies, [notice]);
  assert.deepEqual(channel.sent, []);

  channel = fakeChannel();
  channel.failSend = p => !!p.files;
  respond = () => '[表情:開心]';
  msg = userMsg(channel, U.e2, `<@${BOT_ID}> 傳張圖`, { mentions: [BOT_USER] });
  await emitMessage(msg);
  assert.deepEqual(channel.sent, [{ files: [memeFile] }]);
  assert.deepEqual(msg.replies, []);

  channel = fakeChannel();
  channel.failSend = p => !!p.files;
  respond = () => '給你\n[表情:開心]';
  msg = userMsg(channel, U.e3, `<@${BOT_ID}> 傳張圖`, { mentions: [BOT_USER] });
  await emitMessage(msg);
  assert.deepEqual(channel.sent, [{ content: '給你', files: [memeFile] }, { content: '給你' }]);
});

test('/ai ask：空回應、只有表情包但送不出去就刪掉回覆', async () => {
  let i = fakeInteraction({ user: U.e4, channel: fakeChannel(), sub: 'ask', opts: { question: '在嗎' } });
  respond = () => response('');
  await runAi(i);
  assert.deepEqual(i.log, [['deferReply'], ['editReply', { content: EMPTY_RESPONSE_MESSAGE }]]);

  respond = () => '[表情:開心]';
  i = fakeInteraction({ user: U.e5, channel: fakeChannel(), sub: 'ask', opts: { question: '傳張圖' } });
  i.failEdit = p => !!p.files;
  await runAi(i);
  assert.deepEqual(i.log, [['deferReply'], ['editReply', { files: [memeFile] }], ['deleteReply']]);
});

// ════════════════════════════════════════════════════════
//  B8：token 統計
// ════════════════════════════════════════════════════════
test('token 統計的 mode（byMode）一律是人格代號', () => {
  assert.ok(usage.length > 0);
  assert.deepEqual([...new Set(usage.map(u => u.mode))], ['chat']);
  assert.deepEqual([...new Set(usage.map(u => u.source))].sort(), ['chat', 'short']);
});

// ════════════════════════════════════════════════════════
//  鎖定時不載入多人格的模組
// ════════════════════════════════════════════════════════
test('鎖定時 require.cache 裡沒有 aiScope 和 modeSelector', () => {
  for (const name of ['aiScope', 'modeSelector']) {
    const file = path.resolve(__dirname, '..', 'handlers', 'ai', `${name}.js`);
    assert.equal(require.cache[file], undefined, `${name} 不應該被載入`);
  }
});
