'use strict';

// 設定備份與還原（admin/backup.js）：產生、預覽、暫存、啟動時套用。
// 這個檔案在 Mousebot 與 mousebot-lite 完全相同；資料目錄指到暫存資料夾。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-backup-'));
process.env.MOUSEBOT_DATA_DIR = TMP;
process.env.LOG_LEVEL = 'error';

const { createBackupTools, applyPendingRestore, BackupError } = require('../admin/backup');

const tools = createBackupTools({
  app: 'unit-test',
  settingsFiles: ['a.json', 'b.json'],
  statsFiles: ['stats.json'],
  sharedPrompts: ['_general'],
});

const write = (rel, content) => {
  fs.mkdirSync(path.dirname(path.join(TMP, rel)), { recursive: true });
  fs.writeFileSync(path.join(TMP, rel), content);
};
const read = (rel) => fs.readFileSync(path.join(TMP, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(TMP, rel));

test.beforeEach(() => {
  for (const f of fs.readdirSync(TMP)) fs.rmSync(path.join(TMP, f), { recursive: true, force: true });
  write('a.json', JSON.stringify({ x: 1 }));
  write('stats.json', JSON.stringify({ n: 5 }));
  write('prompts/_general.md', '共用規則');
  write('prompts/modes/cat.md', '---\nname: 貓\n---\n喵');
  write('secret.json', JSON.stringify({ token: 'nope' }));
});

test('backup：只備份清單裡的檔案，統計資料要勾選才包含，人格檔一併備份', () => {
  const b = tools.build(false);
  assert.equal(b.app, 'unit-test');
  assert.deepEqual(Object.keys(b.files).sort(), ['a.json', 'prompts/_general.md', 'prompts/modes/cat.md']);
  assert.deepEqual(b.files['a.json'], { x: 1 });
  assert.ok('stats.json' in tools.build(true).files);
});

test('backup：預覽比對新增／變更／相同，略過不在清單裡或路徑可疑的檔案', () => {
  const b = tools.build(true);
  b.files['a.json'] = { x: 2 };
  b.files['b.json'] = { y: 1 };
  b.files['secret.json'] = { token: 'evil' };
  b.files['../outside.json'] = {};
  b.files['prompts/modes/../../x.md'] = 'x';
  b.files['prompts/modes/dog.md'] = '汪';
  const p = tools.preview(b);
  const status = Object.fromEntries(p.files.map((f) => [f.path, f.status]));
  assert.deepEqual(status, {
    'a.json': 'changed', 'b.json': 'new', 'stats.json': 'same',
    'prompts/_general.md': 'same', 'prompts/modes/cat.md': 'same', 'prompts/modes/dog.md': 'new',
  });
  assert.deepEqual(p.skipped.map((s) => s.path).sort(), ['../outside.json', 'prompts/modes/../../x.md', 'secret.json']);
});

test('backup：別隻 Bot 的備份、格式錯誤、內容相同時都拒絕', () => {
  assert.throws(() => tools.preview({ ...tools.build(false), app: 'other' }), BackupError);
  assert.throws(() => tools.preview({ files: {} }), BackupError);
  assert.throws(() => tools.preview([]), BackupError);
  assert.throws(() => tools.stage(tools.build(false)), /完全相同/);
});

test('backup：暫存時不動到現在的檔案；啟動時先做快照再套用，暫存區清掉', () => {
  const b = tools.build(false);
  b.files['a.json'] = { x: 99 };
  b.files['b.json'] = { y: 1 };
  b.files['prompts/_general.md'] = '新的規則';
  const r = tools.stage(b);
  assert.equal(r.staged, 3);
  assert.equal(r.unchanged, 1);
  assert.deepEqual(JSON.parse(read('a.json')), { x: 1 }); // 還沒套用

  assert.equal(applyPendingRestore(), 3);
  assert.deepEqual(JSON.parse(read('a.json')), { x: 99 });
  assert.deepEqual(JSON.parse(read('b.json')), { y: 1 });
  assert.equal(read('prompts/_general.md'), '新的規則');
  assert.equal(read('prompts/modes/cat.md'), '---\nname: 貓\n---\n喵'); // 備份裡沒變的不動
  assert.ok(!exists('.restore-pending'));

  const [snap] = fs.readdirSync(path.join(TMP, 'backups'));
  assert.match(snap, /^restore-\d{8}-\d{6}$/);
  assert.deepEqual(JSON.parse(read(`backups/${snap}/a.json`)), { x: 1 }); // 還原前的內容
  assert.equal(read(`backups/${snap}/prompts/_general.md`), '共用規則');
  assert.ok(!exists(`backups/${snap}/b.json`)); // 原本沒有的檔案不用快照

  assert.equal(applyPendingRestore(), 0); // 套用一次就結束
});

test('backup：沒有 manifest 的暫存（寫到一半被中斷）啟動時直接清掉，不套用', () => {
  write('.restore-pending/files/a.json', JSON.stringify({ x: 'half' }));
  assert.equal(applyPendingRestore(), 0);
  assert.deepEqual(JSON.parse(read('a.json')), { x: 1 });
  assert.ok(!exists('.restore-pending'));
});

test('backup：備份時就損毀的 JSON（原始文字）能解析才還原', () => {
  const b = tools.build(false);
  b.files['a.json'] = '{"x": 7}';
  b.files['b.json'] = 'not json';
  const p = tools.preview(b);
  assert.equal(p.files.find((f) => f.path === 'a.json').status, 'changed');
  assert.ok(p.skipped.some((s) => s.path === 'b.json'));
});
