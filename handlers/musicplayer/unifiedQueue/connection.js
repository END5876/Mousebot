// 統一佇列 — 語音連線管理與閒置停播。

const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { startSilenceLayer, restoreActiveLayer } = require('../../audioManager');
const voiceMonitor = require('../voiceActivityMonitor');
const { connections } = require('./state');
const logger = require('../../../utils/logger');
const { _getNotifyChannel, requestChannels } = require('./requestChannels');
const stopAll = (...a) => require('./playback').stopAll(...a); // 延後載入：兩個檔互相使用
const isPlaying = (...a) => require('./playback').isPlaying(...a); // 延後載入：兩個檔互相使用

// ════════════════════════════════════════════════════════
//  閒置自動「停止播放但不離開頻道」的共用 onStop callback 產生器
// ════════════════════════════════════════════════════════
function _createPersistentIdleHandler(guildId, fallbackChannel) {
  return (gId, reason) => {
    const wasPlaying = isPlaying(gId);
    const targetChannel = _getNotifyChannel(gId, fallbackChannel);

    if (!wasPlaying) {
      logger.debug('UnifiedQueue', `⏭️ 常駐模式閒置觸發 (${gId})：${reason}（原本未在播放，直接略過）`);
      return;
    }

    stopAll(gId);
    logger.info('UnifiedQueue', `⏹️ 常駐模式閒置觸發 (${gId})：${reason}，已停止播放（Bot 繼續留在頻道）`);

    if (!targetChannel || typeof targetChannel.send !== 'function') {
      logger.warn('UnifiedQueue', `找不到可用的通知頻道 (${gId})，略過閒置通知訊息`);
      return;
    }

    targetChannel.send(
      `${reason} ⏹️ 已自動停止播放\n`
    ).catch(() => {});
  };
}

// ════════════════════════════════════════════════════════
//  語音連線管理（共用）
// ════════════════════════════════════════════════════════
async function ensureConnection(interaction) {
  return _connectTo({
    guild: interaction.guild,
    voiceChannel: interaction.member?.voice?.channel,
    textChannel: interaction.channel,
    client: interaction.client,
  });
}

/**
 * 確保 Bot 連到指定語音頻道（已有連線則沿用），並掛上閒置監控與斷線處理。
 * ensureConnection（指令觸發）與 resumeSavedSessions（重啟恢復）共用。
 */
async function _connectTo({ guild, voiceChannel, textChannel, client }) {
  const guildId = guild.id;
  let connection = getVoiceConnection(guildId);

  requestChannels.set(guildId, textChannel);

  // 沿用既有連線前先確認它還能用：斷線後恢復失敗、卡在 Signalling／Connecting 的連線沿用下去，
  // 播放會靜悄悄沒有聲音。給它 5 秒恢復，不行就銷毀、改建新連線（沒有指定頻道時只能沿用）。
  if (connection && voiceChannel && connection.state.status !== VoiceConnectionStatus.Ready) {
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 5_000);
    } catch {
      logger.warn('UnifiedQueue', `既有語音連線未就緒（${connection.state.status}），重新建立 (${guildId})`);
      try { connection.destroy(); } catch {}
      connection = getVoiceConnection(guildId);
    }
  }

  if (connection) {
    _adoptConnection({ guildId, connection, voiceChannel, textChannel, client });
    return connection;
  }

  if (!voiceChannel) return null;

  connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (err) {
    // 沒連上的連線留著會讓之後每次播放都沿用這條壞掉的連線，而且 Bot 會卡在頻道裡
    try { connection.destroy(); } catch {}
    throw err;
  }

  startSilenceLayer(guildId);
  // 上面若是銷毀卡住的舊連線後重建：舊連線的訂閱跟著被解除，nowPlaying 的 player 會停在 AutoPaused、
  // 永遠等不到 Idle；靜音層已存在時 startSilenceLayer 也不會重新訂閱。把目前那一層訂閱到新連線
  restoreActiveLayer(guildId);

  voiceMonitor.startMonitoring({
    guildId,
    connection,
    channel: voiceChannel,
    client,
    onStop: _createPersistentIdleHandler(guildId, textChannel),
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      logger.warn('UnifiedQueue', `語音連線斷開 (${guildId})`);
      try { connection.destroy(); } catch {}
      stopAll(guildId);
      voiceMonitor.stopMonitoring(guildId);
      connections.delete(guildId);
      const sendTo = _getNotifyChannel(guildId, textChannel);
      sendTo?.send('⚠️ Bot 跟語音頻道斷線了，佇列已清空。用 /play 就能重新開始。').catch(() => {});
    }
  });

  connections.set(guildId, connection);
  return connection;
}

// 沿用已存在的語音連線（autojoin、/voice 加入、或之前的播放留下的）：登記到 connections、
// 還沒有閒置監控就掛上。_connectTo 與 adoptExistingConnection 共用。
function _adoptConnection({ guildId, connection, voiceChannel, textChannel, client }) {
  connections.set(guildId, connection);
  if (!voiceMonitor.isMonitoring(guildId) && voiceChannel) {
    voiceMonitor.startMonitoring({
      guildId,
      connection,
      channel: voiceChannel,
      client,
      onStop: _createPersistentIdleHandler(guildId, textChannel),
    });
  }
}

/**
 * 不是由指令觸發、但 Bot 已經在語音頻道裡（例如 autojoin）時，讓音樂播放接手這條連線，
 * 效果同 /play 遇到既有連線的情況。webSync.js 從網頁點歌時使用；沒有連線時回傳 null（不會主動加入頻道）。
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').TextBasedChannel|null} textChannel 閒置停止時的通知頻道
 */
function adoptExistingConnection(guild, client, textChannel) {
  const connection = getVoiceConnection(guild.id);
  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) return null;
  const voiceChannel = guild.channels.cache.get(connection.joinConfig.channelId) || null;
  _adoptConnection({ guildId: guild.id, connection, voiceChannel, textChannel, client });
  return connection;
}

/**
 * 別的模組（autojoin 的恢復流程）銷毀並重建了這個伺服器的語音連線之後呼叫，同 _connectTo 的重建處理：
 * 銷毀舊連線會一併解除訂閱，播放器沒人訂閱就停在 AutoPaused、永遠不會 Idle（佇列不會往下走）。
 * connections 裡的舊物件換成新連線，並把 audioManager 目前那一層（音樂／TTS／靜音）訂閱到新連線。
 * @param {string} guildId
 * @param {import('@discordjs/voice').VoiceConnection} connection 新的連線
 */
function rebindConnection(guildId, connection) {
  if (connections.has(guildId)) connections.set(guildId, connection);
  restoreActiveLayer(guildId);
}

module.exports = {
  _connectTo,
  _createPersistentIdleHandler,
  ensureConnection,
  adoptExistingConnection,
  rebindConnection,
};
