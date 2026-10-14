'use strict';

// webSync：曲目格式轉換與網頁指令的執行邏輯（不連線：用假的 Discord client、播放器與引擎）
const test = require('node:test');
const assert = require('node:assert/strict');

const webSync = require('../handlers/musicplayer/unifiedQueue/webSync');
const state = require('../handlers/musicplayer/unifiedQueue/state');

const GID = '111111111111111111';
webSync._setClient({
  guilds: { cache: new Map([[GID, { name: '測試伺服器', channels: { cache: new Map() } }]]) },
});

function fakePlayer() {
  return { stopped: 0, stop() { this.stopped++; }, state: { status: 'playing' } };
}
const lib = (filename) => ({ type: 'local', filename, name: filename, title: filename });

test.afterEach(() => {
  for (const m of [state.queues, state.nowPlaying, state.loopSettings, state.randomPlaySettings, state.connections]) m.delete(GID);
});

test('toWebItem：本地與線上曲目轉成網頁格式', () => {
  assert.deepEqual(webSync._toWebItem(lib('fav/a.mp3')), { kind: 'lib', filename: 'fav/a.mp3', title: 'fav/a.mp3' });
  assert.deepEqual(webSync._toWebItem({
    type: 'bilibili', url: 'https://www.youtube.com/watch?v=x', title: 'T', author: 'A', duration: '3:00', durationSec: 180, thumbnail: 'x',
  }), { kind: 'online', url: 'https://www.youtube.com/watch?v=x', title: 'T', author: 'A', platform: 'YouTube', duration: '3:00', durationSec: 180 });
  assert.equal(webSync._toWebItem({ type: 'bilibili', url: 'https://www.bilibili.com/video/BV1' }).platform, 'Bilibili');
  assert.equal(webSync._toWebItem(null), null);
});

test('execute：Bot 不在的伺服器、沒在播放時的控制，回明確的錯誤', async () => {
  await assert.rejects(webSync._execute({ guildId: '999', action: 'skip' }), /不在這個伺服器/);
  await assert.rejects(webSync._execute({ guildId: GID, action: 'skip' }), /沒有播放/);
  await assert.rejects(webSync._execute({ guildId: GID, action: 'enqueue', item: { kind: 'lib', filename: 'a.mp3' } }), /不在語音頻道/);
});

test('execute skip：隨機連播 → 只停目前這首（Idle 會挑下一首）；有佇列 → 停目前這首', async () => {
  const player = fakePlayer();
  state.nowPlaying.set(GID, { player, item: lib('a.mp3') });
  state.randomPlaySettings.set(GID, true);
  assert.match(await webSync._execute({ guildId: GID, action: 'skip' }), /隨機連播/);
  assert.equal(player.stopped, 1);

  state.randomPlaySettings.set(GID, false);
  state.queues.set(GID, [lib('b.mp3')]);
  assert.equal(await webSync._execute({ guildId: GID, action: 'skip' }), '已跳過');
  assert.equal(player.stopped, 2);
});

test('execute loop / randomPlay：兩者互斥', async () => {
  state.nowPlaying.set(GID, { player: fakePlayer(), item: lib('a.mp3') });
  state.randomPlaySettings.set(GID, true);
  await webSync._execute({ guildId: GID, action: 'loop', mode: 'one' });
  assert.equal(state.loopSettings.get(GID), 'one');
  assert.equal(state.randomPlaySettings.get(GID), false);

  await webSync._execute({ guildId: GID, action: 'randomPlay', on: true });
  assert.equal(state.randomPlaySettings.get(GID), true);
  assert.equal(state.loopSettings.get(GID), 'off');
});

test('execute removeQueue：位置對得上才移除，佇列已變動就拒絕', async () => {
  state.queues.set(GID, [lib('a.mp3'), lib('b.mp3')]);
  await assert.rejects(webSync._execute({ guildId: GID, action: 'removeQueue', index: 0, key: 'lib:b.mp3' }), /已經變動/);
  assert.match(await webSync._execute({ guildId: GID, action: 'removeQueue', index: 1, key: 'lib:b.mp3' }), /已移除/);
  assert.deepEqual(state.queues.get(GID).map((i) => i.filename), ['a.mp3']);
  await assert.rejects(webSync._execute({ guildId: GID, action: 'removeQueue', index: 5 }), /已經變動/);
});

test('execute clearQueue', async () => {
  await assert.rejects(webSync._execute({ guildId: GID, action: 'clearQueue' }), /已經是空的/);
  state.queues.set(GID, [lib('a.mp3'), lib('b.mp3')]);
  assert.match(await webSync._execute({ guildId: GID, action: 'clearQueue' }), /2 首/);
  assert.deepEqual(state.queues.get(GID), []);
});

test('execute enqueue：播放中 → 加入佇列；next=true → 插到最前面', async () => {
  const prevLocal = state._engines.local;
  state._engines.local = { getMusicFiles: () => [{ filename: 'x.mp3', name: 'X' }, { filename: 'y.mp3', name: 'Y' }] };
  try {
    state.connections.set(GID, { joinConfig: { channelId: '1' } });
    state.nowPlaying.set(GID, { player: fakePlayer(), item: lib('a.mp3') });
    state.queues.set(GID, [lib('b.mp3')]);

    assert.match(await webSync._execute({ guildId: GID, action: 'enqueue', item: { kind: 'lib', filename: 'x.mp3' } }), /加入佇列（第 2 首）「X」/);
    assert.match(await webSync._execute({ guildId: GID, action: 'enqueue', item: { kind: 'lib', filename: 'y.mp3' }, next: true }), /下一首播放「Y」/);
    assert.deepEqual(state.queues.get(GID).map((i) => i.filename), ['y.mp3', 'b.mp3', 'x.mp3']);

    await assert.rejects(webSync._execute({ guildId: GID, action: 'enqueue', item: { kind: 'lib', filename: 'nope.mp3' } }), /還沒有這首歌/);
  } finally {
    state._engines.local = prevLocal;
  }
});
