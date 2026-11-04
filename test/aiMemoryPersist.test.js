'use strict';

// 清除記憶時間點（aiMemoryState）與 AI 回覆紀錄（aiMessageLog）寫入檔案：重啟後仍有效。
// 資料目錄用 MOUSEBOT_DATA_DIR 指到暫存資料夾，不碰正式的 data/。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-aimem-'));
process.env.MOUSEBOT_DATA_DIR = TMP;
process.env.LOG_LEVEL = 'error';

const { dataPath, getDataDir, DEFAULT_DATA_DIR } = require('../utils/dataDir');
const memState = require('../handlers/ai/aiMemoryState');
const msgLog = require('../handlers/ai/aiMessageLog');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('dataDir：環境變數覆寫資料目錄', () => {
  assert.equal(getDataDir(), path.resolve(TMP));
  assert.equal(dataPath('a.json'), path.join(path.resolve(TMP), 'a.json'));
  assert.notEqual(DEFAULT_DATA_DIR, getDataDir());
});

test('require 時不讀寫任何檔案', () => {
  assert.equal(fs.existsSync(path.join(TMP, 'aiMemoryState.json')), false);
  assert.equal(fs.existsSync(path.join(TMP, 'aiMessageLog.json')), false);
});

test('aiMemoryState：clear time 重啟後仍有效', () => {
  assert.equal(memState.getMemoryClearTime('u1'), 0);
  memState.clearUserMemory('u1', 1000);
  memState.clearChannelMemory('c1', 2000);
  memState.clearUserInChannel('c1', 'u2', 3000);
  memState.setOptOut('u3', true);
  memState.setOptOut('u4', true);
  memState.setOptOut('u4', false);

  memState._reset(); // 模擬重啟
  assert.equal(memState.getMemoryClearTime('u1'), 1000);
  assert.equal(memState.getChannelClearTime('c1'), 2000);
  assert.equal(memState.getUserInChannelClearTime('c1', 'u2'), 3000);
  assert.equal(memState.getUserInChannelClearTime('c1', 'u1'), 0);
  assert.equal(memState.isOptedOut('u3'), true);
  assert.equal(memState.isOptedOut('u4'), false);

  const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'aiMemoryState.json'), 'utf8'));
  assert.deepEqual(raw, {
    userClears: { u1: 1000 }, channelClears: { c1: 2000 }, userInChannel: { 'c1:u2': 3000 }, optOut: { u3: true },
  });
});

test('aiMemoryState：預設呼叫用現在時間', () => {
  const before = Date.now();
  memState.clearUserMemory('u9');
  assert.ok(memState.getMemoryClearTime('u9') >= before);
});

test('aiMemoryState：壞資料被忽略', () => {
  fs.writeFileSync(path.join(TMP, 'aiMemoryState.json'), JSON.stringify({ userClears: { a: 'x', b: 5 }, optOut: { c: 1 } }));
  fs.rmSync(path.join(TMP, 'aiMemoryState.json.bak'), { force: true });
  memState._reset();
  assert.equal(memState.getMemoryClearTime('a'), 0);
  assert.equal(memState.getMemoryClearTime('b'), 5);
  assert.equal(memState.isOptedOut('c'), false);
});

test('aiMessageLog：紀錄重啟後仍有效（人格隔離不退化）', () => {
  msgLog.recordBotMessageContext('m1', 'loss', 'u1', 'ming');
  msgLog.recordBotMessageContext('m2', 'lover', 'u2', 'hua', { kind: 'single', scopeKey: 'g:1', askText: '  問題'.padEnd(400, '啊') });
  msgLog.recordBotMessageContext('m3', null, 'u1', 'ming'); // 沒有 mode 不記
  // extra 傳 null 或非物件不能拋錯，當成沒有額外欄位
  assert.doesNotThrow(() => msgLog.recordBotMessageContext('m4', 'loss', 'u1', 'ming', null));
  assert.doesNotThrow(() => msgLog.recordBotMessageContext('m5', 'loss', 'u1', 'ming', 'x'));

  msgLog._reset(); // 寫出並模擬重啟
  const m1 = msgLog.getBotMessageContext('m1');
  assert.equal(m1.mode, 'loss');
  assert.equal(m1.userId, 'u1');
  assert.equal(m1.userName, 'ming');
  assert.equal(m1.kind, undefined);   // 多人格的呼叫端不傳，維持原本的資料形狀
  assert.ok(Number.isFinite(m1.ts));

  assert.equal(msgLog.getBotMessageContext('m4').kind, undefined);
  assert.equal(msgLog.getBotMessageContext('m5').mode, 'loss');

  const m2 = msgLog.getBotMessageContext('m2');
  assert.equal(m2.kind, 'single');
  assert.equal(m2.scopeKey, 'g:1');
  assert.equal(m2.askText.length, msgLog.ASK_TEXT_MAX);
  assert.ok(m2.askText.startsWith('問題'));

  assert.equal(msgLog.getBotMessageContext('m3'), undefined);
  assert.equal(msgLog.getBotMessageContext('nope'), undefined);
  assert.equal(msgLog.getBotMessageContext(undefined), undefined);
});

test('aiMessageLog：載入時丟掉超過 7 天的紀錄與壞資料', () => {
  const now = Date.now();
  // _reset 會先寫出上一份記憶體內容，所以要在 _reset 之後才覆蓋檔案
  msgLog._reset();
  fs.writeFileSync(path.join(TMP, 'aiMessageLog.json'), JSON.stringify({
    old: { mode: 'loss', userId: 'u', userName: 'n', ts: now - msgLog.RETENTION_MS - 1000 },
    fresh: { mode: 'loss', userId: 'u', userName: 'n', ts: now - 1000 },
    bad: { userId: 'u' },
  }));
  fs.rmSync(path.join(TMP, 'aiMessageLog.json.bak'), { force: true });
  assert.equal(msgLog.getBotMessageContext('old'), undefined);
  assert.equal(msgLog.getBotMessageContext('bad'), undefined);
  assert.equal(msgLog.getBotMessageContext('fresh').mode, 'loss');
});

test('aiMessageLog：超過上限時淘汰最舊的', () => {
  for (let i = 0; i < msgLog.MAX_ENTRIES + 5; i++) {
    msgLog.recordBotMessageContext(`cap${i}`, 'loss', 'u', 'n');
  }
  assert.equal(msgLog.getBotMessageContext('cap0'), undefined);
  assert.equal(msgLog.getBotMessageContext('cap4'), undefined);
  assert.equal(msgLog.getBotMessageContext('cap5').mode, 'loss');
  msgLog._reset();
  const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'aiMessageLog.json'), 'utf8'));
  assert.equal(Object.keys(raw).length, msgLog.MAX_ENTRIES);
  assert.ok(raw[`cap${msgLog.MAX_ENTRIES + 4}`]);
});
