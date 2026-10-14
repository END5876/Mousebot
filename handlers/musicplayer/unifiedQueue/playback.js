// handlers/unifiedQueue/playback.js
// 統一佇列 — 播放核心：控制面板、播放器生命週期、佇列播放、語音連線管理

const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  AudioPlayerStatus,
} = require('@discordjs/voice');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const { setMusicPlayer, stopMusicLayer, startSilenceLayer } = require('../../audioManager');
const voiceMonitor = require('../voiceActivityMonitor');

const {
  _engines,
  queues,
  nowPlaying,
  loopSettings,
  controlMsgs,
  connections,
  randomPlaySettings,
  resetLoopAllCycle,
  getLoopAllCycleSeen,
} = require('./state');
const session = require('./session');
const logger = require('../../../utils/logger');

// ════════════════════════════════════════════════════════
//  記錄每個 guild「點歌的頻道」
// ════════════════════════════════════════════════════════
const requestChannels = new Map();

function _getNotifyChannel(guildId, fallbackChannel) {
  return requestChannels.get(guildId) || fallbackChannel;
}

// 最近一次點歌的文字頻道（webSync.js 從網頁點歌、更新控制面板時沿用）
function getRequestChannel(guildId) {
  return requestChannels.get(guildId) || null;
}

// ════════════════════════════════════════════════════════
//  持久化快照（session.js 在寫檔時呼叫）
// ════════════════════════════════════════════════════════
function _buildSessionSnapshot() {
  const snapshot = {};
  for (const [guildId, np] of nowPlaying) {
    const connection = connections.get(guildId) || getVoiceConnection(guildId);
    const voiceChannelId = connection?.joinConfig?.channelId;
    if (!voiceChannelId) continue;

    snapshot[guildId] = {
      voiceChannelId,
      textChannelId: requestChannels.get(guildId)?.id ?? null,
      current: session.serializeItem(np.item),
      queue: (queues.get(guildId) || []).map(session.serializeItem).filter(Boolean),
      loopMode: loopSettings.get(guildId) || 'off',
      randomPlay: randomPlaySettings.get(guildId) || false,
      savedAt: Date.now(),
    };
  }
  return snapshot;
}
session.setSnapshotProvider(_buildSessionSnapshot);

// ════════════════════════════════════════════════════════
//  控制面板
// ════════════════════════════════════════════════════════
function _buildEmbed(guildId) {
  const np = nowPlaying.get(guildId);
  const queue = queues.get(guildId) || [];
  const loopMode = loopSettings.get(guildId) || 'off';
  const isRandomPlay = randomPlaySettings.get(guildId) || false;

  if (!np) return null;

  let loopText = '❌ 關閉';
  if (loopMode === 'one') loopText = '🔂 單曲循環';
  if (loopMode === 'all') loopText = '🔁 列表循環';
  if (isRandomPlay) loopText = '🎲 隨機連播';

  const { item } = np;

  const embed = new EmbedBuilder()
    .setColor(isRandomPlay ? 0xFF8C00 : 0x1DB954)
    .setTitle('🎵 正在播放')
    .setTimestamp()
    .setFooter({ text: '📋 使用下方按鈕控制播放' });

  if (item.type === 'bilibili') {
    embed
      .setDescription(`[${item.title}](${item.url})`)
      .addFields(
        { name: '作者', value: item.author || '未知', inline: true },
        { name: '時長', value: item.duration || '未知', inline: true },
        { name: '循環模式', value: loopText, inline: true },
        { name: '佇列', value: `${queue.length} 首`, inline: true },
      );
    if (item.thumbnail) embed.setThumbnail(item.thumbnail);
  } else {
    embed
      .setDescription(`🎧 **${item.title}**`)
      .addFields(
        { name: '循環模式', value: loopText, inline: true },
        { name: '佇列', value: `${queue.length} 首`, inline: true },
      );
  }

  return embed;
}

function _buildButtons(guildId) {
  const loopMode = loopSettings.get(guildId) || 'off';
  const isRandomPlay = randomPlaySettings.get(guildId) || false;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('uq_skip')
      .setLabel('跳過')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('uq_stop')
      .setLabel('停止')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('uq_loop_one')
      .setLabel('單曲循環')
      .setEmoji('🔂')
      .setStyle(loopMode === 'one' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('uq_loop_all')
      .setLabel('列表循環')
      .setEmoji('🔁')
      .setStyle(loopMode === 'all' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('uq_random_play')
      .setLabel('隨機連播')
      .setEmoji('🎲')
      .setStyle(isRandomPlay ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
}

async function updateControlPanel(guildId, channel) {
  // 循環 / 隨機連播 / 佇列變動後都會更新面板，順便排程寫出播放快照
  session.schedule();
  const embed = _buildEmbed(guildId);
  if (!embed) return;
  const row = _buildButtons(guildId);

  const targetChannel = _getNotifyChannel(guildId, channel);

  try {
    const oldMsg = controlMsgs.get(guildId);
    if (oldMsg) {
      try {
        await oldMsg.delete();
      } catch {
        // 舊訊息可能已被使用者手動刪除或找不到，忽略即可
      }
    }

    const newMsg = await targetChannel.send({ embeds: [embed], components: [row] });
    controlMsgs.set(guildId, newMsg);
  } catch (err) {
    logger.error('UnifiedQueue', '更新控制面板失敗:', err);
  }
}

// ════════════════════════════════════════════════════════
//  隨機連播 — 洗牌袋（Shuffle Bag）
// ════════════════════════════════════════════════════════
const shuffleBags = new Map();

function _shuffleArray(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function _generateShuffleBag(files, avoidFilename) {
  const shuffled = _shuffleArray(files);

  if (avoidFilename && shuffled.length > 1 && shuffled[0].filename === avoidFilename) {
    const swapIndex = 1 + Math.floor(Math.random() * (shuffled.length - 1));
    [shuffled[0], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[0]];
  }

  return shuffled;
}

function resetShuffleBag(guildId) {
  shuffleBags.delete(guildId);
}

function _pickRandomLocalTrack(guildId) {
  const engine = _engines.local;
  if (!engine) return null;

  const files = engine.getMusicFiles();
  if (files.length === 0) {
    shuffleBags.delete(guildId);
    return null;
  }

  let state = shuffleBags.get(guildId);

  // 只清掉「已經不存在的檔案」（例如被刪除），不因為「新增檔案」
  // （例如線上歌曲插播後被快取進 data/music/cache）而讓當輪重洗。
  // 新加入的檔案要等這輪 bag 播完、開新一輪時才會被 getMusicFiles() 掃進來。
  if (state) {
    const currentFilenames = new Set(files.map(f => f.filename));
    state.bag = state.bag.filter(f => currentFilenames.has(f.filename));
  }

  if (!state || state.bag.length === 0) {
    const avoidFilename = state?.lastPlayed ?? nowPlaying.get(guildId)?.item?.filename;
    state = {
      bag: _generateShuffleBag(files, avoidFilename),
      lastPlayed: avoidFilename,
    };
    logger.info('UnifiedQueue', `🔀 隨機連播開始新一輪洗牌 (${guildId})，共 ${files.length} 首`);
  }

  const picked = state.bag.shift();
  state.lastPlayed = picked.filename;
  shuffleBags.set(guildId, state);

  return {
    ...picked,
    title: picked.name,
    type: 'local',
  };
}

// ════════════════════════════════════════════════════════
//  【新增】隨機連播中，優先播放使用者手動加入佇列的歌曲
//
//  修正問題：先前 enqueue() 允許在隨機連播模式下把歌塞進 queue，
//  但 Idle / error 分支從不讀取 queue，導致手動點的歌永久卡死、
//  被靜默吞掉，使用者完全不會發現。
//
//  規則：
//  1. 每次要決定「隨機連播的下一首」時，先看 queue 是否有歌。
//  2. 有 → 視為「插播」，優先播放，計入正常播放次數（countPlay: true），
//     並用專屬 embed 提示使用者（避免跟真正的隨機挑選混淆）。
//  3. 沒有 → 才照原本邏輯呼叫 _pickRandomLocalTrack() 隨機挑歌。
// ════════════════════════════════════════════════════════
function _dequeueManualRequest(guildId) {
  const queue = queues.get(guildId) || [];
  if (queue.length === 0) return null;
  const next = queue.shift();
  queues.set(guildId, queue);

  // 插播的若是「本地歌曲」，代表它本來就已經在當輪的洗牌袋裡，
  // 提前把它從 bag 中移除，避免同一輪內被重複挑到、重播第二次。
  // （線上歌曲不在 bag 裡，不受影響；bag 剩餘順序完全不變。）
  if (next?.type === 'local' && next.filename) {
    const state = shuffleBags.get(guildId);
    if (state) {
      const before = state.bag.length;
      state.bag = state.bag.filter(f => f.filename !== next.filename);
      if (state.bag.length !== before) {
        state.lastPlayed = next.filename;
        logger.info('UnifiedQueue', `🔀 插播本地歌「${next.title}」已從本輪洗牌袋移除，避免重播`);
      }
    }
  }

  return next;
}

// ════════════════════════════════════════════════════════
//  核心播放
// ════════════════════════════════════════════════════════
async function _playItem(guildId, item, channel, { silent = false, countPlay = true } = {}) {
  const connection = connections.get(guildId) || getVoiceConnection(guildId);
  if (!connection) {
    logger.error('UnifiedQueue', '無語音連線');
    return;
  }

  const notifyChannel = _getNotifyChannel(guildId, channel);

  const player = createAudioPlayer();

  // ── Idle：播放結束後的邏輯 ───────────────────────────
  player.on(AudioPlayerStatus.Idle, async () => {
    const current = nowPlaying.get(guildId);
    if (!current || current.player !== player) return;

    const loopMode = loopSettings.get(guildId) || 'off';
    const isRandomPlay = randomPlaySettings.get(guildId) || false;
    const sendTo = _getNotifyChannel(guildId, channel);

    // 單曲循環
    if (loopMode === 'one') {
      await _playItem(guildId, item, channel, { silent: true, countPlay: false });
      return;
    }

    // 隨機連播模式
    if (isRandomPlay) {
      // 🆕 優先檢查佇列：使用者手動點的歌不該被隨機邏輯吞掉
      const manualNext = _dequeueManualRequest(guildId);
      if (manualNext) {
        logger.info('UnifiedQueue', `🎵 隨機連播中插播使用者點歌: ${manualNext.title}`);

        const manualEmbed = new EmbedBuilder()
          .setColor(0x1DB954)
          .setTitle('▶️ 正在播放（插播）')
          .setDescription(
            manualNext.type === 'bilibili'
              ? `[${manualNext.title}](${manualNext.url})`
              : `🎧 **${manualNext.title}**`
          )
          .addFields({ name: '提示', value: '此曲播放完畢後將繼續隨機連播', inline: false })
          .setTimestamp();
        if (manualNext.thumbnail) manualEmbed.setThumbnail(manualNext.thumbnail);
        sendTo.send({ embeds: [manualEmbed] }).catch(() => {});

        // 手動點歌視為正常請求，計入播放次數
        await _playItem(guildId, manualNext, channel, { silent: false, countPlay: true });
        await updateControlPanel(guildId, channel);
        return;
      }

      // 佇列沒有手動點歌，才走原本的隨機挑選邏輯
      const next = _pickRandomLocalTrack(guildId);
      if (!next) {
        logger.success('UnifiedQueue', '隨機連播：找不到本地音樂，停止');
        stopAll(guildId);
        sendTo.send('✅ 找不到本地音樂，隨機連播已停止').catch(() => {});
        return;
      }

      const nextEmbed = new EmbedBuilder()
        .setColor(0xFF8C00)
        .setTitle('🎲 隨機連播 — 下一首')
        .setDescription(`🎧 **${next.title}**`)
        .setTimestamp();
      sendTo.send({ embeds: [nextEmbed] }).catch(() => {});

      // 隨機連播播出的曲目不計入播放次數排序
      await _playItem(guildId, next, channel, { silent: false, countPlay: false });
      await updateControlPanel(guildId, channel);
      return;
    }

    const queue = queues.get(guildId) || [];
    const isLoopAll = loopMode === 'all';

    if (isLoopAll) queue.push(item);

    if (queue.length > 0) {
      const next = queue.shift();
      queues.set(guildId, queue);

      if (!isLoopAll) {
        logger.info('UnifiedQueue', `⏭️ 播放下一首: ${next.title}`);

        const nextEmbed = new EmbedBuilder()
          .setColor(0x1DB954)
          .setTitle('⏭️ 正在播放下一首')
          .setDescription(
            next.type === 'bilibili'
              ? `[${next.title}](${next.url})`
              : `🎧 **${next.title}**`
          )
          .addFields({ name: '剩餘佇列', value: `${queue.length} 首`, inline: true });

        if (next.thumbnail) nextEmbed.setThumbnail(next.thumbnail);

        sendTo.send({ embeds: [nextEmbed] }).catch(() => {});
      }

      let countPlay = true;
      if (isLoopAll && next.type === 'local' && next.filename) {
        const seen = getLoopAllCycleSeen(guildId);
        if (seen.has(next.filename)) {
          countPlay = false;
        } else {
          seen.add(next.filename);
        }
      }

      await _playItem(guildId, next, channel, { silent: isLoopAll, countPlay });
      await updateControlPanel(guildId, channel);
    } else {
      logger.success('UnifiedQueue', '播放完畢，佇列為空');
      stopAll(guildId);
      sendTo.send('✅ 所有歌曲播放完畢').catch(() => {});
    }
  });

  // ── 錯誤處理 ─────────────────────────────────────────
  player.on('error', (err) => {
    if (err.message?.includes('aborted') || err.message?.includes('premature close')) return;
    logger.error('UnifiedQueue', `播放器錯誤 (${guildId}):`, err.message);
    const sendTo = _getNotifyChannel(guildId, channel);
    sendTo.send(`❌ 播放 **${item.title}** 時發生錯誤，嘗試跳過...`).catch(() => {});

    const isRandomPlay = randomPlaySettings.get(guildId) || false;
    if (isRandomPlay) {
      // 🆕 錯誤重試時，同樣優先播放使用者手動點的歌
      const manualNext = _dequeueManualRequest(guildId);
      if (manualNext) {
        setTimeout(() => _playItem(guildId, manualNext, channel, { countPlay: true }), 1000);
        return;
      }

      const next = _pickRandomLocalTrack(guildId);
      if (next) {
        setTimeout(() => _playItem(guildId, next, channel, { countPlay: false }), 1000);
      } else {
        stopAll(guildId);
      }
      return;
    }

    const queue = queues.get(guildId) || [];
    if (queue.length > 0) {
      const next = queue.shift();
      queues.set(guildId, queue);
      setTimeout(() => _playItem(guildId, next, channel), 1000);
    } else {
      stopAll(guildId);
    }
  });

  nowPlaying.set(guildId, { player, item });
  session.schedule();

  try {
    if (item.type === 'bilibili') {
      const engine = _engines.bilibili;
      if (!engine) throw new Error('bilibili engine 未注入');
      await engine.playStream(guildId, item, player, { silent });
    } else {
      const engine = _engines.local;
      if (!engine) throw new Error('local engine 未注入');
      await engine.playStream(guildId, item, player, { silent, countPlay });
    }
  } catch (err) {
    logger.error('UnifiedQueue', '引擎啟動失敗:', err.message);
    notifyChannel.send(`❌ 無法播放 **${item.title}**：${err.message}`).catch(() => {});
    nowPlaying.delete(guildId);
    return;
  }

  setMusicPlayer(guildId, player, undefined, silent);

  if (!silent) {
    logger.info('UnifiedQueue', `🎵 開始播放: ${item.title} [${item.type}] (${guildId})`);
  }
}

// ════════════════════════════════════════════════════════
//  停止
// ════════════════════════════════════════════════════════
function stopAll(guildId) {
  const np = nowPlaying.get(guildId);

  // ⚠️ 順序很重要：必須先清空 nowPlaying（以及其他狀態），
  // 再呼叫 player.stop(true)。
  // 因為 stop(true) 會同步觸發 _playItem() 裡註冊的 'Idle' 監聽器，
  // 那個監聽器會用 nowPlaying.get(guildId) 是否還等於當前 player
  // 來判斷「是自然播完該接下一首」還是「已經被外部停止」。
  // 若先呼叫 stop() 才刪 nowPlaying，監聽器會誤判成播完，
  // 因而先接了下一首（隨機/佇列），導致停止鍵要等下一首播完才真的停。
  nowPlaying.delete(guildId);
  queues.delete(guildId);
  loopSettings.delete(guildId);
  controlMsgs.delete(guildId);
  randomPlaySettings.delete(guildId);
  resetShuffleBag(guildId);
  resetLoopAllCycle(guildId);

  if (np) {
    try { np.player.stop(true); } catch {}
  }
  stopMusicLayer(guildId);

  if (_engines.bilibili && typeof _engines.bilibili.clearErrorCount === 'function') {
    _engines.bilibili.clearErrorCount(guildId);
  }
  if (_engines.bilibili && typeof _engines.bilibili.resetYtClient === 'function') {
    _engines.bilibili.resetYtClient(guildId);
  }
  session.schedule();

  logger.info('UnifiedQueue', `⏹️ 停止播放 (${guildId})`);
}

// ════════════════════════════════════════════════════════
//  閒置自動「停止播放但不離開頻道」的共用 onStop callback 產生器
// ════════════════════════════════════════════════════════
function _createPersistentIdleHandler(guildId, fallbackChannel) {
  return (gId, reason) => {
    const wasPlaying = isPlaying(gId);
    const targetChannel = _getNotifyChannel(gId, fallbackChannel);

    if (!wasPlaying) {
      logger.info('UnifiedQueue', `⏭️ 常駐模式閒置觸發 (${gId})：${reason}（原本未在播放，直接略過）`);
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
//  公開：加入佇列 / 立即播放
// ════════════════════════════════════════════════════════
async function enqueue(guildId, item, channel) {
  requestChannels.set(guildId, channel);

  if (nowPlaying.has(guildId)) {
    const queue = queues.get(guildId) || [];
    queue.push(item);
    queues.set(guildId, queue);
    session.schedule();

    // 🆕 若目前是隨機連播模式，補充提示：這首歌會在下一次切歌時優先插播
    const isRandomPlay = randomPlaySettings.get(guildId) || false;
    logger.info('UnifiedQueue', `➕ 加入佇列: ${item.title} (位置 ${queue.length})${isRandomPlay ? '（隨機連播中，將優先插播）' : ''}`);
    return { queued: true, position: queue.length, willInterruptRandom: isRandomPlay };
  } else {
    queues.set(guildId, []);
    await _playItem(guildId, item, channel);
    return { queued: false };
  }
}

// ════════════════════════════════════════════════════════
//  公開：立即隨機播放一首本地音樂（/music randomplay 用）
// ════════════════════════════════════════════════════════
async function playRandomLocal(guildId, channel, { enableContinuous = false } = {}) {
  requestChannels.set(guildId, channel);

  resetShuffleBag(guildId);

  const track = _pickRandomLocalTrack(guildId);
  if (!track) return null;

  queues.set(guildId, []);

  if (enableContinuous) {
    randomPlaySettings.set(guildId, true);
    loopSettings.set(guildId, 'off');
  }

  await _playItem(guildId, track, channel, { countPlay: !enableContinuous });
  return track;
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

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

  startSilenceLayer(guildId);

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
      sendTo?.send('❌ 語音連線已斷開，請重新使用指令播放').catch(() => {});
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

// ════════════════════════════════════════════════════════
//  重啟後恢復播放
// ════════════════════════════════════════════════════════
/**
 * 讀取上次關閉前的播放快照並接續播放。須在線上 / 本地引擎都注入後呼叫。
 * 略過條件：語音頻道已不存在、頻道裡沒有真人、Bot 已在同伺服器的其他頻道（例如 autojoin）。
 * @param {import('discord.js').Client} client
 */
async function resumeSavedSessions(client) {
  let saved;
  try {
    saved = session.takeSavedSessions();
  } catch (err) {
    logger.warn('MusicSession', `讀取播放快照失敗：${err.message}`);
    return 0;
  }

  let resumed = 0;
  for (const s of saved) {
    try {
      const guild = client.guilds.cache.get(s.guildId);
      const voiceChannel = guild && await guild.channels.fetch(s.voiceChannelId).catch(() => null);
      if (!voiceChannel?.isVoiceBased()) continue;
      if (!voiceChannel.members.some(m => !m.user.bot)) continue;
      if (nowPlaying.has(s.guildId)) continue;

      const existing = getVoiceConnection(s.guildId);
      if (existing && existing.joinConfig.channelId !== voiceChannel.id) continue;

      // 原本的點歌頻道找不到時，改用語音頻道內建的文字聊天（後續通知都會送到這裡）
      const savedTextChannel = s.textChannelId
        ? await guild.channels.fetch(s.textChannelId).catch(() => null)
        : null;
      const textChannel = savedTextChannel?.isTextBased() ? savedTextChannel : voiceChannel;

      const connection = await _connectTo({ guild, voiceChannel, textChannel, client });
      if (!connection) continue;

      queues.set(s.guildId, s.queue);
      loopSettings.set(s.guildId, s.loopMode);
      if (s.randomPlay) randomPlaySettings.set(s.guildId, true);

      await _playItem(s.guildId, s.current, textChannel, { countPlay: false });
      if (!nowPlaying.has(s.guildId)) continue;

      resumed++;
      logger.info('MusicSession', `已恢復 ${guild.name} 的播放：${s.current.title}（佇列 ${s.queue.length} 首）`);
      await textChannel.send(`🔄 Bot 重新啟動，已接續播放 **${s.current.title}**（佇列 ${s.queue.length} 首）`).catch(() => {});
      await updateControlPanel(s.guildId, textChannel);
    } catch (err) {
      logger.warn('MusicSession', `恢復 ${s.guildId} 的播放失敗：${err.message}`);
    }
  }
  return resumed;
}

// ════════════════════════════════════════════════════════
//  查詢
// ════════════════════════════════════════════════════════
function isPlaying(guildId) { return nowPlaying.has(guildId); }
function getNowPlaying(guildId) { return nowPlaying.get(guildId)?.item ?? null; }

module.exports = {
  _buildEmbed,
  updateControlPanel,
  stopAll,
  _createPersistentIdleHandler,
  enqueue,
  ensureConnection,
  isPlaying,
  getNowPlaying,
  playRandomLocal,
  resetShuffleBag,
  resumeSavedSessions,
  getRequestChannel,
  adoptExistingConnection,
};