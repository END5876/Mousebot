'use strict';
// admin/voiceState.js
// ─────────────────────────────────────────────────────────────
// 語音連線與音樂播放的狀態快照，以及管理面板的播放控制。
// 控制邏輯與控制面板按鈕（unifiedQueue/commands.js 的 uq_*）一致；
// 變動後更新 Discord 上的控制面板，並透過 session.schedule() 讓網頁播放器同步（webSync）。

const { getVoiceConnection, VoiceConnectionStatus } = require('@discordjs/voice');
const state = require('../handlers/musicplayer/unifiedQueue/state');
const playback = require('../handlers/musicplayer/unifiedQueue/playback');
const session = require('../handlers/musicplayer/unifiedQueue/session');
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

module.exports = { voiceInfo, musicState, idleMonitorState, musicAction, trackInfo };
