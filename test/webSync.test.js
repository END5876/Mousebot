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

test('autojoin：不是音樂指令建立的語音連線，網頁也看得到；點歌時由音樂播放接手', async () => {
  const { joinVoiceChannel } = require('@discordjs/voice');
  const AJ = '333333333333333333';
  const sent = [];
  const vc = {
    id: 'vc9', name: '常駐頻道', members: new Map(), isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (m) => { sent.push(m); return { delete: async () => {} }; },
  };
  const guild = { id: AJ, name: 'autojoin 伺服器', channels: { cache: new Map([['vc9', vc]]) }, members: { me: { voice: { channelId: 'vc9' } } } };
  // 接手連線時會掛上閒置監控（voiceActivityMonitor），它需要 client.user / client.on
  webSync._setClient({ user: { id: 'bot' }, on() {}, guilds: { cache: new Map([[GID, { name: '測試伺服器', channels: { cache: new Map() } }], [AJ, guild]]) } });
  // 跟 autojoinHandler 一樣直接 joinVoiceChannel（假的 adapter，不連網路）
  const conn = joinVoiceChannel({ channelId: 'vc9', guildId: AJ, adapterCreator: () => ({ sendPayload: () => true, destroy() {} }) });
  try {
    assert.equal(state.connections.has(AJ), false, '前提：音樂模組不知道這條連線');
    const g = webSync._buildState().guilds.find((x) => x.guildId === AJ);
    assert.ok(g, '網頁狀態包含 autojoin 的伺服器');
    assert.equal(g.voiceChannel, '常駐頻道');
    assert.equal(g.current, null);

    const prevLocal = state._engines.local;
    state._engines.local = { getMusicFiles: () => [{ filename: 'x.mp3', name: 'X' }] };
    state.nowPlaying.set(AJ, { player: fakePlayer(), item: lib('a.mp3') }); // 正在播：enqueue 只加入佇列，不會真的開始播放
    try {
      await webSync._execute({ guildId: AJ, action: 'enqueue', item: { kind: 'lib', filename: 'x.mp3' } });
      assert.equal(state.connections.get(AJ), conn, '音樂播放接手了 autojoin 的連線');
      assert.equal(require('../handlers/musicplayer/voiceActivityMonitor').isMonitoring(AJ), true, '並掛上閒置監控（同 /play）');
      await new Promise((r) => setImmediate(r));
      assert.ok(sent.some((m) => /網頁播放器/.test(m)), '沒有點歌頻道時，紀錄發在語音頻道的文字聊天');
    } finally {
      state._engines.local = prevLocal;
      for (const m of [state.queues, state.nowPlaying, state.connections]) m.delete(AJ);
      require('../handlers/musicplayer/voiceActivityMonitor').stopMonitoring(AJ);
    }
  } finally {
    conn.destroy();
    webSync._setClient({ guilds: { cache: new Map([[GID, { name: '測試伺服器', channels: { cache: new Map() } }]]) } });
  }
  assert.equal(webSync._buildState().guilds.some((x) => x.guildId === AJ), false, '連線銷毀後就不顯示');
});

test('離開語音頻道：autojoin 換新連線、被踢出、播放中被踢出，網頁看到的狀態都正確', async () => {
  const { joinVoiceChannel } = require('@discordjs/voice');
  const G = '444444444444444444';
  const me = { voice: { channelId: 'vcA' } }; // Discord 回報的 Bot 語音狀態
  const guild = { id: G, name: '踢人測試', members: { me }, channels: { cache: new Map([['vcA', { name: 'A 頻道', isTextBased: () => false }]]) } };
  webSync._setClient({ user: { id: 'bot' }, on() {}, guilds: { cache: new Map([[G, guild]]) } });
  const adapter = () => ({ sendPayload: () => true, destroy() {} });
  const find = () => webSync._buildState().guilds.find((g) => g.guildId === G);
  let conn2;
  try {
    // 1. autojoin 恢復連線：音樂播放的 connections 留著已銷毀的舊物件，@discordjs/voice 登記的是新的
    const old = joinVoiceChannel({ channelId: 'vcA', guildId: G, adapterCreator: adapter });
    state.connections.set(G, old);
    old.destroy(false);
    conn2 = joinVoiceChannel({ channelId: 'vcA', guildId: G, adapterCreator: adapter });
    const g1 = find();
    assert.ok(g1, '換新連線後仍顯示在語音頻道');
    assert.equal(g1.voiceChannel, 'A 頻道');
    assert.equal(g1.voice, 'connecting', '新連線還在建立中');
    assert.ok(conn2.listenerCount('stateChange') > 0, '監聽新連線的狀態變化（變化時立刻推送）');
    const prevLocal = state._engines.local;
    state._engines.local = { getMusicFiles: () => [{ filename: 'x.mp3', name: 'X' }] };
    state.nowPlaying.set(G, { player: fakePlayer(), item: lib('a.mp3') });
    try {
      await webSync._execute({ guildId: G, action: 'enqueue', item: { kind: 'lib', filename: 'x.mp3' } });
      assert.equal(state.connections.get(G), conn2, '點歌時音樂播放改接手新的連線，不再拿著舊物件');
    } finally {
      state._engines.local = prevLocal;
      require('../handlers/musicplayer/voiceActivityMonitor').stopMonitoring(G);
    }

    // 2. 播放中被踢出：Discord 回報已不在頻道，但連線物件還在（joinConfig.channelId 沒被清掉）
    me.voice.channelId = null;
    assert.equal(conn2.joinConfig.channelId, 'vcA', '前提：@discordjs/voice 不會清掉 channelId');
    const g2 = find();
    assert.ok(g2, '還在播放（音樂模組尚未停止）時仍列出');
    assert.equal(g2.voiceChannel, '', '但不顯示在任何頻道');
    await assert.rejects(webSync._execute({ guildId: G, action: 'enqueue', item: { kind: 'lib', filename: 'x.mp3' } }), /不在語音頻道/);

    // 3. 沒在播放又被踢出 → 不列出
    state.nowPlaying.delete(G); state.queues.delete(G);
    assert.equal(find(), undefined, '不在語音頻道、也沒在播放 → 網頁不顯示這個伺服器');
  } finally {
    for (const m of [state.queues, state.nowPlaying, state.connections]) m.delete(G);
    if (conn2) conn2.destroy();
    webSync._setClient({ guilds: { cache: new Map([[GID, { name: '測試伺服器', channels: { cache: new Map() } }]]) } });
  }
});

test('execute enqueueMany：一次加入多首、保持順序；next 整批插到最前面；找不到的略過；線上歌曲不跑 getInfo', async () => {
  const prevLocal = state._engines.local, prevOnline = state._engines.bilibili;
  state._engines.local = { getMusicFiles: () => [{ filename: 'x.mp3', name: 'X' }, { filename: 'y.mp3', name: 'Y' }] };
  state._engines.bilibili = { getInfo: () => { throw new Error('批量加入不應逐首呼叫 getInfo'); } };
  try {
    state.connections.set(GID, { joinConfig: { channelId: '1' } });
    state.nowPlaying.set(GID, { player: fakePlayer(), item: lib('a.mp3') });
    state.queues.set(GID, [lib('b.mp3')]);

    const msg = await webSync._execute({ guildId: GID, action: 'enqueueMany', skipped: 1, items: [
      { kind: 'lib', filename: 'x.mp3' },
      { kind: 'online', url: 'https://www.youtube.com/watch?v=abc', title: 'On', author: 'Au', duration: '3:05' },
      { kind: 'lib', filename: 'gone.mp3' },
      { kind: 'lib', filename: 'y.mp3' },
    ] });
    assert.match(msg, /已送出 3 首：加入佇列 3 首（略過 2 首找不到的歌）/);
    const q = state.queues.get(GID);
    assert.deepEqual(q.map((i) => i.filename || i.url), ['b.mp3', 'x.mp3', 'https://www.youtube.com/watch?v=abc', 'y.mp3']);
    assert.deepEqual(
      { type: q[2].type, title: q[2].title, author: q[2].author, duration: q[2].duration, durationSec: q[2].durationSec },
      { type: 'bilibili', title: 'On', author: 'Au', duration: '3:05', durationSec: 185 },
    );

    await webSync._execute({ guildId: GID, action: 'enqueueMany', next: true, items: [{ kind: 'lib', filename: 'y.mp3' }, { kind: 'lib', filename: 'x.mp3' }] });
    assert.deepEqual(state.queues.get(GID).slice(0, 3).map((i) => i.filename), ['y.mp3', 'x.mp3', 'b.mp3'], 'next：整批依原順序插在最前面');

    await assert.rejects(webSync._execute({ guildId: GID, action: 'enqueueMany', items: [{ kind: 'lib', filename: 'gone.mp3' }] }), /沒有這些歌/);
    state.connections.delete(GID);
    await assert.rejects(webSync._execute({ guildId: GID, action: 'enqueueMany', items: [{ kind: 'lib', filename: 'x.mp3' }] }), /不在語音頻道/);
  } finally {
    state._engines.local = prevLocal;
    state._engines.bilibili = prevOnline;
  }
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
