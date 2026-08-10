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

// ════════════════════════════════════════════════════════
//  記錄每個 guild「點歌的頻道」
// ════════════════════════════════════════════════════════
const requestChannels = new Map();

function _getNotifyChannel(guildId, fallbackChannel) {
  return requestChannels.get(guildId) || fallbackChannel;
}

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
    console.error('❌ [UnifiedQueue] 更新控制面板失敗:', err);
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

  const currentFilenames = new Set(files.map(f => f.filename));
  const isStale =
    !state ||
    state.total !== files.length ||
    !state.bag.every(f => currentFilenames.has(f.filename));

  if (isStale || state.bag.length === 0) {
    const avoidFilename = state?.lastPlayed ?? nowPlaying.get(guildId)?.item?.filename;
    state = {
      bag: _generateShuffleBag(files, avoidFilename),
      total: files.length,
      lastPlayed: avoidFilename,
    };
    console.log(`🔀 [UnifiedQueue] 隨機連播開始新一輪洗牌 (${guildId})，共 ${files.length} 首`);
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
  return next;
}

// ════════════════════════════════════════════════════════
//  核心播放
// ════════════════════════════════════════════════════════
async function _playItem(guildId, item, channel, { silent = false, countPlay = true } = {}) {
  const connection = connections.get(guildId) || getVoiceConnection(guildId);
  if (!connection) {
    console.error('❌ [UnifiedQueue] 無語音連線');
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
        console.log(`🎵 [UnifiedQueue] 隨機連播中插播使用者點歌: ${manualNext.title}`);

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
        console.log('✅ [UnifiedQueue] 隨機連播：找不到本地音樂，停止');
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
        console.log(`⏭️ [UnifiedQueue] 播放下一首: ${next.title}`);

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
      console.log('✅ [UnifiedQueue] 播放完畢，佇列為空');
      stopAll(guildId);
      sendTo.send('✅ 所有歌曲播放完畢').catch(() => {});
    }
  });

  // ── 錯誤處理 ─────────────────────────────────────────
  player.on('error', (err) => {
    if (err.message?.includes('aborted') || err.message?.includes('premature close')) return;
    console.error(`❌ [UnifiedQueue] 播放器錯誤 (${guildId}):`, err.message);
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
    console.error('❌ [UnifiedQueue] 引擎啟動失敗:', err.message);
    notifyChannel.send(`❌ 無法播放 **${item.title}**：${err.message}`).catch(() => {});
    nowPlaying.delete(guildId);
    return;
  }

  setMusicPlayer(guildId, player, undefined, silent);

  if (!silent) {
    console.log(`🎵 [UnifiedQueue] 開始播放: ${item.title} [${item.type}] (${guildId})`);
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

  console.log(`⏹️ [UnifiedQueue] 停止播放 (${guildId})`);
}

// ════════════════════════════════════════════════════════
//  閒置自動「停止播放但不離開頻道」的共用 onStop callback 產生器
// ════════════════════════════════════════════════════════
function _createPersistentIdleHandler(guildId, fallbackChannel) {
  return (gId, reason) => {
    const wasPlaying = isPlaying(gId);
    const targetChannel = _getNotifyChannel(gId, fallbackChannel);

    if (!wasPlaying) {
      console.log(`⏭️ [UnifiedQueue] 常駐模式閒置觸發 (${gId})：${reason}（原本未在播放，直接略過）`);
      return;
    }

    stopAll(gId);
    console.log(`⏹️ [UnifiedQueue] 常駐模式閒置觸發 (${gId})：${reason}，已停止播放（Bot 繼續留在頻道）`);

    if (!targetChannel || typeof targetChannel.send !== 'function') {
      console.warn(`⚠️ [UnifiedQueue] 找不到可用的通知頻道 (${gId})，略過閒置通知訊息`);
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

    // 🆕 若目前是隨機連播模式，補充提示：這首歌會在下一次切歌時優先插播
    const isRandomPlay = randomPlaySettings.get(guildId) || false;
    console.log(`➕ [UnifiedQueue] 加入佇列: ${item.title} (位置 ${queue.length})${isRandomPlay ? '（隨機連播中，將優先插播）' : ''}`);
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
  const guildId = interaction.guildId;
  let connection = getVoiceConnection(guildId);

  requestChannels.set(guildId, interaction.channel);

  if (connection) {
    connections.set(guildId, connection);

    const voiceChannelForMonitor = interaction.member?.voice?.channel;
    if (!voiceMonitor.isMonitoring(guildId) && voiceChannelForMonitor) {
      voiceMonitor.startMonitoring({
        guildId,
        connection,
        channel: voiceChannelForMonitor,
        client: interaction.client,
        onStop: _createPersistentIdleHandler(guildId, interaction.channel),
      });
    }

    return connection;
  }

  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) return null;

  connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

  startSilenceLayer(guildId);

  voiceMonitor.startMonitoring({
    guildId,
    connection,
    channel: voiceChannel,
    client: interaction.client,
    onStop: _createPersistentIdleHandler(guildId, interaction.channel),
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      console.warn(`⚠️ [UnifiedQueue] 語音連線斷開 (${guildId})`);
      try { connection.destroy(); } catch {}
      stopAll(guildId);
      voiceMonitor.stopMonitoring(guildId);
      connections.delete(guildId);
      const sendTo = _getNotifyChannel(guildId, interaction.channel);
      sendTo.send('❌ 語音連線已斷開，請重新使用指令播放').catch(() => {});
    }
  });

  connections.set(guildId, connection);
  return connection;
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
};