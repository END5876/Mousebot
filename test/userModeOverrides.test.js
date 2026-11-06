'use strict';

// AI_USER_MODE_OVERRIDES（使用者ID:模式代號,…）：解析規則，與 selectMode 的優先順序
// （/ai mode 動態覆蓋 > 固定人格 > 預設）。資料目錄用 MOUSEBOT_DATA_DIR 指到暫存資料夾。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXED = '900000000000000001';
const MISSING = '900000000000000002';   // 固定人格的模式檔不存在
const DYNAMIC = '900000000000000003';   // 固定人格之外又用 /ai mode 指定
const PLAIN = '900000000000000099';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-overrides-'));
fs.mkdirSync(path.join(TMP, 'prompts', 'modes'), { recursive: true });
for (const key of ['default', 'special', 'chat']) {
  fs.writeFileSync(path.join(TMP, 'prompts', 'modes', `${key}.md`), `---\nname: ${key}\n---\n${key}`);
}
delete process.env.AI_DEFAULT_MODE;
Object.assign(process.env, {
  MOUSEBOT_DATA_DIR: TMP,
  LOG_LEVEL: 'error',
  AI_USER_MODE_OVERRIDES: `${FIXED}:special, ${MISSING}:gone ,${DYNAMIC}:special`,
});

const { parseUserModeOverrides, USER_MODE_OVERRIDES, USER_MODE_OVERRIDE_ERRORS, DEFAULT_MODE } = require('../handlers/ai/aiSettings');
const modeSelector = require('../handlers/ai/modeSelector');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  // promptStore 會掛定期檢查檔案的計時器；等測試框架寫完結果後再主動結束（同 aiPersonaScope.test.js）
  setTimeout(() => process.exit(), 500).unref();
});

test('parse：合法項目去掉空白，空項目略過', () => {
  const r = parseUserModeOverrides(' 123456789012345678:a , 223456789012345678:b ,,');
  assert.deepEqual({ ...r.map }, { '123456789012345678': 'a', '223456789012345678': 'b' });
  assert.deepEqual(r.invalid, []);
  assert.deepEqual(r.duplicates, []);
  assert.ok(Object.isFrozen(r.map));
});

test('parse：沒設定或空字串時是空的', () => {
  for (const raw of [undefined, null, '', '  ,  ']) {
    const r = parseUserModeOverrides(raw);
    assert.deepEqual({ ...r.map }, {});
    assert.deepEqual(r.invalid, []);
    assert.deepEqual(r.duplicates, []);
  }
});

test('parse：格式錯誤的項目放進 invalid（保留原字串），其他照常解析', () => {
  const r = parseUserModeOverrides('123456789012345678,abc:chat,123:chat,123456789012345678:bad mode,123456789012345678:,323456789012345678:ok');
  assert.deepEqual({ ...r.map }, { '323456789012345678': 'ok' });
  assert.deepEqual(r.invalid, [
    '123456789012345678', 'abc:chat', '123:chat', '123456789012345678:bad mode', '123456789012345678:',
  ]);
});

test('parse：只依第一個冒號切開', () => {
  const r = parseUserModeOverrides('123456789012345678:a:b');
  assert.deepEqual({ ...r.map }, {});
  assert.deepEqual(r.invalid, ['123456789012345678:a:b']); // 模式代號不能有冒號
});

test('parse：同一個 id 出現兩次以後面的為準，並記到 duplicates', () => {
  const r = parseUserModeOverrides('123456789012345678:a,123456789012345678:b');
  assert.deepEqual({ ...r.map }, { '123456789012345678': 'b' });
  assert.deepEqual(r.duplicates, ['123456789012345678']);
});

test('載入時解析 AI_USER_MODE_OVERRIDES', () => {
  assert.deepEqual({ ...USER_MODE_OVERRIDES }, { [FIXED]: 'special', [MISSING]: 'gone', [DYNAMIC]: 'special' });
  assert.deepEqual(USER_MODE_OVERRIDE_ERRORS, { invalid: [], duplicates: [] });
  assert.equal(DEFAULT_MODE, 'default');
});

test('selectMode：固定使用者用固定人格', () => {
  assert.equal(modeSelector.selectMode(FIXED), 'special');
});

test('selectMode：/ai mode 的動態覆蓋優先於固定人格', () => {
  modeSelector.setUserMode(DYNAMIC, 'chat');
  try {
    assert.equal(modeSelector.selectMode(DYNAMIC), 'chat');
  } finally {
    modeSelector.setUserMode(DYNAMIC, null);
  }
  assert.equal(modeSelector.selectMode(DYNAMIC), 'special');
});

test('selectMode：固定人格的模式檔不存在時用預設人格', () => {
  assert.equal(modeSelector.selectMode(MISSING), DEFAULT_MODE);
  assert.equal(modeSelector.selectMode(MISSING), DEFAULT_MODE); // 第二次也一樣（只警告一次）
});

test('selectMode：一般使用者用預設人格', () => {
  assert.equal(modeSelector.selectMode(PLAIN), DEFAULT_MODE);
});

test('listFixedUserModes 回傳複本，改了不影響設定', () => {
  const list = modeSelector.listFixedUserModes();
  assert.deepEqual(list, { [FIXED]: 'special', [MISSING]: 'gone', [DYNAMIC]: 'special' });
  list[FIXED] = 'chat';
  assert.equal(modeSelector.listFixedUserModes()[FIXED], 'special');
});
