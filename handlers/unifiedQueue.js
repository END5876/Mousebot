// handlers/unifiedQueue.js
// 統一佇列核心 — 整合 bilibili / local 兩種來源到同一個播放佇列

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
  SlashCommandBuilder,
} = require('discord.js');

const { setMusicPlayer, stopMusicLayer, startSilenceLayer } = require('./audioManager');

// ════════════════════════════════════════════════════════
//  引擎注入（由各 handler 在 setup 時呼叫）
// ════════════════════════════════════════════════════════
const _engines = { bilibili: null, local: null };

function registerEngine(type, engine) {
  _engines[type] = engine;
  console.log(`✅ [UnifiedQueue] 引擎已注入: ${type}`);
}

// ════════════════════════════════════════════════════════
//  Guild 狀態
// ════════════════════════════════════════════════════════
const queues       = new Map();
const nowPlaying   = new Map();
const loopSettings = new Map();
const controlMsgs  = new Map();
const connections  = new Map();

// ════════════════════════════════════════════════════════
//  控制面板
// ════════════════════════════════════════════════════════
function _buildEmbed(guildId) {
  const np       = nowPlaying.get(guildId);
  const queue    = queues.get(guildId) || [];
  const loopMode = loopSettings.get(guildId) || 'off';

  if (!np) return null;

  let loopText = '❌ 關閉';
  if (loopMode === 'one') loopText = '🔂 單曲循環';
  if (loopMode === 'all') loopText = '🔁 列表循環';

  const { item } = np;

  const embed = new EmbedBuilder()
    .setColor(0x1DB954)
    .setTitle('🎵 正在播放')
    .setTimestamp()
    .setFooter({ text: '📋 使用下方按鈕控制播放' });

  if (item.type === 'bilibili') {
    embed
      .setDescription(`[${item.title}](${item.url})`)
      .addFields(
        { name: '作者',     value: item.author   || '未知', inline: true },
        { name: '時長',     value: item.duration || '未知', inline: true },
        { name: '循環模式', value: loopText,                inline: true },
        { name: '佇列',     value: `${queue.length} 首`,    inline: true },
      );
    if (item.thumbnail) embed.setThumbnail(item.thumbnail);
  } else {
    embed
      .setDescription(`🎧 **${item.title}**`)
      .addFields(
        { name: '檔案',     value: item.filename,           inline: true },
        { name: '大小',     value: item.fileSize || '未知', inline: true },
        { name: '循環模式', value: loopText,                inline: true },
        { name: '佇列',     value: `${queue.length} 首`,    inline: true },
      );
  }

  return embed;
}

function _buildButtons(guildId) {
  const loopMode = loopSettings.get(guildId) || 'off';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('uq_skip').setLabel('跳過').setEmoji('⏭️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('uq_stop').setLabel('停止').setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('uq_loop_one').setLabel('單曲循環').setEmoji('🔂')
      .setStyle(loopMode === 'one' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('uq_loop_all').setLabel('列表循環').setEmoji('🔁')
      .setStyle(loopMode === 'all' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('uq_queue').setLabel('佇列').setEmoji('📋')
      .setStyle(ButtonStyle.Secondary),
  );
}

async function updateControlPanel(guildId, channel) {
  const embed = _buildEmbed(guildId);
  if (!embed) return;
  const row = _buildButtons(guildId);

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
    const newMsg = await channel.send({ embeds: [embed], components: [row] });
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
  stopMusicLayer(guildId);
  console.log(`⏹️ [UnifiedQueue] 停止播放 (${guildId})`);
}

// ════════════════════════════════════════════════════════
//  核心播放
// ════════════════════════════════════════════════════════
async function _playItem(guildId, item, channel, { silent = false } = {}) {
  const connection = connections.get(guildId) || getVoiceConnection(guildId);
  if (!connection) {
    console.error('❌ [UnifiedQueue] 無語音連線');
    return;
  }

  const player = createAudioPlayer();

  // ── Idle：播放結束後的邏輯 ───────────────────────────
  player.on(AudioPlayerStatus.Idle, async () => {
    const current = nowPlaying.get(guildId);
    if (!current || current.player !== player) return;

    const loopMode = loopSettings.get(guildId) || 'off';

    // 單曲循環：靜默重播，不產生 log
    if (loopMode === 'one') {
      await _playItem(guildId, item, channel, { silent: true });
      return;
    }

    const queue = queues.get(guildId) || [];

    // 列表循環：把播完的放回隊尾
    if (loopMode === 'all') queue.push(item);

    if (queue.length > 0) {
      const next = queue.shift();
      queues.set(guildId, queue);
      console.log(`⏭️ [UnifiedQueue] 播放下一首: ${next.title}`);

      channel.send({ embeds: [
        new EmbedBuilder()
          .setColor(0x1DB954)
          .setTitle('⏭️ 正在播放下一首')
          .setDescription(next.type === 'bilibili'
            ? `[${next.title}](${next.url})`
            : `🎧 **${next.title}**`)
          .addFields({ name: '剩餘佇列', value: `${queue.length} 首`, inline: true })
          .setThumbnail(next.thumbnail || null)
      ]}).catch(() => {});

      await _playItem(guildId, next, channel);
      await updateControlPanel(guildId, channel);

    } else {
      console.log('✅ [UnifiedQueue] 播放完畢，佇列為空');
      stopAll(guildId);
      channel.send('✅ 所有歌曲播放完畢').catch(() => {});
    }
  });

  // ── 錯誤處理 ─────────────────────────────────────────
  player.on('error', (err) => {
    if (err.message?.includes('aborted') || err.message?.includes('premature close')) return;
    console.error(`❌ [UnifiedQueue] 播放器錯誤 (${guildId}):`, err.message);
    channel.send(`❌ 播放 **${item.title}** 時發生錯誤，嘗試跳過...`).catch(() => {});

    const queue = queues.get(guildId) || [];
    if (queue.length > 0) {
      const next = queue.shift();
      queues.set(guildId, queue);
      setTimeout(() => _playItem(guildId, next, channel), 1000);
    } else {
      stopAll(guildId);
    }
  });

  // ── 更新 nowPlaying ───────────────────────────────────
  nowPlaying.set(guildId, { player, item });

  // ── 根據 type 啟動對應引擎 ────────────────────────────
  try {
    if (item.type === 'bilibili') {
      const engine = _engines.bilibili;
      if (!engine) throw new Error('bilibili engine 未注入');
      await engine.playStream(guildId, item, player);
    } else {
      const engine = _engines.local;
      if (!engine) throw new Error('local engine 未注入');
      engine.playStream(guildId, item, player);
    }
  } catch (err) {
    console.error(`❌ [UnifiedQueue] 引擎啟動失敗:`, err.message);
    channel.send(`❌ 無法播放 **${item.title}**：${err.message}`).catch(() => {});
    nowPlaying.delete(guildId);
    return;
  }

  // ── 交給 audioManager 接管 subscribe ─────────────────
  setMusicPlayer(guildId, player);

  // 只有非靜默模式（第一次播放 / 跳到下一首）才印 log
  if (!silent) {
    console.log(`🎵 [UnifiedQueue] 開始播放: ${item.title} [${item.type}] (${guildId})`);
  }
}

// ════════════════════════════════════════════════════════
//  公開：加入佇列 / 立即播放
// ════════════════════════════════════════════════════════
async function enqueue(guildId, item, channel) {
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
//  語音連線管理（共用）
// ════════════════════════════════════════════════════════
async function ensureConnection(interaction) {
  const guildId = interaction.guildId;
  let connection = getVoiceConnection(guildId);

  if (connection) {
    connections.set(guildId, connection);
    return connection;
  }

  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) return null;

  connection = joinVoiceChannel({
    channelId:      voiceChannel.id,
    guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf:       false,
    selfMute:       false,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

  startSilenceLayer(guildId);

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting,  5_000),
      ]);
    } catch {
      console.warn(`⚠️ [UnifiedQueue] 語音連線斷開 (${guildId})`);
      try { connection.destroy(); } catch {}
      stopAll(guildId);
      connections.delete(guildId);
      interaction.channel.send('❌ 語音連線已斷開，請重新使用指令播放').catch(() => {});
    }
  });

  connections.set(guildId, connection);
  return connection;
}

// ════════════════════════════════════════════════════════
//  handlePlay（/play 核心邏輯）
// ════════════════════════════════════════════════════════
async function handlePlay(interaction, input) {
  const guildId = interaction.guildId;

  let connection;
  try {
    connection = await ensureConnection(interaction);
  } catch {
    return interaction.editReply('❌ 加入語音頻道時發生錯誤');
  }
  if (!connection) return interaction.editReply('❌ 你必須先加入語音頻道！');

  const isUrl = (() => { try { new URL(input); return true; } catch { return false; } })();

  let item;

  if (isUrl) {
    const engine = _engines.bilibili;
    if (!engine) return interaction.editReply('❌ 串流引擎未就緒');

    await interaction.editReply({ embeds: [
      new EmbedBuilder().setColor(0x1DB954).setDescription('🔍 正在獲取影片資訊...')
    ]});

    try {
      item = await engine.getInfo(input);
      item.type = 'bilibili';
    } catch (err) {
      return interaction.editReply(`❌ 無法獲取影片資訊：${err.message}`);
    }
  } else {
    const engine = _engines.local;
    if (!engine) return interaction.editReply('❌ 本地音樂引擎未就緒');

    item = engine.getTrackInfo(input);
    if (!item) return interaction.editReply(`❌ 找不到本地音訊檔案：**${input}**`);
    item.type = 'local';
  }

  const result = await enqueue(guildId, item, interaction.channel);

  const descText = item.type === 'bilibili'
    ? `[${item.title}](${item.url})`
    : `🎧 **${item.title}**`;

  const fields = item.type === 'bilibili'
    ? [
        { name: '作者', value: item.author   || '未知', inline: true },
        { name: '時長', value: item.duration || '未知', inline: true },
        ...(result.queued ? [{ name: '佇列位置', value: `第 ${result.position} 首`, inline: true }] : []),
      ]
    : [
        { name: '檔案', value: item.filename,           inline: true },
        { name: '大小', value: item.fileSize || '未知', inline: true },
        ...(result.queued ? [{ name: '佇列位置', value: `第 ${result.position} 首`, inline: true }] : []),
      ];

  // ── 建立回覆 Embed ────────────────────────────────────
  const replyEmbed = new EmbedBuilder()
    .setColor(0x1DB954)
    .setTitle(result.queued ? '➕ 已加入佇列' : '▶️ 開始播放')
    .setDescription(descText)
    .addFields(...fields)
    .setThumbnail(item.thumbnail || null)
    .setTimestamp();

  // setFooter 不可傳空字串，僅在「開始播放」時才加
  if (!result.queued) {
    replyEmbed.setFooter({ text: '使用下方按鈕控制播放' });
  }

  await interaction.editReply({ embeds: [replyEmbed] });
  await updateControlPanel(guildId, interaction.channel);
}

// ════════════════════════════════════════════════════════
//  Autocomplete
// ════════════════════════════════════════════════════════
function handleAutocomplete(interaction) {
  if (interaction.commandName !== 'play') return false;
  const focused = interaction.options.getFocused().toLowerCase();

  if (focused.startsWith('http')) {
    interaction.respond([]).catch(() => {});
    return true;
  }

  const engine = _engines.local;
  if (!engine) { interaction.respond([]).catch(() => {}); return true; }

  const choices = engine.getMusicFiles()
    .filter(f =>
      f.name.toLowerCase().includes(focused) ||
      f.filename.toLowerCase().includes(focused)
    )
    .slice(0, 25)
    .map(f => ({ name: `📁 ${f.name}`, value: f.filename }));

  interaction.respond(choices).catch(() => {});
  return true;
}

// ════════════════════════════════════════════════════════
//  setupUnifiedCommands
// ════════════════════════════════════════════════════════
function setupUnifiedCommands(client) {

  client.on('interactionCreate', async interaction => {
    if (interaction.isAutocomplete()) {
      handleAutocomplete(interaction);
      return;
    }

    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('uq_')) return;

    const guildId = interaction.guildId;
    const np      = nowPlaying.get(guildId);

    if (!np) {
      return interaction.reply({ content: '❌ 目前沒有播放音樂', ephemeral: true });
    }

    try {
      switch (interaction.customId) {

        case 'uq_skip': {
          const queue = queues.get(guildId) || [];
          if (queue.length === 0) {
            stopAll(guildId);
            await interaction.reply({ content: '⏭️ 已跳過，佇列為空，停止播放', ephemeral: true });
          } else {
            np.player.stop();
            await interaction.reply({ content: '⏭️ 跳過當前歌曲', ephemeral: true });
          }
          break;
        }

        case 'uq_stop':
          stopAll(guildId);
          await interaction.reply({ content: '⏹️ 已停止播放', ephemeral: true });
          break;

        case 'uq_loop_one': {
          const cur  = loopSettings.get(guildId);
          const next = cur === 'one' ? 'off' : 'one';
          loopSettings.set(guildId, next);
          await interaction.reply({
            content:   next === 'one' ? '🔂 單曲循環已開啟' : '❌ 循環已關閉',
            ephemeral: true,
          });
          await updateControlPanel(guildId, interaction.channel);
          break;
        }

        case 'uq_loop_all': {
          const cur  = loopSettings.get(guildId);
          const next = cur === 'all' ? 'off' : 'all';
          loopSettings.set(guildId, next);
          await interaction.reply({
            content:   next === 'all' ? '🔁 列表循環已開啟' : '❌ 循環已關閉',
            ephemeral: true,
          });
          await updateControlPanel(guildId, interaction.channel);
          break;
        }

        case 'uq_queue': {
          const queueList = queues.get(guildId) || [];
          const loopMode  = loopSettings.get(guildId) || 'off';
          let loopText = '❌ 關閉';
          if (loopMode === 'one') loopText = '🔂 單曲循環';
          if (loopMode === 'all') loopText = '🔁 列表循環';

          const embed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle('🎵 播放佇列')
            .addFields(
              {
                name:  '🎧 正在播放',
                value: np.item.type === 'bilibili'
                  ? `[${np.item.title}](${np.item.url})`
                  : `**${np.item.title}**`,
                inline: false,
              },
              { name: '循環模式', value: loopText,                 inline: true },
              { name: '佇列數量', value: `${queueList.length} 首`, inline: true },
            )
            .setTimestamp();

          if (queueList.length > 0) {
            const listText = queueList.map((t, i) =>
              t.type === 'bilibili'
                ? `${i + 1}. [${t.title}](${t.url})`
                : `${i + 1}. **${t.title}**`
            ).join('\n');
            embed.addFields({
              name:   '📋 佇列',
              value:  listText.length > 1024 ? listText.slice(0, 1021) + '...' : listText,
              inline: false,
            });
          }

          await interaction.reply({ embeds: [embed], ephemeral: true });
          break;
        }
      }
    } catch (err) {
      console.error('❌ [UnifiedQueue] 按鈕互動錯誤:', err);
      try { await interaction.reply({ content: '❌ 操作失敗', ephemeral: true }); } catch {}
    }
  });

  // ── /play ─────────────────────────────────────────────
  client.commands.set('play', {
    data: new SlashCommandBuilder()
      .setName('play')
      .setDescription('播放 Bilibili / YouTube 影片，或本地音訊檔案')
      .addStringOption(opt =>
        opt.setName('input')
          .setDescription('影片網址 或 本地檔名（輸入關鍵字可搜尋本地檔案）')
          .setRequired(true)
          .setAutocomplete(true)
      ),
    async execute(interaction) {
      await interaction.deferReply();
      await handlePlay(interaction, interaction.options.getString('input'));
    },
  });

  // ── /stop ─────────────────────────────────────────────
  client.commands.set('stop', {
    data: new SlashCommandBuilder()
      .setName('stop')
      .setDescription('停止播放並清空佇列'),
    async execute(interaction) {
      if (!nowPlaying.has(interaction.guildId)) {
        return interaction.reply({ content: '❌ 目前沒有播放音樂', ephemeral: true });
      }
      stopAll(interaction.guildId);
      await interaction.reply({ content: '⏹️ 已停止播放' });
    },
  });

  // ── /skip ─────────────────────────────────────────────
  client.commands.set('skip', {
    data: new SlashCommandBuilder()
      .setName('skip')
      .setDescription('跳過當前歌曲'),
    async execute(interaction) {
      const np = nowPlaying.get(interaction.guildId);
      if (!np) return interaction.reply({ content: '❌ 目前沒有播放音樂', ephemeral: true });

      const queue = queues.get(interaction.guildId) || [];
      if (queue.length === 0) {
        stopAll(interaction.guildId);
        return interaction.reply({ content: '⏭️ 已跳過，佇列為空，停止播放' });
      }
      np.player.stop();
      await interaction.reply({ content: '⏭️ 跳過當前歌曲' });
    },
  });

  // ── /loop ─────────────────────────────────────────────
  client.commands.set('loop', {
    data: new SlashCommandBuilder()
      .setName('loop')
      .setDescription('切換循環模式（關閉 → 單曲 → 列表）'),
    async execute(interaction) {
      const np = nowPlaying.get(interaction.guildId);
      if (!np) return interaction.reply({ content: '❌ 目前沒有播放音樂', ephemeral: true });

      const cur  = loopSettings.get(interaction.guildId) || 'off';
      const next = cur === 'off' ? 'one' : cur === 'one' ? 'all' : 'off';
      loopSettings.set(interaction.guildId, next);

      const loopText    = next === 'one' ? '🔂 單曲循環已開啟' : next === 'all' ? '🔁 列表循環已開啟' : '❌ 循環已關閉';
      const description = next === 'one' ? '當前歌曲將會不斷重複播放' : next === 'all' ? '播放完所有歌曲後將重新開始' : '播放完當前歌曲後繼續播放佇列';

      await interaction.reply({ embeds: [
        new EmbedBuilder()
          .setColor(next === 'off' ? 0xFF0000 : 0x1DB954)
          .setTitle(loopText)
          .setDescription(description)
          .addFields({
            name:  '正在播放',
            value: np.item.type === 'bilibili'
              ? `[${np.item.title}](${np.item.url})`
              : `**${np.item.title}**`,
            inline: false,
          })
          .setTimestamp()
      ]});
      await updateControlPanel(interaction.guildId, interaction.channel);
    },
  });

  // ── /queue ────────────────────────────────────────────
  client.commands.set('queue', {
    data: new SlashCommandBuilder()
      .setName('queue')
      .setDescription('查看播放佇列'),
    async execute(interaction) {
      const np        = nowPlaying.get(interaction.guildId);
      const queueList = queues.get(interaction.guildId) || [];
      const loopMode  = loopSettings.get(interaction.guildId) || 'off';

      if (!np && queueList.length === 0) {
        return interaction.reply({ content: '❌ 目前沒有播放音樂且佇列為空', ephemeral: true });
      }

      let loopText = '❌ 關閉';
      if (loopMode === 'one') loopText = '🔂 單曲循環';
      if (loopMode === 'all') loopText = '🔁 列表循環';

      const embed = new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle('🎵 播放佇列')
        .setTimestamp();

      if (np) {
        embed.addFields({
          name:  '🎧 正在播放',
          value: np.item.type === 'bilibili'
            ? `[${np.item.title}](${np.item.url})\n作者: ${np.item.author || '未知'}`
            : `**${np.item.title}**\n檔案: ${np.item.filename}`,
          inline: false,
        });
      }
      embed.addFields({ name: '循環模式', value: loopText, inline: true });

      if (queueList.length > 0) {
        const listText = queueList.map((t, i) =>
          t.type === 'bilibili'
            ? `${i + 1}. [${t.title}](${t.url})`
            : `${i + 1}. **${t.title}**`
        ).join('\n');
        embed.addFields({
          name:   `📋 佇列 (${queueList.length} 首)`,
          value:  listText.length > 1024 ? listText.slice(0, 1021) + '...' : listText,
          inline: false,
        });
      }

      await interaction.reply({ embeds: [embed] });
    },
  });

  // ── /clear ────────────────────────────────────────────
  client.commands.set('clear', {
    data: new SlashCommandBuilder()
      .setName('clear')
      .setDescription('清空播放佇列'),
    async execute(interaction) {
      const queue = queues.get(interaction.guildId);
      if (!queue || queue.length === 0) {
        return interaction.reply({ content: '❌ 佇列已經是空的', ephemeral: true });
      }
      const count = queue.length;
      queues.set(interaction.guildId, []);
      await interaction.reply({ content: `🗑️ 已清空佇列 (${count} 首)` });
    },
  });

  // ── /nowplaying ───────────────────────────────────────
  client.commands.set('nowplaying', {
    data: new SlashCommandBuilder()
      .setName('nowplaying')
      .setDescription('查看目前播放的詳細資訊'),
    async execute(interaction) {
      const np = nowPlaying.get(interaction.guildId);
      if (!np) return interaction.reply({ content: '❌ 目前沒有播放音樂', ephemeral: true });
      const embed = _buildEmbed(interaction.guildId);
      await interaction.reply({ embeds: [embed] });
    },
  });

  console.log('✅ [UnifiedQueue] 所有 Slash Commands 已載入');
}

// ════════════════════════════════════════════════════════
//  查詢
// ════════════════════════════════════════════════════════
function isPlaying(guildId)     { return nowPlaying.has(guildId); }
function getNowPlaying(guildId) { return nowPlaying.get(guildId)?.item ?? null; }

module.exports = {
  registerEngine,
  setupUnifiedCommands,
  handleAutocomplete,
  enqueue,
  stopAll,
  isPlaying,
  getNowPlaying,
  updateControlPanel,
  ensureConnection,
};