'use strict';
process.env.LOG_LEVEL ??= 'error';
// yt-dlp 下載流程（不連線）：用假的 yt-dlp（spawn 換掉）與真的 ffmpeg。
// fixtures/ytdlp-cases.json 在 Mousebot 與 music-library-service 各有一份、內容相同：
// 兩邊的快取檔名必須一致，快取才會互相命中。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const cp = require('child_process');

const realSpawn = cp.spawn;
let fakeYtdlp = null;
cp.spawn = (cmd, args, opts) => (cmd === 'yt-dlp' && fakeYtdlp ? fakeYtdlp(args) : realSpawn(cmd, args, opts));

const antiBot = require('../handlers/musicplayer/musicAntiBot');
const cache = require('../handlers/musicplayer/musicCache');
const normalizer = require('../handlers/musicplayer/musicNormalizer');
const cases = require('./fixtures/ytdlp-cases.json');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-flow-'));
const hasFfmpeg = cp.spawnSync('ffmpeg', ['-version']).status === 0;
test.after(() => {
  cp.spawn = realSpawn;
  fs.rmSync(DIR, { recursive: true, force: true });
});

function makeRaw(file, extra = []) {
  const r = cp.spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'aevalsrc=0.3*random(0)|0.3*random(1):d=4', ...extra, '-f', 'matroska', '-c:a', 'libopus', file]);
  assert.equal(r.status, 0, String(r.stderr));
}

test('兩邊共用案例：快取檔名', () => {
  for (const c of cases.filenames) assert.equal(cache.getCacheFilename(c.url, c.title), c.filename);
});

test('兩邊共用案例：錯誤分類', () => {
  for (const c of cases.errors) {
    if (c.kind === 'youtube') assert.equal(antiBot.classifyYouTubeError(c.output).type, c.expect, c.output);
    else assert.ok(antiBot.classifyBilibiliError(c.output).msg.includes(c.expect), c.output);
  }
});

test('下載只抓原始音訊，不叫 yt-dlp 轉檔；處理網址的都排除 generic extractor', () => {
  const yt = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const bi = 'https://www.bilibili.com/video/BV1xx411c7mD';
  for (const args of [antiBot.buildYouTubeArgs(yt, antiBot.YT_CLIENT_STRATEGIES[0], false), antiBot.buildBilibiliArgs(bi, false)]) {
    assert.ok(!args.includes('--extract-audio'));
  }
  for (const args of [
    antiBot.buildYouTubeArgs(yt, antiBot.YT_CLIENT_STRATEGIES[0], true), antiBot.buildBilibiliArgs(bi, true),
    antiBot.buildInfoArgs(yt), antiBot.buildInfoArgs(bi),
  ]) assert.ok(args.includes('default,-generic'));
  for (const args of [antiBot.buildPlaylistCheckArgs(yt)]) assert.ok(args.includes('default,-generic'));
  // b23.tv 短網址要靠 generic 跟著轉址
  assert.ok(!antiBot.buildInfoArgs('https://b23.tv/abc').includes('--use-extractors'));
});

test('編碼：標題含大括號也能正規化，品質不是預設的 128 kbps', { skip: !hasFfmpeg }, async () => {
  const raw = path.join(DIR, 'raw.tmp');
  const out = path.join(DIR, 'out.tmp.mp3');
  makeRaw(raw, ['-metadata', 'title=a {b} c']);
  assert.deepEqual(await normalizer.encodeNormalizedMp3(raw, out), { normalized: true });
  const p = cp.spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,bit_rate', '-of', 'json', out]);
  const s = JSON.parse(p.stdout).streams[0];
  assert.equal(s.codec_name, 'mp3');
  assert.ok(Number(s.bit_rate) > 135_000, `bit_rate=${s.bit_rate}`);
});

test('編碼：內容其實是播放清單的檔案會被拒絕', { skip: !hasFfmpeg }, async () => {
  const raw = path.join(DIR, 'inner.mkv');
  makeRaw(raw);
  const evil = path.join(DIR, 'evil.tmp');
  fs.writeFileSync(evil, `ffconcat version 1.0\nfile inner.mkv\n`);
  await assert.rejects(normalizer.encodeNormalizedMp3(evil, path.join(DIR, 'evil.tmp.mp3')));
});

test('downloadAndCache：讀 stdout 進度、% 會跳脫、只留下成品', { skip: !hasFfmpeg }, async () => {
  const title = `flow-test ${process.pid} 100%(id)s`;
  const url = 'https://youtu.be/dQw4w9WgXcQ';
  const progress = [];
  let outArg;
  fakeYtdlp = (args) => {
    const p = new EventEmitter();
    Object.assign(p, { stdout: new PassThrough(), stderr: new PassThrough(), kill() {}, exitCode: null, signalCode: null });
    outArg = args[args.indexOf('-o') + 1];
    setImmediate(() => {
      p.stdout.write('[download]  50.0% of 1MiB\n');
      makeRaw(outArg.replace(/%%/g, '%'));
      setImmediate(() => p.emit('close', 0));
    });
    return p;
  };
  let file;
  try {
    file = await cache.downloadAndCache(url, title, ['-o', '__OUTPUT__', url], (n) => progress.push(n));
    assert.deepEqual(progress, [50]);
    assert.ok(outArg.includes('100%%(id)s'));
    assert.equal(path.basename(file), cache.getCacheFilename(url, title));
    const left = fs.readdirSync(cache.CACHE_DIR).filter((f) => f.includes(`flow-test ${process.pid}`));
    assert.deepEqual(left, [path.basename(file)], '沒有殘留暫存檔');
  } finally {
    fakeYtdlp = null;
    if (file) fs.rmSync(file, { force: true });
  }
});

test('downloadAndCache：卡住時逾時並終止 yt-dlp', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let killed = null;
  fakeYtdlp = () => {
    const p = new EventEmitter();
    Object.assign(p, {
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
      kill(sig) { killed = sig; setImmediate(() => p.emit('close', null)); },
    });
    return p;
  };
  try {
    const p = cache.downloadAndCache('https://youtu.be/dQw4w9WgXcQ', 'stuck', ['-o', '__OUTPUT__']);
    const r = assert.rejects(p);
    t.mock.timers.tick(15 * 60 * 1000);
    await r;
    assert.equal(killed, 'SIGKILL');
  } finally { fakeYtdlp = null; }
});
