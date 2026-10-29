'use strict';
// admin/voiceState.js
// ─────────────────────────────────────────────────────────────
// 語音連線與音樂播放的狀態快照，以及管理面板的播放控制。
// 控制邏輯與控制面板按鈕（unifiedQueue/commands.js 的 uq_*）一致；
// 變動後更新 Discord 上的控制面板，並透過 session.schedule() 讓網頁播放器同步（webSync）。

const { getVoiceConnection, VoiceConnectionStatus } = require('@discordjs/voice');
const { PermissionFlagsBits } = require('discord.js');
const state = require('../handlers/musicplayer/unifiedQueue/state');
const playback = require('../handlers/musicplayer/unifiedQueue/playback');
const session = require('../handlers/musicplayer/unifiedQueue/session');
const { cleanUrl } = require('../handlers/musicplayer/unifiedQueue/search/urlUtils');
const { isSupportedMediaUrl } = require('../handlers/musicplayer/musicAntiBot');
const voiceMonitor = require('../handlers/musicplayer/voiceActivityMonitor');
const { HttpError } = require('./http');

const MAX_QUEUE_ITEMS = 100;

// ════════════════════════════════════════════════════════
//  狀態
// ════════════════════════════════════════════════════════

/**
 * Bot 在這個伺服器的語音連線；沒有連線時回傳 null。
 * 頻道以 Discord 回報的語音狀態為準（被踢出時連線物件上的 joinConfig.channelId 不會被清掉），
 * 拿不到成員快取時才退回連線物件上的值。
 */
function voiceInfo(guild) {
  const connection = getVoiceConnection(guild.id);
  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) return null;

  const me = guild.members.me;
  const channelId = me ? (me.voice?.channelId ?? null) : (connection.joinConfig.channelId ?? null);
  const channel = channelId ? guild.channels.cache.get(channelId) : null;
  return {
    channelId,
    channelName: channel?.name ?? null,
    status: connection.state.status, // signalling / connecting / ready / disconnected
    listeners: channel ? channel.members.filter((m) => !m.user.bot).size : null,
  };
}

// 網頁用來確認「要移除的是不是這一首」的鍵（佇列可能在按下去之前就變了）；格式與 webSync 相同
function itemKey(item) {
  if (!item) return '';
  return item.type === 'bilibili' ? `on:${item.url}` : `lib:${item.filename}`;
}

function trackInfo(item) {
  if (!item) return null;
  const online = item.type === 'bilibili';
  return {
    key: itemKey(item),
    title: item.title || item.name || item.filename || '未知曲目',
    source: online ? (/youtu\.?be/i.test(item.url || '') ? 'YouTube' : 'Bilibili') : '本地音樂',
    url: online ? item.url ?? null : null,
    author: online ? item.author || null : null,
    durationSec: item.durationSec || null,
    thumbnail: online ? item.thumbnail || null : null,
  };
}

/** 這個伺服器正在播放的內容；沒有播放時回傳 null */
function musicState(guildId) {
  const np = state.nowPlaying.get(guildId);
  if (!np) return null;
  const queue = state.queues.get(guildId) || [];
  const playerState = np.player?.state;
  return {
    current: trackInfo(np.item),
    status: playerState?.status ?? 'playing', // idle / buffering / playing / paused / autopaused
    positionMs: playerState?.resource?.playbackDuration ?? 0,
    queue: queue.slice(0, MAX_QUEUE_ITEMS).map(trackInfo),
    queueLength: queue.length,
    loopMode: state.loopSettings.get(guildId) || 'off',
    randomPlay: !!state.randomPlaySettings.get(guildId),
  };
}

function idleMonitorState(guildId) {
  return { enabled: voiceMonitor.isEnabled(guildId), active: voiceMonitor.isMonitoring(guildId) };
}

// ════════════════════════════════════════════════════════
//  控制
// ════════════════════════════════════════════════════════
async function refreshPanel(guildId) {
  const channel = playback.getRequestChannel(guildId);
  if (channel) await playback.updateControlPanel(guildId, channel).catch(() => {});
  else session.schedule();
}

/**
 * @param {string} guildId
 * @param {{ action: string, mode?: string, on?: boolean, index?: number, key?: string }} cmd
 * @returns {Promise<string>} 給使用者看的結果
 */
async function musicAction(guildId, cmd) {
  const np = state.nowPlaying.get(guildId);
  const needPlaying = () => { if (!np) throw new HttpError(409, '目前沒有播放音樂'); };
  voiceMonitor.touchActivity(guildId);

  switch (cmd.action) {
    case 'skip': {
      needPlaying();
      const queue = state.queues.get(guildId) || [];
      const loopMode = state.loopSettings.get(guildId) || 'off';
      // 隨機連播：交給 Idle 事件挑下一首；佇列空且不循環才整組停止，其餘交給循環邏輯
      if (state.randomPlaySettings.get(guildId)) {
        np.player.stop();
        return '已跳過，隨機連播下一首';
      }
      if (queue.length === 0 && loopMode === 'off') {
        playback.stopAll(guildId);
        return '已跳過，佇列為空，停止播放';
      }
      np.player.stop();
      return '已跳過';
    }

    case 'stop':
      needPlaying();
      playback.stopAll(guildId);
      return '已停止播放';

    case 'loop': {
      needPlaying();
      if (!['off', 'one', 'all'].includes(cmd.mode)) throw new HttpError(400, '循環模式不正確');
      state.randomPlaySettings.set(guildId, false); // 與隨機連播互斥
      state.loopSettings.set(guildId, cmd.mode);
      if (cmd.mode === 'all') state.resetLoopAllCycle(guildId);
      await refreshPanel(guildId);
      return cmd.mode === 'one' ? '已開啟單曲循環' : cmd.mode === 'all' ? '已開啟列表循環' : '已關閉循環';
    }

    case 'random': {
      needPlaying();
      if (typeof cmd.on !== 'boolean') throw new HttpError(400, '隨機連播開關不正確');
      state.randomPlaySettings.set(guildId, cmd.on);
      if (cmd.on) {
        state.loopSettings.set(guildId, 'off');
        playback.resetShuffleBag(guildId); // 每次開啟都是新的一輪
      }
      await refreshPanel(guildId);
      return cmd.on ? '已開啟隨機連播' : '已關閉隨機連播';
    }

    case 'clearQueue': {
      const queue = state.queues.get(guildId) || [];
      if (!queue.length) throw new HttpError(409, '佇列已經是空的');
      state.queues.set(guildId, []);
      session.schedule();
      return `已清空佇列（${queue.length} 首）`;
    }

    case 'removeQueue': {
      const queue = state.queues.get(guildId) || [];
      const i = Number(cmd.index);
      const target = Number.isInteger(i) ? queue[i] : undefined;
      if (!target || itemKey(target) !== cmd.key) throw new HttpError(409, '佇列已經變動，請重新整理後再試');
      queue.splice(i, 1);
      session.schedule();
      return `已移除「${target.title}」`;
    }

    default:
      throw new HttpError(400, '不支援的操作');
  }
}

// ════════════════════════════════════════════════════════
//  點歌（與網頁播放器 webSync.js 的 enqueue 相同的流程）
// ════════════════════════════════════════════════════════

// 點歌通知頻道：最近點歌的文字頻道 → 語音頻道內建的文字聊天（Bot 有權限發言時）→ 都沒有就不發訊息
function notifyChannelFor(guild, channelId) {
  const ch = playback.getRequestChannel(guild.id);
  if (ch) return ch;
  const vc = channelId ? guild.channels.cache.get(channelId) : null;
  const me = guild.members?.me;
  if (vc?.isTextBased?.() && me && vc.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) return vc;
  return null;
}

/** 本地音樂清單（依播放次數排序），q 有值時以名稱篩選 */
function libraryList(q, limit = 200) {
  const engine = state._engines.local;
  if (!engine) throw new HttpError(503, '本地音樂引擎尚未就緒');
  const keyword = String(q || '').trim().toLowerCase();
  const files = engine.getMusicFiles();
  const matched = keyword
    ? files.filter((f) => f.name.toLowerCase().includes(keyword) || f.filename.toLowerCase().includes(keyword))
    : files;
  return {
    total: files.length,
    items: matched.slice(0, limit).map((f) => ({ filename: f.filename, name: f.name, playCount: f.playCount ?? 0 })),
    more: Math.max(0, matched.length - limit),
  };
}

/** YouTube + Bilibili 搜尋（與 /play 送出後的搜尋相同，每個平台最多 limit 筆） */
async function onlineSearch(q, limit = 5) {
  const engine = state._engines.bilibili;
  if (!engine || typeof engine.searchMulti !== 'function') throw new HttpError(503, '線上音樂引擎初始化中，請稍後再試');
  try {
    const results = await engine.searchMulti(q, limit);
    return (results || []).map((r) => ({ title: r.title, url: r.url, platform: r.platform, author: r.author, duration: r.duration }));
  } catch (err) {
    throw new HttpError(502, `搜尋失敗：${err.message}`);
  }
}

async function resolveItem(raw) {
  if (raw?.kind === 'lib') {
    const engine = state._engines.local;
    if (!engine) throw new HttpError(503, '本地音樂引擎尚未就緒');
    const file = engine.getMusicFiles().find((f) => f.filename === raw.filename);
    if (!file) throw new HttpError(404, '找不到這首本地音樂，清單可能已經更新');
    return { ...file, title: file.name, type: 'local' };
  }
  if (raw?.kind === 'online') {
    const engine = state._engines.bilibili;
    if (!engine || typeof engine.getInfo !== 'function') throw new HttpError(503, '線上音樂引擎初始化中，請稍後再試');
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!isSupportedMediaUrl(url)) throw new HttpError(400, '只支援 YouTube 與 Bilibili 的網址');
    try {
      return { ...(await engine.getInfo(cleanUrl(url))), type: 'bilibili' };
    } catch (err) {
      throw new HttpError(502, `無法取得影片資訊：${err.message}`);
    }
  }
  throw new HttpError(400, '不支援的歌曲格式');
}

/**
 * 從管理面板點歌：Bot 必須已經在這個伺服器的語音頻道裡
 * @param {{ item: { kind: 'lib', filename: string } | { kind: 'online', url: string }, next?: boolean }} cmd
 * @returns {Promise<{ message: string, title: string }>}
 */
async function enqueueFromPanel(client, guild, cmd) {
  const info = voiceInfo(guild);
  if (!info?.channelId) throw new HttpError(409, 'Bot 不在這個伺服器的語音頻道，請先讓 Bot 加入語音頻道');

  const notify = notifyChannelFor(guild, info.channelId);
  // autojoin / /voice / 面板加入的連線：比照 /play，讓音樂播放接手（登記連線、掛閒置監控）
  if (state.connections.get(guild.id) !== getVoiceConnection(guild.id)) playback.adoptExistingConnection(guild, client, notify);

  const item = await resolveItem(cmd.item);
  // 沒有可發訊息的頻道時給一個不發訊息的頻道，enqueue 內部的通知不會出錯
  const result = await playback.enqueue(guild.id, item, notify || { id: null, send: async () => {} });
  // 引擎沒播起來（例如共用庫裡的檔案已經刪掉）會清掉 nowPlaying：不能回報「開始播放」、也不寫稽核紀錄
  if (!result.queued && !state.nowPlaying.has(guild.id)) throw new HttpError(502, `無法開始播放「${item.title}」`);
  if (result.queued && cmd.next) {
    const queue = state.queues.get(guild.id) || [];
    const k = queue.lastIndexOf(item);
    if (k > 0) {
      queue.splice(k, 1);
      queue.unshift(item);
      session.schedule();
      // enqueue 預先下載時它還在佇列尾端，移到最前面後要重新觸發
      playback.prefetchUpcoming(guild.id);
    }
  }
  voiceMonitor.touchActivity(guild.id);
  const where = !result.queued ? '開始播放' : cmd.next ? '下一首播放' : `加入佇列（第 ${result.position} 首）`;
  return { message: `${where}「${item.title}」`, title: item.title };
}

module.exports = {
  voiceInfo, musicState, idleMonitorState, musicAction, trackInfo,
  libraryList, onlineSearch, enqueueFromPanel,
};
