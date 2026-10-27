'use strict';

// 預先下載：佇列中的線上歌曲在目前這首播放時先下載（不連線：快取模組與引擎都用假的）
const test = require('node:test');
const assert = require('node:assert/strict');

const cache = require('../handlers/musicplayer/musicCache');
const online = require('../handlers/musicplayer/onlineMusicHandler');
const state = require('../handlers/musicplayer/unifiedQueue/state');
const playback = require('../handlers/musicplayer/unifiedQueue/playback');

const GID = '222222222222222222';
const yt = (id, durationSec = 200) => ({
  type: 'bilibili', url: `https://www.youtube.com/watch?v=${id}`, title: `T-${id}`, durationSec,
});
const lib = (filename) => ({ type: 'local', filename, name: filename, title: filename });
const tick = () => new Promise((r) => setImmediate(r));

// 假的 downloadAndCache：記錄呼叫，由測試決定何時完成
let downloads, cached;
const orig = { ...cache };
test.beforeEach(() => {
  downloads = [];
  cached = new Set();
  cache.getCachedPath = async (url) => (cached.has(url) ? `/fake/${url}` : null);
  cache.pushToSharedLibrary = async () => true;
  cache.downloadAndCache = (url) => new Promise((resolve, reject) => {
    downloads.push({ url, resolve: () => resolve(`/fake/${url}.mp3`), reject });
  });
});
test.afterEach(async () => {
  for (const d of downloads) d.resolve();
  await tick(); await tick();
  Object.assign(cache, orig);
  for (const m of [state.queues, state.nowPlaying]) m.delete(GID);
  state._engines.bilibili = null;
});

test('prefetch：太長、未知長度、不支援的網址不下載', async () => {
  assert.equal(online.prefetch(yt('long', 7 * 60 + 1)), false);
  assert.equal(online.prefetch(yt('live', 0)), false);
  assert.equal(online.prefetch({ ...yt('x'), url: 'https://example.com/a.mp3' }), false);
  await tick();
  assert.equal(downloads.length, 0);
});

test('prefetch：一次只下載一首，前一首完成才換下一首；重複的網址不排第二次', async () => {
  assert.equal(online.prefetch(yt('a1')), true);
  assert.equal(online.prefetch(yt('b1')), true);
  assert.equal(online.prefetch(yt('a1')), false);
  await tick();
  assert.deepEqual(downloads.map((d) => d.url), [yt('a1').url]);

  downloads[0].resolve();
  await tick(); await tick(); await tick();
  assert.deepEqual(downloads.map((d) => d.url), [yt('a1').url, yt('b1').url]);
});

test('prefetch：已有快取、或輪到時已不需要（被移出佇列）就不下載', async () => {
  cached.add(yt('c1').url);
  online.prefetch(yt('c1'));
  online.prefetch(yt('d1'), { isWanted: () => false });
  await tick(); await tick(); await tick();
  assert.equal(downloads.length, 0);
});

test('prefetchUpcoming：只預先下載佇列最前面兩首裡的線上歌曲；佇列清空後就不再需要', () => {
  const calls = [];
  state.registerEngine('bilibili', { prefetch: (item, opts) => { calls.push({ item, opts }); return true; } });

  state.queues.set(GID, [yt('q1'), lib('a.mp3'), yt('q3')]);
  playback.prefetchUpcoming(GID);
  assert.equal(calls.length, 0, '沒在播放時不預先下載');

  state.nowPlaying.set(GID, { player: {}, item: yt('now') });
  playback.prefetchUpcoming(GID);
  assert.deepEqual(calls.map((c) => c.item.url), [yt('q1').url]);
  assert.equal(calls[0].opts.isWanted(), true);

  state.queues.set(GID, []);
  assert.equal(calls[0].opts.isWanted(), false);
});
