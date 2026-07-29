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
    const msg = controlMsgs.get(guildId);
    if (msg) {
      try {
        await msg.edit({ embeds: [embed], components: [row] });
        return;
      } catch {
        // 訊息已被刪除，重新發送
      }
    }
    const newMsg = await targetChannel.send({ embeds: [embed], components: [row] });
    controlMsgs.set(guildId, newMsg);
  } catch (err) {
    console.error('❌ [UnifiedQueue] 更新控制面板失敗:', err);
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
  stopMusicLayer(guildId);
  resetLoopAllCycle(guildId);

  if (_engines.bilibili && typeof _engines.bilibili.clearErrorCount === 'function') {
    _engines.bilibili.clearErrorCount(guildId);
  }
  // ★ 新增：同時重置 YouTube client 輪替狀態，避免下次播放新影片時延續舊的失敗策略
  if (_engines.bilibili && typeof _engines.bilibili.resetYtClient === 'function') {
    _engines.bilibili.resetYtClient(guildId);
  }

  console.log(`⏹️ [UnifiedQueue] 停止播放 (${guildId})`);
}

// ════════════════════════════════════════════════════════
//  閒置自動離開的共用 onStop callback 產生器（已停用，僅保留註解）
//  ※ 本專案目前只使用常駐模式（見下方 _createPersistentIdleHandler），
//    Bot 永遠待在 TARGET_VOICE_CHANNEL_ID，不會因閒置而離開頻道。
//    若之後需要恢復「閒置自動離開頻道」的行為，可以取消下面的註解。
// ════════════════════════════════════════════════════════
// function _createIdleStopHandler(guildId, connection, channel) {
//   return (gId, reason) => {
//     console.log(`🔌 [UnifiedQueue] 閒置自動斷線 (${gId}): ${reason}`);
//     stopAll(gId);
//     try { connection.destroy(); } catch {}
//     connections.delete(gId);
//     channel.send(
//       `⏹️ 已因閒置自動停止播放並離開語音頻道\n📌 原因：${reason}`
//     ).catch(() => {});
//   };
// }

// ════════════════════════════════════════════════════════
//  閒置自動「停止播放但不離開頻道」的共用 onStop callback 產生器
//  （給常駐頻道場景使用，例如 autoJoinHandler 設定了
//    TARGET_VOICE_CHANNEL_ID、Bot 永遠待在頻道內的情況；
//    搭配 voiceMonitor.startMonitoring 的 persistent: true 使用）
//
//  ★ 通知一律優先查 requestChannels（點歌頻道），
//    確保通知永遠回到使用者真正下指令的文字頻道。
// ════════════════════════════════════════════════════════
function _createPersistentIdleHandler(guildId, fallbackChannel) {
  return (gId, reason) => {
    const wasPlaying = isPlaying(gId);
    const targetChannel = _getNotifyChannel(gId, fallbackChannel);

    // 沒有在播放時，直接跳過，不要執行 stopAll() 造成無意義的清理與洗版 log
    if (!wasPlaying) {
      console.log(`⏭️ [UnifiedQueue] 常駐模式閒置觸發 (${gId})：${reason}（原本未在播放，直接略過）`);
      return;
    }

    stopAll(gId);
    console.log(`⏹️ [UnifiedQueue] 常駐模式閒置觸發 (${gId})：${reason}，已停止播放（Bot 繼續留在頻道）`);

    // ★ Bug 修正：fallbackChannel 現在可能因為找不到可用文字頻道而是 null/undefined
    //   （例如 guild 沒有系統頻道、Bot 也沒有任何頻道的發言權限），
    //   加上防呆，避免對 undefined 呼叫 .send() 直接拋出例外。
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
//  隨機挑一首本地音樂（排除當前正在播放的那首）
// ════════════════════════════════════════════════════════
function _pickRandomLocalTrack(guildId) {
  const engine = _engines.local;
  if (!engine) return null;

  const files = engine.getMusicFiles();
  if (files.length === 0) return null;

  // 若有多首，嘗試排除當前曲目，避免連續重複
  const np = nowPlaying.get(guildId);
  const currentFilename = np?.item?.filename;

  let candidates = files;
  if (currentFilename && files.length > 1) {
    candidates = files.filter(f => f.filename !== currentFilename);
  }

  const picked = candidates[Math.floor(Math.random() * candidates.length)];
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

    // 隨機連播模式：忽略佇列，直接隨機挑下一首
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

      // ★ 修改：隨機連播播出的曲目不計入播放次數排序
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
        // ★ 修改：隨機連播重試也不計入播放次數
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
      await engine.playStream(guildId, item, player, { silent, countPlay }); // ★ 補上 await
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
//  公開：加入佇列 / 立即播放
//  ★ 這裡是「點歌動作」發生的地方，記錄下 requestChannels
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
//  ★ 同樣視為一次「點歌」，更新 requestChannels
// ════════════════════════════════════════════════════════
async function playRandomLocal(guildId, channel, { enableContinuous = false } = {}) {
  requestChannels.set(guildId, channel);

  const track = _pickRandomLocalTrack(guildId);
  if (!track) return null;

  // 清空佇列，確保隨機連播模式下不受舊佇列影響
  queues.set(guildId, []);

  if (enableContinuous) {
    randomPlaySettings.set(guildId, true);
    // 關閉其他循環模式，避免衝突
    loopSettings.set(guildId, 'off');
  }

  // ★ 修改：若這是開啟隨機連播模式下播出的起始曲目，同樣不計入播放次數排序
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

  // ── 啟動閒置自動停止監控（常駐模式：只停播放，不離開頻道）───
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
      voiceMonitor.stopMonitoring(guildId); // 真正斷線時才清理閒置監控計時器
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
  // _createIdleStopHandler, // 已停用（一般模式），保留註解供之後參考
  _createPersistentIdleHandler,
  enqueue,
  ensureConnection,
  isPlaying,
  getNowPlaying,
  playRandomLocal,
};