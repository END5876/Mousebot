'use strict';

// 公開模式（PUBLIC_MODE=1）：費用上限、隨機回覆、Gemini 忙碌處理、高風險功能、/privacy。
// 私人版（沒設 PUBLIC_MODE）的預設值必須和以前一樣。
// 很多設定在 require 時讀環境變數，所以這類檢查開子程序，每次用乾淨的 env 載入。
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE_ENV_KEYS = [
  'PUBLIC_MODE', 'AI_DAILY_TOKEN_BUDGET', 'AI_USER_DAILY_TOKEN_BUDGET', 'AI_GUILD_DAILY_TOKEN_BUDGET',
  'AI_RANDOM_CHANCE_DEFAULT', 'AI_RANDOM_CHANCE_MAX', 'AI_MAX_CONCURRENT', 'AI_QUEUE_MAX', 'AI_RETRY_ATTEMPTS',
  'AI_TIMEOUT_USERS', 'FEATURES',
];

/** 在子程序執行 script，回傳它 stdout 最後一行的 JSON */
function runChild(script, vars = {}) {
  const env = { ...process.env, LOG_LEVEL: 'error', MOUSEBOT_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pubmode-')) };
  for (const k of BASE_ENV_KEYS) delete env[k];
  Object.assign(env, vars);
  const res = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`子程序失敗（status ${res.status}）：\n${res.stderr}`);
  const lines = res.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

// ── utils/publicMode ──────────────────────────────────────

test('publicMode：只有 1/true/yes/on 算開啟；環境變數優先於模式預設', () => {
  const { isPublicMode, envIntByMode, envRatioByMode } = require('../utils/publicMode');
  const saved = { ...process.env };
  try {
    for (const v of ['1', 'true', 'YES', ' on ']) {
      process.env.PUBLIC_MODE = v;
      assert.equal(isPublicMode(), true, v);
    }
    for (const v of ['', '0', 'false', 'no', 'public']) {
      process.env.PUBLIC_MODE = v;
      assert.equal(isPublicMode(), false, v);
    }
    delete process.env.PUBLIC_MODE;
    delete process.env.X_INT;
    assert.equal(envIntByMode('X_INT', 0, 9), 0);
    process.env.PUBLIC_MODE = '1';
    assert.equal(envIntByMode('X_INT', 0, 9), 9);
    process.env.X_INT = '5';
    assert.equal(envIntByMode('X_INT', 0, 9), 5);
    process.env.X_INT = '-1';
    assert.equal(envIntByMode('X_INT', 0, 9), 9, '負數不合法，用模式預設');
    process.env.X_RATIO = '0.3';
    assert.equal(envRatioByMode('X_RATIO', 1, 0.1), 0.3);
    process.env.X_RATIO = '2';
    assert.equal(envRatioByMode('X_RATIO', 1, 0.1), 0.1, '超過 1 不合法');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

// ── 預設值：私人版不變、公開模式保守 ─────────────────────────

const DEFAULTS_SCRIPT = `
  const q = require('./handlers/ai/aiQuota');
  const c = require('./handlers/ai/aiChance');
  const g = require('./handlers/ai/geminiClient');
  console.log(JSON.stringify({ limits: q.getLimits(), chance: c.DEFAULT_CHANCE, max: c.MAX_CHANCE, queue: g.queueStats() }));
`;

test('預設值：私人版維持原本（不限額度、隨機 15%、最高 100%、不排隊）', () => {
  const r = runChild(DEFAULTS_SCRIPT);
  assert.deepEqual(r.limits, { userRateLimit: 8, userRateWindowSec: 60, userDailyBudget: 0, guildDailyBudget: 0, dailyBudget: 0 });
  assert.equal(r.chance, 0.15);
  assert.equal(r.max, 1);
  assert.equal(r.queue.maxConcurrent, 0);
});

test('預設值：公開模式有每日上限、隨機回覆預設關閉且最高 10%、同時 8 筆', () => {
  const r = runChild(DEFAULTS_SCRIPT, { PUBLIC_MODE: '1' });
  assert.deepEqual(r.limits, { userRateLimit: 8, userRateWindowSec: 60, userDailyBudget: 50_000, guildDailyBudget: 300_000, dailyBudget: 2_000_000 });
  assert.equal(r.chance, 0);
  assert.equal(r.max, 0.1);
  assert.deepEqual(r.queue, { active: 0, waiting: 0, maxConcurrent: 8, queueMax: 50 });
});

test('預設值：公開模式下各項仍可用環境變數覆寫', () => {
  const r = runChild(DEFAULTS_SCRIPT, {
    PUBLIC_MODE: '1', AI_DAILY_TOKEN_BUDGET: '0', AI_GUILD_DAILY_TOKEN_BUDGET: '1000',
    AI_RANDOM_CHANCE_MAX: '0.5', AI_RANDOM_CHANCE_DEFAULT: '0.05', AI_MAX_CONCURRENT: '2',
  });
  assert.equal(r.limits.dailyBudget, 0);
  assert.equal(r.limits.guildDailyBudget, 1000);
  assert.equal(r.max, 0.5);
  assert.equal(r.chance, 0.05);
  assert.equal(r.queue.maxConcurrent, 2);
});

// ── 伺服器每日上限 ────────────────────────────────────────

test('額度：同一個伺服器用完就擋下，別的伺服器、私訊、擁有者不受影響', () => {
  const r = runChild(`
    const t = require('./handlers/ai/tokenTracker');
    const q = require('./handlers/ai/aiQuota');
    const res = { usageMetadata: { totalTokenCount: 1500 } };
    t.recordUsage('chat', res, { userId: 'u1', guildId: 'g1' });
    const tryQ = (u, g) => { try { q.consumeQuota(u, g); return 'ok'; } catch (e) { return e.reason; } };
    console.log(JSON.stringify({
      g1: tryQ('u2', 'g1'), g2: tryQ('u2', 'g2'), dm: tryQ('u2', null), owner: tryQ('owner', 'g1'),
      guildTotal: t.getTodayGuildTotal('g1'), msg: q.quotaMessage({ reason: 'guildDaily' }),
    }));
  `, { AI_GUILD_DAILY_TOKEN_BUDGET: '1000', OWNER_USER_ID: 'owner' });
  assert.deepEqual(r, {
    g1: 'guildDaily', g2: 'ok', dm: 'ok', owner: 'ok', guildTotal: 1500,
    msg: '🪫 這個伺服器今天的 AI 額度已用完，明天再來吧。',
  });
});

test('額度：AiBusyError 也算額度錯誤，提示「太忙」', () => {
  const { isQuotaError, quotaMessage } = require('../handlers/ai/aiQuota');
  const { AiBusyError } = require('../handlers/ai/geminiClient');
  const err = new AiBusyError();
  assert.equal(isQuotaError(err), true);
  assert.match(quotaMessage(err), /太忙/);
});

// ── 隨機回覆上限 ──────────────────────────────────────────

test('隨機回覆：公開模式設定超過上限會被拒絕；以前存的高機率以上限計', () => {
  const r = runChild(`
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(process.env.MOUSEBOT_DATA_DIR, 'replyChance.json'), JSON.stringify({ old: 0.8 }));
    const c = require('./handlers/ai/aiChance');
    console.log(JSON.stringify({
      old: c.getReplyChance('old'), unset: c.getReplyChance('new'),
      over: c.setReplyChance('g', 0.5), ok: c.setReplyChance('g', 0.1),
    }));
  `, { PUBLIC_MODE: '1' });
  assert.equal(r.old, 0.1);
  assert.equal(r.unset, 0);
  assert.deepEqual(r.over, { success: false, error: '這個 Bot 的隨機回覆機率最高 10%' });
  assert.deepEqual(r.ok, { success: true, chance: 0.1 });
});

// ── Gemini 重試與排隊 ─────────────────────────────────────

const apiError = status => Object.assign(new Error(`status ${status}`), { status });
const noSleep = { sleep: async () => {} };

test('重試：429／503 會重試，成功就回傳結果', async () => {
  const { _internal: { withRetryAndQueue } } = require('../handlers/ai/geminiClient');
  let calls = 0;
  const result = await withRetryAndQueue(async () => {
    calls++;
    if (calls < 3) throw apiError(calls === 1 ? 429 : 503);
    return 'ok';
  }, undefined, noSleep);
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('重試：用完次數仍是 429 → AiBusyError；500 → 原本的錯誤；400 和逾時不重試', async () => {
  const { _internal: { withRetryAndQueue }, AiBusyError } = require('../handlers/ai/geminiClient');
  let calls = 0;
  await assert.rejects(withRetryAndQueue(async () => { calls++; throw apiError(429); }, undefined, noSleep),
    err => err instanceof AiBusyError && err.cause?.status === 429);
  assert.equal(calls, 3);

  await assert.rejects(withRetryAndQueue(async () => { throw apiError(500); }, undefined, noSleep), err => err.status === 500);

  for (const err of [apiError(400), Object.assign(new Error('timeout'), { name: 'TimeoutError' })]) {
    calls = 0;
    await assert.rejects(withRetryAndQueue(async () => { calls++; throw err; }, undefined, noSleep), e => e === err);
    assert.equal(calls, 1, err.message);
  }
});

test('排隊：同時數有上限、超過的排隊，排隊滿了丟 AiBusyError', async () => {
  const saved = { c: process.env.AI_MAX_CONCURRENT, q: process.env.AI_QUEUE_MAX };
  process.env.AI_MAX_CONCURRENT = '2';
  process.env.AI_QUEUE_MAX = '1';
  try {
    const { _internal: { withRetryAndQueue }, AiBusyError, queueStats } = require('../handlers/ai/geminiClient');
    let running = 0;
    let peak = 0;
    const gates = [];
    const job = () => withRetryAndQueue(() => new Promise(resolve => {
      peak = Math.max(peak, ++running);
      gates.push(() => { running--; resolve('done'); });
    }));
    const p1 = job();
    const p2 = job();
    const p3 = job();   // 排隊
    await new Promise(r => setImmediate(r));
    assert.deepEqual({ active: queueStats().active, waiting: queueStats().waiting }, { active: 2, waiting: 1 });
    await assert.rejects(job(), err => err instanceof AiBusyError);   // 排隊已滿

    gates.shift()();   // 第一筆完成，名額交給排隊的那筆
    await p1;
    await new Promise(r => setImmediate(r));
    assert.equal(queueStats().waiting, 0);
    while (gates.length) gates.shift()();
    await new Promise(r => setImmediate(r));
    while (gates.length) gates.shift()();
    assert.deepEqual(await Promise.all([p2, p3]), ['done', 'done']);
    assert.equal(peak, 2);
    assert.equal(queueStats().active, 0);
  } finally {
    for (const [k, v] of [['AI_MAX_CONCURRENT', saved.c], ['AI_QUEUE_MAX', saved.q]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ── 高風險功能 ────────────────────────────────────────────

test('AI 禁言：有名單時私人版會載入，公開模式一律不載入', () => {
  const script = `
    const tools = require('./handlers/ai/tools');
    console.log(JSON.stringify(tools._availableGroupKeys()));
  `;
  const priv = runChild(script, { AI_TIMEOUT_USERS: '123', GEMINI_API_KEY: 'x' });
  const pub = runChild(script, { AI_TIMEOUT_USERS: '123', GEMINI_API_KEY: 'x', PUBLIC_MODE: '1' });
  assert.ok(priv.includes('moderation'));
  assert.ok(!pub.includes('moderation'));
});

// ── /privacy ──────────────────────────────────────────────

test('/privacy delete：刪掉人格設定、回覆紀錄、個人用量，並設對話記憶清除點；別人的資料不動', () => {
  const r = runChild(`
    const modeSelector = require('./handlers/ai/modeSelector');
    const log = require('./handlers/ai/aiMessageLog');
    const t = require('./handlers/ai/tokenTracker');
    const mem = require('./handlers/ai/aiMemoryState');
    const { deleteUserData } = require('./handlers/privacyHandler');
    modeSelector.setUserMode('me', 'default');
    modeSelector.setUserMode('other', 'default');
    log.recordBotMessageContext('m1', 'default', 'me', 'Me', { askText: 'secret' });
    log.recordBotMessageContext('m2', 'default', 'other', 'Other');
    const res = { usageMetadata: { totalTokenCount: 10 } };
    t.recordUsage('chat', res, { userId: 'me', guildId: 'g' });
    t.recordUsage('chat', res, { userId: 'other', guildId: 'g' });
    const result = deleteUserData('me');
    console.log(JSON.stringify({
      result,
      myMode: modeSelector.getUserModeOverride('me'), otherMode: modeSelector.getUserModeOverride('other'),
      m1: log.getBotMessageContext('m1') ?? null, m2: !!log.getBotMessageContext('m2'),
      myUsage: t.getTodayUserTotal('me'), otherUsage: t.getTodayUserTotal('other'), total: t.getTodayTotal(),
      cleared: mem.getMemoryClearTime('me') > 0,
    }));
  `, { GEMINI_API_KEY: 'x', PUBLIC_MODE: '1' });
  assert.deepEqual(r, {
    result: { mode: true, replies: 1, usageDays: 1, memoryCleared: true },
    myMode: null, otherMode: 'default',
    m1: null, m2: true,
    myUsage: 0, otherUsage: 10, total: 20,
    cleared: true,
  });
});

test('/privacy：指令有 info、delete 兩個子指令', () => {
  const { buildCommand, infoText } = require('../handlers/privacyHandler');
  const json = buildCommand().toJSON();
  assert.equal(json.name, 'privacy');
  assert.deepEqual(json.options.map(o => o.name), ['info', 'delete']);
  assert.match(infoText(), /\/privacy delete/);
});
