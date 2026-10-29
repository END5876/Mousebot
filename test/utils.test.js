'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readJson, writeJsonAtomic, createDebouncedWriter } = require('../utils/jsonStore');
const { hashCommands, stableStringify } = require('../utils/commandSync');
const { SlidingWindowRateLimiter } = require('../utils/rateLimiter');
const { splitSentences } = require('../handlers/voice/ttsHandler/textSplitter');
const { cleanUrl, _isYouTubeWithoutList, _formatDuration, _resolveEntryUrl } =
  require('../handlers/musicplayer/unifiedQueue/search/urlUtils');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-test-'));
}

// ── jsonStore ─────────────────────────────────────────────
test('jsonStore：寫入後可讀回，且保留 .bak', () => {
  const file = path.join(tmpDir(), 'nested', 'a.json');
  assert.deepEqual(readJson(file, { empty: true }), { empty: true });

  writeJsonAtomic(file, { v: 1 });
  assert.deepEqual(readJson(file, null), { v: 1 });
  assert.equal(fs.existsSync(`${file}.bak`), false);

  writeJsonAtomic(file, { v: 2 });
  assert.deepEqual(readJson(file, null), { v: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf-8')), { v: 1 });

  const leftovers = fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('jsonStore：主檔損毀時改讀 .bak；兩者都壞才用 fallback', () => {
  const file = path.join(tmpDir(), 'b.json');
  writeJsonAtomic(file, { v: 1 });
  writeJsonAtomic(file, { v: 2 });
  fs.writeFileSync(file, '{"v": 2, "trunc');
  assert.deepEqual(readJson(file, null), { v: 1 });

  fs.writeFileSync(`${file}.bak`, 'garbage');
  assert.deepEqual(readJson(file, 'fallback'), 'fallback');
});

test('jsonStore：主檔損毀時寫入不會用它蓋掉 .bak', () => {
  const file = path.join(tmpDir(), 'b2.json');
  writeJsonAtomic(file, { v: 1 });
  writeJsonAtomic(file, { v: 2 });
  fs.writeFileSync(file, '{"v": 2, "trunc');
  writeJsonAtomic(file, { v: 3 });
  assert.deepEqual(readJson(file, null), { v: 3 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf-8')), { v: 1 });
});

test('jsonStore：主檔不存在但有 .bak 時從備份還原', () => {
  const file = path.join(tmpDir(), 'c.json');
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ restored: true }));
  assert.deepEqual(readJson(file, null), { restored: true });
});

test('jsonStore：debounced writer 合併多次寫入，flush 立即寫出', async () => {
  const file = path.join(tmpDir(), 'd.json');
  let n = 0;
  const writer = createDebouncedWriter(file, () => ({ n }), { debounceMs: 30 });
  n = 1; writer.schedule();
  n = 2; writer.schedule();
  assert.equal(fs.existsSync(file), false);
  await new Promise(r => setTimeout(r, 80));
  assert.deepEqual(readJson(file, null), { n: 2 });

  n = 3; writer.schedule(); writer.flush();
  assert.deepEqual(readJson(file, null), { n: 3 });
});

// ── commandSync ───────────────────────────────────────────
test('commandSync：hash 不受 key 順序與指令順序影響，內容變動才改變', () => {
  const a = [{ name: 'ping', description: 'x', options: [] }, { name: 'ai', type: 1 }];
  const b = [{ type: 1, name: 'ai' }, { options: [], description: 'x', name: 'ping' }];
  assert.equal(hashCommands(a), hashCommands(b));
  assert.notEqual(hashCommands(a), hashCommands([{ ...a[0], description: 'y' }, a[1]]));
  assert.equal(stableStringify({ b: 1, a: [1, { d: 2, c: undefined }] }), '{"a":[1,{"d":2}],"b":1}');
});

// ── rateLimiter ───────────────────────────────────────────
test('rateLimiter：視窗內超過上限即拒絕，被拒的不佔名額', () => {
  const limiter = new SlidingWindowRateLimiter(2, 60_000);
  assert.equal(limiter.check('u').allowed, true);
  assert.equal(limiter.check('u').allowed, true);
  const third = limiter.check('u');
  assert.equal(third.allowed, false);
  assert.ok(third.retryAfterMs > 0 && third.retryAfterMs <= 60_000);
  assert.equal(limiter.hits.get('u').length, 2);
  assert.equal(limiter.check('other').allowed, true);
});

// ── TTS 分句 ──────────────────────────────────────────────
test('splitSentences：依句號切割、長句再細分、純標點併回前句', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('你好。今天天氣很好！要出門嗎？'), ['你好。', '今天天氣很好！', '要出門嗎？']);
  assert.deepEqual(splitSentences('好耶！！！'), ['好耶！！！']);

  const long = '第一段文字比較長，第二段文字也很長，第三段文字一樣很長，第四段文字還是很長';
  const parts = splitSentences(long, 20);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(p => p.length <= 20));
  assert.equal(parts.join(''), long);
});

// ── 音樂網址工具 ──────────────────────────────────────────
test('cleanUrl：移除 YouTube 播放清單參數、Bilibili 只保留分 P', () => {
  assert.equal(
    cleanUrl('https://www.youtube.com/watch?v=abc&list=PL1&index=3&feature=share'),
    'https://www.youtube.com/watch?v=abc'
  );
  assert.equal(
    cleanUrl('https://www.bilibili.com/video/BV1xx?p=2&spm_id_from=333'),
    'https://www.bilibili.com/video/BV1xx?p=2'
  );
  assert.equal(cleanUrl('not a url'), 'not a url');
});

test('_isYouTubeWithoutList / _formatDuration / _resolveEntryUrl', () => {
  assert.equal(_isYouTubeWithoutList('https://youtu.be/abc'), true);
  assert.equal(_isYouTubeWithoutList('https://music.youtube.com/watch?v=a&list=RD'), false);
  assert.equal(_isYouTubeWithoutList('https://www.bilibili.com/video/BV1'), false);

  assert.equal(_formatDuration(0), '未知');
  assert.equal(_formatDuration(65), '1:05');
  assert.equal(_formatDuration(3725), '1:02:05');

  assert.equal(_resolveEntryUrl('base', { id: 'xyz' }), 'https://www.youtube.com/watch?v=xyz');
  assert.equal(_resolveEntryUrl('base', { url: 'https://a.b/c' }), 'https://a.b/c');
  assert.equal(_resolveEntryUrl('base', {}), 'base');
});
