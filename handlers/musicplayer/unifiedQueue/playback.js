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
//  guildId -> TextChannel
//  這是所有自動通知（下一首 / 播放完畢 / 錯誤 / 閒置停止）唯一
//  應該參考的來源，避免因為觸發事件當下所在的頻道不同
//  （例如語音頻道內建聊天室），導致通知亂跑。
// ════════════════════════════════════════════════════════
const requestChannels = new Map();

/**
 * 取得該 guild 應該發送通知的頻道：
 * 優先使用「點歌時記錄下來的頻道」，
 * 若尚未有任何記錄（極端邊界情況），才 fallback 用當下傳入的 channel。
 */
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
    // local：不顯示副檔名 / 檔案大小
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
    // ★ 永遠刪除舊的控制面板訊息、重新發送新訊息，
    //   確保面板永遠是頻道中「最新一則」訊息、固定顯示在最下面，
    //   不會因為原地 edit() 而被之後送出的其他音樂通知
    //   （例如「下一首」、佇列加入、錯誤訊息等）擠到上面。
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
//  【新增】隨機連播 — 洗牌袋（Shuffle Bag）
//
//  guildId -> {
//    bag: [track, track, ...],   // 本輪尚未播放過的曲目（已洗牌）
//    total: number,              // 建立本輪洗牌袋當下的曲庫總數（用來偵測曲庫異動）
//    lastPlayed: filename,       // 上一次播放的檔名（用來避免跨輪銜接時連續重複）
//  }
//
//  規則：
//  1. 一輪內每首歌只會被抽到一次，播完整輪（bag 清空）才重新洗牌。
//  2. 新一輪洗牌時，若第一首剛好等於上一輪最後一首，會與其他位置互換，
//     避免使用者感覺「同一首歌連續播放兩次」。
//  3. 若偵測到曲庫內容改變（新增/刪除音樂檔案），會捨棄舊袋、重新洗牌，
//     確保新加入的歌曲能被涵蓋進隨機池。
// ════════════════════════════════════════════════════════
const shuffleBags = new Map();

/** Fisher-Yates 洗牌演算法（不改動原陣列，回傳新陣列） */
function _shuffleArray(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** 產生新一輪洗牌袋，並盡量避免開頭與上一輪結尾重複 */
function _generateShuffleBag(files, avoidFilename) {
  const shuffled = _shuffleArray(files);

  if (avoidFilename && shuffled.length > 1 && shuffled[0].filename === avoidFilename) {
    const swapIndex = 1 + Math.floor(Math.random() * (shuffled.length - 1));
    [shuffled[0], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[0]];
  }

  return shuffled;
}

/**
 * 【新增】清空指定 guild 的洗牌袋。
 * 供 stopAll() 及外部（例如按鈕切換隨機連播開關的 handler）呼叫，
 * 確保每次「重新開始」隨機連播時都是全新的一輪。
 */
function resetShuffleBag(guildId) {
  shuffleBags.delete(guildId);
}

// ════════════════════════════════════════════════════════
//  隨機挑一首本地音樂（洗牌袋版：整輪不重複）
// ════════════════════════════════════════════════════════
function _pickRandomLocalTrack(guildId) {
  const engine = _engines.local;
  if (!engine) return null;

  const files = engine.getMusicFiles();
  if (files.length === 0) {
    shuffleBags.delete(guildId);
    return null;
  }

  let state = shuffleBags.get(guildId);

  // 偵測曲庫是否異動（新增 / 刪除檔案），若異動則視為過期，重新洗牌
  const currentFilenames = new Set(files.map(f => f.filename));
  const isStale =
    !state ||
    state.total !== files.length ||
    !state.bag.every(f => currentFilenames.has(f.filename));

  // 洗牌袋為空（整輪播完）或已過期 → 重新洗牌，開始新的一輪
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

    // 隨機連播模式：忽略佇列，直接從洗牌袋抽下一首
    if (isRandomPlay) {
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

      // ★ 隨機連播播出的曲目不計入播放次數排序
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

      // 🆕 列表循環時，判斷這首歌本輪是否已經播過（繞圈重播不計入播放次數）
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
      const next = _pickRandomLocalTrack(guildId);
      if (next) {
        // ★ 隨機連播重試也不計入播放次數
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

  // 將 silent 作為第四個參數傳入
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
  if (np) {
    try { np.player.stop(true); } catch {}
  }
  nowPlaying.delete(guildId);
  queues.delete(guildId);
  loopSettings.delete(guildId);
  controlMsgs.delete(guildId);
  randomPlaySettings.delete(guildId);
  resetShuffleBag(guildId); // 【新增】清空洗牌袋，避免殘留上次的播放順序
  stopMusicLayer(guildId);
  resetLoopAllCycle(guildId);

  if (_engines.bilibili && typeof _engines.bilibili.clearErrorCount === 'function') {
    _engines.bilibili.clearErrorCount(guildId);
  }
  // ★ 同時重置 YouTube client 輪替狀態，避免下次播放新影片時延續舊的失敗策略
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
    console.log(`➕ [UnifiedQueue] 加入佇列: ${item.title} (位置 ${queue.length})`);
    return { queued: true, position: queue.length };
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

  // 【新增】手動觸發時視為「重新開始」，清空舊洗牌袋，確保是全新的一輪
  resetShuffleBag(guildId);

  const track = _pickRandomLocalTrack(guildId);
  if (!track) return null;

  // 清空佇列，確保隨機連播模式下不受舊佇列影響
  queues.set(guildId, []);

  if (enableContinuous) {
    randomPlaySettings.set(guildId, true);
    // 關閉其他循環模式，避免衝突
    loopSettings.set(guildId, 'off');
  }

  // ★ 若這是開啟隨機連播模式下播出的起始曲目，同樣不計入播放次數排序
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
  resetShuffleBag, // 【新增匯出】供其他 handler（例如按鈕切換）手動清空洗牌袋
};