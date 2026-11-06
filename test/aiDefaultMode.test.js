'use strict';

// 預設人格（AI_DEFAULT_MODE）：合法時用它，不合法或沒設定時用 default。
// aiSettings 的常數在載入時就固定了，所以每個 env 情境都在獨立的子程序裡跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = `
const { DEFAULT_MODE, DEFAULT_MODE_INVALID } = require('./handlers/ai/aiSettings');
const { selectMode } = require('./handlers/ai/modeSelector');
process.stdout.write(JSON.stringify({ DEFAULT_MODE, DEFAULT_MODE_INVALID, selected: selectMode('900000000000000099') }));
process.exit(0);
`;

function run(value) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-defmode-'));
  try {
    fs.mkdirSync(path.join(tmp, 'prompts', 'modes'), { recursive: true });
    for (const key of ['default', 'chat']) {
      fs.writeFileSync(path.join(tmp, 'prompts', 'modes', `${key}.md`), `---\nname: ${key}\n---\n${key.toUpperCase()}`);
    }
    const env = { ...process.env, MOUSEBOT_DATA_DIR: tmp, LOG_LEVEL: 'error' };
    delete env.AI_DEFAULT_MODE;
    delete env.AI_USER_MODE_OVERRIDES;
    if (value !== undefined) env.AI_DEFAULT_MODE = value;
    const res = spawnSync(process.execPath, ['-e', SCRIPT], {
      cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(res.status, 0, `子程序失敗：\n${res.stderr}`);
    return JSON.parse(res.stdout);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('AI_DEFAULT_MODE=chat：預設人格是 chat，沒選人格的人用 chat', () => {
  assert.deepEqual(run('chat'), { DEFAULT_MODE: 'chat', DEFAULT_MODE_INVALID: null, selected: 'chat' });
});

test('AI_DEFAULT_MODE 前後空白會去掉', () => {
  assert.equal(run('  chat ').DEFAULT_MODE, 'chat');
});

test('AI_DEFAULT_MODE 不合法：改用 default，並記下原字串給開機摘要警告', () => {
  assert.deepEqual(run('bad key!'), { DEFAULT_MODE: 'default', DEFAULT_MODE_INVALID: 'bad key!', selected: 'default' });
});

test('沒設定 AI_DEFAULT_MODE（或空白）：預設人格是 default', () => {
  assert.deepEqual(run(undefined), { DEFAULT_MODE: 'default', DEFAULT_MODE_INVALID: null, selected: 'default' });
  assert.deepEqual(run('   '), { DEFAULT_MODE: 'default', DEFAULT_MODE_INVALID: null, selected: 'default' });
});

test('開機摘要：預設人格不合法／不存在、固定人格有錯時顯示 warn，只列模式代號不印使用者 ID', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-defmode-boot-'));
  try {
    fs.mkdirSync(path.join(tmp, 'prompts', 'modes'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'prompts', 'modes', 'special.md'), '---\nname: 特別\n---\nSPECIAL');
    const env = {
      ...process.env, MOUSEBOT_DATA_DIR: tmp, LOG_LEVEL: 'error', GEMINI_API_KEY: 'x', GROQ_API_KEY: 'x',
      AI_DEFAULT_MODE: 'bad key!',
      AI_USER_MODE_OVERRIDES: '123456789012345678:special,123456789012345679:gone,oops,123456789012345678:special',
    };
    const script = `
const bootSummary = require('./utils/bootSummary');
require('./handlers/ai/aiHandler').setupAICommands({ commands: new Map(), on() {} });
process.stdout.write(JSON.stringify(bootSummary.getItems().find((i) => i.name === 'AI 對話 (/ai)')));
process.exit(0);
`;
    const res = spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(res.status, 0, `子程序失敗：\n${res.stderr}`);
    const item = JSON.parse(res.stdout);
    assert.equal(item.status, 'warn');
    for (const text of [
      'AI_DEFAULT_MODE=bad key! 不合法，改用 default',
      '預設人格 data/prompts/modes/default.md 不存在',
      'AI_USER_MODE_OVERRIDES 有 1 筆格式錯誤',
      'AI_USER_MODE_OVERRIDES 有 1 筆重複的使用者',
      '固定人格 gone 不存在，那些人改用 default',
    ]) assert.ok(item.detail.includes(text), `缺少「${text}」：${item.detail}`);
    assert.ok(!/\d{17,20}/.test(item.detail), '不應印出使用者 ID');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
