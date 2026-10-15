'use strict';
// handlers/musicplayer/unifiedQueue/webSync.js
// ─────────────────────────────────────────────────────────────
// 把這台 Bot 的「正在播放」同步到共用音樂庫服務的網頁播放器，並接收網頁送來的控制指令。
//
// 連線方向只有「Bot → 共用音樂庫服務」（沿用 MUSIC_LIB_URL + MUSIC_LIB_SECRET），Bot 不必對外開 port：
//   - 推送狀態：PUT  /api/music/bots/:botId/state
//       播放 / 佇列 / 循環模式變動時（session.onChange，合併 300ms 內的變動），以及每 30 秒心跳一次
//   - 拿指令：  GET  /api/music/bots/:botId/commands?wait=25（長輪詢）
//   - 回報結果：POST /api/music/bots/:botId/commands/:id/result { ok, message }
//   - 通知下線：DELETE /api/music/bots/:botId/state（關閉前；重啟後第一次推送狀態就自動恢復在線）
//   協定細節見 music-library-service 的 botSync/routes.js。
//
// 網頁可以做的事（都只限 Bot 目前在語音頻道裡的伺服器）：
//   skip / stop / loop{mode} / randomPlay{on} / clearQueue / removeQueue{index,key} / enqueue{item,next}
//   enqueueMany{items,next,skipped}：一次加入多首（網頁的多選、整份播放清單）。線上歌曲直接用網頁帶來的
//     標題／作者／長度，不逐首跑 yt-dlp（同 /play 匯入播放清單：避免短時間大量請求觸發平台反爬蟲），播放時才取得完整資訊
//   邏輯與控制面板按鈕（commands.js 的 uq_*）一致；每個操作都會在該伺服器最近點歌的文字頻道留一行紀錄，
//   讓頻道裡的人知道是誰從網頁動了播放（WEB_SYNC_ANNOUNCE=0 可關閉）。
//
// 環境變數：
//   WEB_SYNC=0             關閉（未設定 MUSIC_LIB_URL 時本來就不會啟用）
//   WEB_SYNC_BOT_ID        網頁上識別這台 Bot 的 ID（預設 Discord 應用程式 ID）
//   WEB_SYNC_BOT_NAME      網頁上顯示的名稱（預設 Bot 的使用者名稱）
//   WEB_SYNC_ANNOUNCE=0    網頁操作時不在 Discord 頻道留紀錄
//
// 這個 repo 與 Mousebot / Mousebot-lite 的 unifiedQueue 相同，兩邊的 webSync.js 也保持一致。

const axios = require('axios');
const { getVoiceConnection, getVoiceConnections, VoiceConnectionStatus } = require('@discordjs/voice');
const { PermissionFlagsBits } = require('discord.js');
const libraryClient = require('../musicLibraryClient');
const { isSupportedMediaUrl } = require('../musicAntiBot');
const voiceMonitor = require('../voiceActivityMonitor');
const session = require('./session');
const {
  _engines,
  queues,
  nowPlaying,
  loopSettings,
  connections,
  randomPlaySettings,
  resetLoopAllCycle,
} = require('./state');
const { stopAll, enqueue, updateControlPanel, resetShuffleBag, getRequestChannel, adoptExistingConnection } = require('./playback');
const processGuards = require('../../../utils/processGuards');
const bootSummary = require('../../../utils/bootSummary');
const logger = require('../../../utils/logger');

const PUSH_DEBOUNCE_MS = 300;
const HEARTBEAT_MS = 30 * 1000;
const POLL_WAIT_SEC = 25;
const POLL_TIMEOUT_MS = (POLL_WAIT_SEC + 10) * 1000;
const PUSH_TIMEOUT_MS = 10 * 1000;
const MAX_QUEUE_ITEMS = 50;
const UNSUPPORTED_RETRY_MS = 10 * 60 * 1000; // 服務還沒有這個功能（404）：久久再試一次

let client = null;
let botId = '';
let botName = '';
let running = false;
let pollAbort = null;
let pushTimer = null;
let pushing = false;
let pushAgain = false;
let lastPushError = '';
let heartbeat = null;

const ANNOUNCE = process.env.WEB_SYNC_ANNOUNCE !== '0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isEnabled() {
  return libraryClient.isConfigured() && process.env.WEB_SYNC !== '0';
}

// ════════════════════════════════════════════════════════
//  狀態 → 網頁格式
// ════════════════════════════════════════════════════════
const platformOf = (url) => (/youtu\.?be/i.test(url || '') ? 'YouTube' : 'Bilibili');

// Bot 的曲目（type: local / bilibili）→ 網頁播放清單用的格式（kind: lib / online）
function toWebItem(item) {
  if (!item) return null;
  if (item.type === 'bilibili') {
    return {
      kind: 'online',
      url: item.url,
      title: item.title,
      author: item.author || '',
      platform: platformOf(item.url),
      duration: item.duration || '',
      durationSec: item.durationSec || 0,
    };
  }
  if (!item.filename) return null;
  return { kind: 'lib', filename: item.filename, title: item.title || item.name || item.filename };
}

// 網頁用來確認「要移除的是不是這一首」的鍵（佇列可能在網頁按下去之前就變了）
const itemKey = (item) => {
  const w = toWebItem(item);
  return !w ? '' : w.kind === 'lib' ? `lib:${w.filename}` : `on:${w.url}`;
};

// ── 語音狀態 ──────────────────────────────────────────
// connection：以 @discordjs/voice 目前登記的連線為準。autojoin 恢復連線時會丟掉舊物件、建一條新的，
//   音樂播放的 connections 裡可能還留著那個已銷毀的舊物件，不能拿它判斷。
// channelId：Bot「實際」所在的語音頻道，以 Discord 回報的語音狀態（members.me.voice）為準。
//   被踢出 / 斷線時，連線物件上的 joinConfig.channelId 不會被清掉（@discordjs/voice 只在有值時更新），
//   只看它會以為 Bot 還在原本的頻道。拿不到成員快取時才退回連線物件上的值。
// 兩者都有才算「在語音頻道」（可以點歌）。
const isAlive = (c) => !!c && c.state?.status !== VoiceConnectionStatus.Destroyed;

function voiceInfo(guildId) {
  const guild = client.guilds.cache.get(guildId);
  const registered = getVoiceConnection(guildId);
  const mapped = connections.get(guildId);
  const connection = isAlive(registered) ? registered : isAlive(mapped) ? mapped : null;
  if (connection) watchConnection(connection);
  const me = guild?.members?.me;
  const channelId = me ? (me.voice?.channelId || null) : (connection?.joinConfig?.channelId || null);
  return { connection, channelId: connection ? channelId : null };
}

// 連線狀態一變（就緒、斷線、銷毀）就推送，不必等 30 秒的心跳。
// autojoin 只換連線物件、沒有離開頻道時不會有 voiceStateUpdate，只能靠這個。
const watched = new WeakSet();
function watchConnection(connection) {
  if (watched.has(connection) || typeof connection.on !== 'function') return;
  watched.add(connection);
  connection.on('stateChange', (oldState, newState) => {
    if (oldState.status !== newState.status) schedulePush();
  });
}

// 給網頁看的連線狀態：ready / connecting（含 signalling）/ disconnected
function voiceStatusOf(connection) {
  const st = connection?.state?.status;
  if (st === VoiceConnectionStatus.Ready) return 'ready';
  if (st === VoiceConnectionStatus.Disconnected) return 'disconnected';
  return st ? 'connecting' : '';
}

function buildGuildState(guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;
  const { connection, channelId } = voiceInfo(guildId);
  const np = nowPlaying.get(guildId);
  if (!np && !channelId) return null;

  const queue = queues.get(guildId) || [];
  const playerState = np?.player?.state;
  return {
    guildId,
    guildName: guild.name,
    voiceChannel: channelId ? (guild.channels.cache.get(channelId)?.name || '') : '',
    voice: channelId ? voiceStatusOf(connection) : '',
    current: toWebItem(np?.item),
    status: np ? (playerState?.status || 'playing') : 'idle',
    positionMs: playerState?.resource?.playbackDuration || 0,
    queue: queue.slice(0, MAX_QUEUE_ITEMS).map(toWebItem).filter(Boolean),
    queueLength: queue.length,
    loopMode: loopSettings.get(guildId) || 'off',
    randomPlay: !!randomPlaySettings.get(guildId),
  };
}

function buildState() {
  // 除了音樂播放自己的連線，也要包含 autojoin、/voice 加入的（它們不會出現在 connections 裡）
  const ids = new Set([...nowPlaying.keys(), ...connections.keys(), ...getVoiceConnections().keys()]);
  return {
    name: botName,
    guilds: [...ids].map(buildGuildState).filter(Boolean),
  };
}

// ════════════════════════════════════════════════════════
//  推送狀態（合併頻繁變動；推送中又有變動就結束後再推一次）
// ════════════════════════════════════════════════════════
function schedulePush() {
  if (!running || pushTimer) return;
  pushTimer = setTimeout(() => { pushTimer = null; push(); }, PUSH_DEBOUNCE_MS);
}

async function push() {
  if (!running) return;
  if (pushing) { pushAgain = true; return; }
  pushing = true;
  try {
    await axios.put(`${libraryClient.getBaseUrl()}/api/music/bots/${botId}/state`, buildState(), {
      headers: libraryClient.authHeaders(),
      timeout: PUSH_TIMEOUT_MS,
    });
    if (lastPushError) logger.info('WebSync', '已恢復與共用音樂庫服務的同步');
    lastPushError = '';
  } catch (err) {
    const msg = err.response ? `HTTP ${err.response.status}` : err.message;
    if (msg !== lastPushError) logger.warn('WebSync', `推送播放狀態失敗：${msg}`); // 同樣的錯誤只記一次
    lastPushError = msg;
  } finally {
    pushing = false;
    if (pushAgain) { pushAgain = false; schedulePush(); }
  }
}

// ════════════════════════════════════════════════════════
//  執行網頁送來的指令
// ════════════════════════════════════════════════════════
class CommandError extends Error {}
const fail = (message) => { throw new CommandError(message); };

function announce(guildId, text) {
  if (!ANNOUNCE) return;
  const guild = client.guilds.cache.get(guildId);
  const ch = guild ? notifyChannelFor(guild, voiceInfo(guildId).channelId) : null;
  if (ch && typeof ch.send === 'function') ch.send(`🌐 網頁播放器：${text}`).catch(() => {});
}

// 網頁點歌時的通知頻道：最近點歌的文字頻道 → 沒有的話用語音頻道內建的文字聊天（Bot 有權限發言時）
// → 都沒有就不發訊息。autojoin 進來、還沒人用過 /play 的伺服器就是第二種情況。
function notifyChannelFor(guild, channelId) {
  const ch = getRequestChannel(guild.id);
  if (ch) return ch;
  const vc = channelId ? guild.channels.cache.get(channelId) : null;
  const me = guild.members?.me;
  if (vc?.isTextBased?.() && me && vc.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) return vc;
  return null;
}

async function refreshPanel(guildId) {
  const ch = getRequestChannel(guildId);
  if (ch) await updateControlPanel(guildId, ch);
  else session.schedule();
}

const parseDur = (v) => {
  const p = String(v || '').split(':').map(Number);
  return p.length > 1 && p.every(Number.isFinite) ? p.reduce((a, b) => a * 60 + b, 0) : 0;
};

// 批量加入的線上歌曲：不呼叫 getInfo，格式同 search/playlist.js 的 _handleAddPlaylist
function onlineItemFromWeb(raw) {
  return {
    url: raw.url,
    title: raw.title || '未知標題',
    author: raw.author || '未知作者',
    duration: raw.duration || '未知',
    durationSec: parseDur(raw.duration),
    thumbnail: null,
    type: 'bilibili',
  };
}

// 網頁點歌前的共同準備：確認 Bot 在語音頻道、接手 autojoin 的連線、決定通知頻道
function prepareVoice(guildId) {
  const guild = client.guilds.cache.get(guildId);
  const { connection, channelId } = voiceInfo(guildId);
  if (!connection || !channelId) fail('Bot 不在語音頻道，請先在 Discord 用 /play 讓 Bot 加入');
  const notify = notifyChannelFor(guild, channelId);
  // autojoin / /voice 加入的連線、或 autojoin 恢復後換掉的新連線：比照 /play，讓音樂播放接手（登記連線、掛閒置監控）
  if (connections.get(guildId) !== connection) adoptExistingConnection(guild, client, notify);
  // 沒有可發訊息的頻道時給一個不發訊息的頻道，enqueue 內部的通知不會出錯
  return notify || { id: null, send: async () => {} };
}

// 網頁點的歌 → Bot 的曲目格式
async function resolveItem(raw) {
  if (raw?.kind === 'lib') {
    const engine = _engines.local;
    if (!engine) fail('本地音樂引擎未就緒');
    const file = engine.getMusicFiles().find((f) => f.filename === raw.filename);
    if (!file) fail('這台 Bot 的音樂庫清單還沒有這首歌（剛上傳的歌要等清單更新），請稍後再試');
    return { ...file, title: file.name, type: 'local' };
  }
  if (raw?.kind === 'online') {
    const engine = _engines.bilibili;
    if (!engine || typeof engine.getInfo !== 'function') fail('線上音樂引擎未就緒');
    if (!isSupportedMediaUrl(raw.url)) fail('只支援 YouTube 與 Bilibili 的網址');
    let info;
    try { info = await engine.getInfo(raw.url); } catch (err) { fail(`無法取得影片資訊：${err.message}`); }
    return { ...info, type: 'bilibili' };
  }
  fail('不支援的歌曲格式');
}

async function execute(cmd) {
  const { guildId, action } = cmd;
  if (!client.guilds.cache.has(guildId)) fail('Bot 不在這個伺服器');
  voiceMonitor.touchActivity(guildId); // 網頁操作也算頻道仍活躍，重置閒置計時器
  const np = nowPlaying.get(guildId);
  const needPlaying = () => { if (!np) fail('目前沒有播放音樂'); };

  switch (action) {
    case 'skip': {
      needPlaying();
      const queue = queues.get(guildId) || [];
      const loopMode = loopSettings.get(guildId) || 'off';
      // 與 commands.js 的 uq_skip 一致：隨機連播交給 Idle 挑下一首；佇列空且不循環才整組停止
      if (randomPlaySettings.get(guildId)) {
        np.player.stop();
        announce(guildId, `⏭️ 跳過「${np.item.title}」，隨機連播下一首`);
        return '已跳過，隨機連播下一首';
      }
      if (queue.length === 0 && loopMode === 'off') {
        stopAll(guildId);
        announce(guildId, `⏭️ 跳過「${np.item.title}」，佇列為空，停止播放`);
        return '已跳過，佇列為空，停止播放';
      }
      np.player.stop();
      announce(guildId, `⏭️ 跳過「${np.item.title}」`);
      return '已跳過';
    }

    case 'stop':
      needPlaying();
      stopAll(guildId);
      announce(guildId, '⏹️ 停止播放');
      return '已停止播放';

    case 'loop': {
      needPlaying();
      const mode = ['off', 'one', 'all'].includes(cmd.mode) ? cmd.mode : 'off';
      randomPlaySettings.set(guildId, false); // 與循環互斥
      loopSettings.set(guildId, mode);
      if (mode === 'all') resetLoopAllCycle(guildId);
      await refreshPanel(guildId);
      const text = mode === 'one' ? '🔂 單曲循環已開啟' : mode === 'all' ? '🔁 列表循環已開啟' : '❌ 循環已關閉';
      announce(guildId, text);
      return text;
    }

    case 'randomPlay': {
      needPlaying();
      const on = !!cmd.on;
      randomPlaySettings.set(guildId, on);
      if (on) {
        loopSettings.set(guildId, 'off');
        resetShuffleBag(guildId); // 每次開啟都是新的一輪，與 uq_random_play 一致
      }
      await refreshPanel(guildId);
      const text = on ? '🎲 隨機連播已開啟' : '❌ 隨機連播已關閉';
      announce(guildId, text);
      return text;
    }

    case 'clearQueue': {
      const queue = queues.get(guildId) || [];
      if (!queue.length) fail('佇列已經是空的');
      queues.set(guildId, []);
      session.schedule();
      announce(guildId, `🗑️ 清空佇列（${queue.length} 首）`);
      return `已清空佇列（${queue.length} 首）`;
    }

    case 'removeQueue': {
      const queue = queues.get(guildId) || [];
      const i = Number(cmd.index);
      const target = queue[i];
      if (!target || (cmd.key && itemKey(target) !== cmd.key)) fail('佇列已經變動，請重新整理後再試');
      queue.splice(i, 1);
      session.schedule();
      announce(guildId, `➖ 從佇列移除「${target.title}」`);
      return `已移除「${target.title}」`;
    }

    case 'enqueue': {
      const channel = prepareVoice(guildId); // 先確認在語音頻道，才去查影片資訊
      const item = await resolveItem(cmd.item);
      const result = await enqueue(guildId, item, channel);
      if (result.queued && cmd.next) {
        const queue = queues.get(guildId) || [];
        const k = queue.lastIndexOf(item);
        if (k > 0) { queue.splice(k, 1); queue.unshift(item); session.schedule(); }
      }
      const where = !result.queued ? '開始播放' : cmd.next ? '下一首播放' : `加入佇列（第 ${result.position} 首）`;
      announce(guildId, `🎵 ${where}「${item.title}」`);
      return `${where}「${item.title}」`;
    }

    case 'enqueueMany': {
      const channel = prepareVoice(guildId);
      const engine = _engines.local;
      const files = new Map((engine ? engine.getMusicFiles() : []).map((f) => [f.filename, f]));
      const items = [];
      let missing = Number(cmd.skipped) || 0; // 服務端已略過的（檔案不存在、網址不支援）
      for (const raw of Array.isArray(cmd.items) ? cmd.items : []) {
        if (raw?.kind === 'lib') {
          const f = files.get(raw.filename);
          if (f) items.push({ ...f, title: f.name, type: 'local' }); else missing++;
        } else if (raw?.kind === 'online' && isSupportedMediaUrl(raw.url)) {
          items.push(onlineItemFromWeb(raw));
        } else missing++;
      }
      if (!items.length) fail('這台 Bot 的音樂庫清單裡沒有這些歌（剛上傳的歌要等清單更新），請稍後再試');

      // 沒在播放：第一首直接開始播（走一般的 enqueue），其餘一次放進佇列，
      // 不逐首呼叫 enqueue（每首都會記一行 log、觸發一次狀態寫入）
      let started = null;
      if (!nowPlaying.has(guildId)) {
        started = items.shift();
        await enqueue(guildId, started, channel);
        if (!nowPlaying.has(guildId)) fail(`無法開始播放「${started.title}」`);
      }
      const queue = queues.get(guildId) || [];
      if (cmd.next) queue.unshift(...items); else queue.push(...items);
      queues.set(guildId, queue);
      session.schedule();

      const total = items.length + (started ? 1 : 0);
      const parts = [];
      if (started) parts.push(`開始播放「${started.title}」`);
      if (items.length) parts.push(`${cmd.next ? '插到佇列最前面' : '加入佇列'} ${items.length} 首`);
      const skippedText = missing ? `（略過 ${missing} 首找不到的歌）` : '';
      logger.info('UnifiedQueue', `➕ 網頁批量加入 ${total} 首 (${guildId})${skippedText}`);
      announce(guildId, `🎵 一次點了 ${total} 首：${parts.join('，')}${skippedText}`);
      return `已送出 ${total} 首：${parts.join('，')}${skippedText}`;
    }

    default:
      fail('不支援的操作');
  }
}

async function handleCommand(cmd) {
  let result;
  try {
    result = { ok: true, message: await execute(cmd) };
    logger.info('WebSync', `網頁操作 ${cmd.action} (${cmd.guildId})：${result.message}`);
  } catch (err) {
    result = { ok: false, message: err instanceof CommandError ? err.message : `執行失敗：${err.message}` };
    if (!(err instanceof CommandError)) logger.error('WebSync', `執行網頁指令失敗 (${cmd.action})：`, err);
  }
  try {
    await axios.post(`${libraryClient.getBaseUrl()}/api/music/bots/${botId}/commands/${encodeURIComponent(cmd.id)}/result`, result, {
      headers: libraryClient.authHeaders(),
      timeout: PUSH_TIMEOUT_MS,
    });
  } catch (err) {
    logger.warn('WebSync', `回報指令結果失敗：${err.message}`);
  }
  schedulePush();
}

// ════════════════════════════════════════════════════════
//  長輪詢
// ════════════════════════════════════════════════════════
async function pollLoop() {
  let backoff = 0;
  while (running) {
    pollAbort = new AbortController();
    try {
      const { data } = await axios.get(`${libraryClient.getBaseUrl()}/api/music/bots/${botId}/commands`, {
        params: { wait: POLL_WAIT_SEC },
        headers: libraryClient.authHeaders(),
        timeout: POLL_TIMEOUT_MS,
        signal: pollAbort.signal,
      });
      backoff = 0;
      for (const cmd of Array.isArray(data?.commands) ? data.commands : []) {
        if (cmd && typeof cmd.id === 'string') await handleCommand(cmd); // 依序執行，保持網頁送出的順序
      }
    } catch (err) {
      if (!running) break;
      if (err.response?.status === 404) {
        logger.warn('WebSync', '共用音樂庫服務還不支援「正在播放」同步（請更新服務），10 分鐘後再試');
        await sleep(UNSUPPORTED_RETRY_MS);
        continue;
      }
      backoff = Math.min(60 * 1000, backoff ? backoff * 2 : 5000);
      logger.debug('WebSync', `取得網頁指令失敗（${backoff / 1000} 秒後重試）：${err.message}`);
      await sleep(backoff);
    }
  }
}

// ════════════════════════════════════════════════════════
//  啟動 / 停止
// ════════════════════════════════════════════════════════
function start(discordClient) {
  if (running) return;
  if (!isEnabled()) {
    bootSummary.report('網頁正在播放同步', 'off', libraryClient.isConfigured() ? 'WEB_SYNC=0' : '未設定 MUSIC_LIB_URL');
    return;
  }
  client = discordClient;
  const rawId = process.env.WEB_SYNC_BOT_ID || client.user.id;
  botId = String(rawId).replace(/[^\w-]/g, '').slice(0, 40) || client.user.id;
  botName = (process.env.WEB_SYNC_BOT_NAME || client.user.username || botId).slice(0, 50);
  running = true;

  session.onChange(schedulePush);
  // Bot 自己進出語音頻道（還沒開始播放、被踢出頻道）也要讓網頁知道
  client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.id === client.user.id || oldState.id === client.user.id) schedulePush();
  });
  heartbeat = setInterval(push, HEARTBEAT_MS);
  heartbeat.unref();
  processGuards.onShutdown(stop);

  push();
  pollLoop();
  bootSummary.report('網頁正在播放同步', 'ok', `以「${botName}」（${botId}）同步到共用音樂庫服務`);
}

// 關閉前（重新部署、SIGTERM、未捕捉例外後重啟）通知服務「這台 Bot 下線了」：網頁立刻顯示離線，
// 這段期間網頁送的指令直接失敗，不會排隊到重啟後才被執行。processGuards 關閉前會等 Discord 斷線（最多 3 秒）
// 或 1 秒後才結束程序，足夠這個請求送出；送不到也沒關係，服務 90 秒沒消息同樣會判定離線。
function stop() {
  if (!running) return;
  running = false;
  clearInterval(heartbeat);
  clearTimeout(pushTimer);
  if (pollAbort) pollAbort.abort();
  axios.delete(`${libraryClient.getBaseUrl()}/api/music/bots/${botId}/state`, {
    headers: libraryClient.authHeaders(),
    timeout: 2000,
  }).catch(() => {});
}

module.exports = {
  start,
  stop,
  // 測試用
  _toWebItem: toWebItem,
  _buildState: buildState,
  _itemKey: itemKey,
  _execute: execute,
  _setClient(c) { client = c; },
  CommandError,
};
