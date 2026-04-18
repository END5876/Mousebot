// handlers/localMusicHandler.js
const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType
} = require('@discordjs/voice');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder
} = require('discord.js');
const fs   = require('fs');
const path = require('path');

const { setMusicPlayer, stopMusicLayer } = require('./audioManager');

// ── 音樂資料夾路徑 ────────────────────────────────────────
const MUSIC_DIR = path.join(__dirname, '..', 'music');

// ── 支援的音訊格式 ────────────────────────────────────────
const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];

// ── 狀態 Map ─────────────────────────────────────────────
const localPlayers      = new Map(); // guildId -> { player, trackInfo }
const localQueues       = new Map(); // guildId -> trackInfo[]
const localLoopSettings = new Map(); // guildId -> 'off' | 'one' | 'all'
const localControlMsgs  = new Map(); // guildId -> Message

// ════════════════════════════════════════════════════════
//  工具函式
// ════════════════════════════════════════════════════════

/**
 * 讀取 music 資料夾內所有支援的音訊檔案
 * @returns {{ name: string, filename: string, filePath: string }[]}
 */
function getMusicFiles() {
  try {
    if (!fs.existsSync(MUSIC_DIR)) {
      console.warn('⚠️ music 資料夾不存在，嘗試建立...');
      fs.mkdirSync(MUSIC_DIR, { recursive: true });
      return [];
    }

    return fs.readdirSync(MUSIC_DIR)
      .filter(file => SUPPORTED_EXTENSIONS.includes(path.extname(file).toLowerCase()))
      .map(file => ({
        name:     path.basename(file, path.extname(file)), // 不含副檔名的顯示名稱
        filename: file,                                     // 完整檔名
        filePath: path.join(MUSIC_DIR, file)               // 完整路徑
      }));
  } catch (err) {
    console.error('❌ 讀取 music 資料夾失敗:', err);
    return [];
  }
}

/**
 * 格式化秒數為 mm:ss 或 hh:mm:ss
 */
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '未知';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 取得檔案大小（MB）
 */
function getFileSize(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return (stat.size / 1024 / 1024).toFixed(2) + ' MB';
  } catch {
    return '未知';
  }
}

// ════════════════════════════════════════════════════════
//  控制面板（按鈕 + Embed）
// ════════════════════════════════════════════════════════

function createLocalControlButtons(guildId) {
  const loopMode = localLoopSettings.get(guildId) || 'off';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('local_skip')
      .setLabel('跳過').setEmoji('⏭️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('local_stop')
      .setLabel('停止').setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('local_loop_one')
      .setLabel('單曲循環').setEmoji('🔂')
      .setStyle(loopMode === 'one' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('local_loop_all')
      .setLabel('列表循環').setEmoji('🔁')
      .setStyle(loopMode === 'all' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('local_queue')
      .setLabel('佇列').setEmoji('📋')
      .setStyle(ButtonStyle.Secondary)
  );
}

async function updateLocalControlPanel(guildId, channel) {
  const playerData = localPlayers.get(guildId);
  if (!playerData) return;

  const loopMode = localLoopSettings.get(guildId) || 'off';
  const queue    = localQueues.get(guildId) || [];

  let loopText = '❌ 關閉';
  if (loopMode === 'one') loopText = '🔂 單曲循環';
  if (loopMode === 'all') loopText = '🔁 列表循環';

  const { trackInfo } = playerData;

  const embed = new EmbedBuilder()
    .setColor(0x1DB954) // Spotify 綠，區別 Bilibili 藍
    .setTitle('🎵 本地音樂 - 正在播放')
    .setDescription(`🎧 **${trackInfo.name}**`)
    .addFields(
      { name: '檔案',     value: trackInfo.filename,              inline: true },
      { name: '大小',     value: trackInfo.fileSize || '未知',    inline: true },
      { name: '循環模式', value: loopText,                        inline: true },
      { name: '佇列',     value: `${queue.length} 首`,            inline: true }
    )
    .setFooter({ text: '📁 本地音樂播放 • 使用下方按鈕控制' })
    .setTimestamp();

  const row = createLocalControlButtons(guildId);

  try {
    const controlMsg = localControlMsgs.get(guildId);
    if (controlMsg) {
      try {
        await controlMsg.edit({ embeds: [embed], components: [row] });
      } catch {
        // 訊息已被刪除，重新發送
        const newMsg = await channel.send({ embeds: [embed], components: [row] });
        localControlMsgs.set(guildId, newMsg);
      }
    } else {
      const newMsg = await channel.send({ embeds: [embed], components: [row] });
      localControlMsgs.set(guildId, newMsg);
    }
  } catch (err) {
    console.error('❌ 更新本地音樂控制面板失敗:', err);
  }
}

// ════════════════════════════════════════════════════════
//  停止播放
// ════════════════════════════════════════════════════════

function stopLocalAudio(guildId) {
  const playerData = localPlayers.get(guildId);
  if (playerData) {
    try { playerData.player.stop(true); } catch {}
    localPlayers.delete(guildId);
    localQueues.delete(guildId);
    localLoopSettings.delete(guildId);
    localControlMsgs.delete(guildId);
    stopMusicLayer(guildId);
    console.log(`⏹️ 本地音樂停止 (Guild: ${guildId})`);
  }
}

// ════════════════════════════════════════════════════════
//  核心播放邏輯
// ════════════════════════════════════════════════════════

async function playLocalAudio(guildId, connection, trackInfo, channel) {
  // 確認檔案存在
  if (!fs.existsSync(trackInfo.filePath)) {
    channel.send(`❌ 找不到音訊檔案：**${trackInfo.filename}**`).catch(() => {});
    // 嘗試播放下一首
    const queue = localQueues.get(guildId) || [];
    if (queue.length > 0) {
      const next = queue.shift();
      localQueues.set(guildId, queue);
      await playLocalAudio(guildId, connection, next, channel);
    } else {
      stopLocalAudio(guildId);
    }
    return;
  }

  const player  = createAudioPlayer();
  const resource = createAudioResource(trackInfo.filePath, {
    inputType:    StreamType.Arbitrary,
    inlineVolume: true,
  });
  resource.volume.setVolume(0.5);

  // ── 播放結束後的邏輯 ──────────────────────────────────
  player.on(AudioPlayerStatus.Idle, async () => {
    if (!localPlayers.has(guildId)) return;

    const loopMode = localLoopSettings.get(guildId) || 'off';

    // 單曲循環
    if (loopMode === 'one') {
      console.log(`🔂 單曲循環: ${trackInfo.name}`);
      channel.send({ embeds: [
        new EmbedBuilder()
          .setColor(0x1DB954)
          .setTitle('🔂 單曲循環')
          .setDescription(`🎧 **${trackInfo.name}**`)
      ]}).catch(() => {});
      await playLocalAudio(guildId, connection, trackInfo, channel);
      return;
    }

    const queue = localQueues.get(guildId) || [];

    if (queue.length > 0) {
      // 列表循環：把播放完的歌放回隊尾
      if (loopMode === 'all') {
        queue.push(trackInfo);
      }

      const nextTrack = queue.shift();
      localQueues.set(guildId, queue);

      console.log(`⏭️ 播放下一首: ${nextTrack.name}`);
      channel.send({ embeds: [
        new EmbedBuilder()
          .setColor(0x1DB954)
          .setTitle('⏭️ 正在播放下一首')
          .setDescription(`🎧 **${nextTrack.name}**`)
          .addFields(
            { name: '檔案',     value: nextTrack.filename,         inline: true },
            { name: '剩餘佇列', value: `${queue.length} 首`,       inline: true }
          )
      ]}).catch(() => {});

      await playLocalAudio(guildId, connection, nextTrack, channel);
      await updateLocalControlPanel(guildId, channel);

    } else {
      // 列表循環但佇列空了（代表只有一首）
      if (loopMode === 'all') {
        await playLocalAudio(guildId, connection, trackInfo, channel);
        return;
      }
      console.log('✅ 本地音樂播放完畢');
      stopLocalAudio(guildId);
      channel.send('✅ 所有本地音樂播放完畢').catch(() => {});
    }
  });

  // ── 播放器錯誤處理 ────────────────────────────────────
  player.on('error', (err) => {
    console.error(`❌ 本地音樂播放器錯誤 (Guild: ${guildId}):`, err.message);
    channel.send(`❌ 播放 **${trackInfo.name}** 時發生錯誤，嘗試跳過...`).catch(() => {});

    const queue = localQueues.get(guildId) || [];
    if (queue.length > 0) {
      const next = queue.shift();
      localQueues.set(guildId, queue);
      setTimeout(() => playLocalAudio(guildId, connection, next, channel), 1000);
    } else {
      stopLocalAudio(guildId);
    }
  });

  // ── 更新狀態並開始播放 ────────────────────────────────
  localPlayers.set(guildId, { player, trackInfo });
  player.play(resource);

  // 透過 audioManager 接管 subscribe，與 TTS / 靜音層相容
  setMusicPlayer(guildId, player);

  console.log(`🎵 本地音樂播放: ${trackInfo.name} (Guild: ${guildId})`);
}

// ════════════════════════════════════════════════════════
//  Slash Command 播放邏輯
// ════════════════════════════════════════════════════════

async function handleLocalPlay(interaction, filename) {
  const guildId    = interaction.guildId;
  const musicFiles = getMusicFiles();

  // 找到對應的音訊檔案
  const trackInfo = musicFiles.find(f => f.filename === filename);
  if (!trackInfo) {
    return interaction.editReply(`❌ 找不到音訊檔案：**${filename}**\n請確認 music 資料夾內有此檔案。`);
  }

  // 補充檔案大小
  trackInfo.fileSize = getFileSize(trackInfo.filePath);

  // ── 取得或建立語音連線 ────────────────────────────────
  let connection = getVoiceConnection(guildId);

  if (!connection) {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.editReply('❌ 你必須先加入語音頻道！');
    }

    try {
      connection = joinVoiceChannel({
        channelId:      voiceChannel.id,
        guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf:       false,
        selfMute:       false,
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

      // 斷線自動重連
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          try { connection.destroy(); } catch {}
          stopLocalAudio(guildId);
          interaction.channel.send('❌ 語音連線已斷開，請重新使用指令播放').catch(() => {});
        }
      });

    } catch (err) {
      console.error('❌ 加入語音頻道失敗:', err);
      return interaction.editReply('❌ 加入語音頻道時發生錯誤');
    }
  }

  // ── 已有播放中 → 加入佇列 ─────────────────────────────
  if (localPlayers.has(guildId)) {
    const queue = localQueues.get(guildId) || [];
    queue.push(trackInfo);
    localQueues.set(guildId, queue);

    await interaction.editReply({ embeds: [
      new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle('➕ 已加入本地音樂佇列')
        .setDescription(`🎧 **${trackInfo.name}**`)
        .addFields(
          { name: '檔案',     value: trackInfo.filename,        inline: true },
          { name: '大小',     value: trackInfo.fileSize,        inline: true },
          { name: '佇列位置', value: `第 ${queue.length} 首`,   inline: true }
        )
        .setTimestamp()
    ]});
    await updateLocalControlPanel(guildId, interaction.channel);
    return;
  }

  // ── 直接播放 ──────────────────────────────────────────
  await playLocalAudio(guildId, connection, trackInfo, interaction.channel);

  await interaction.editReply({ embeds: [
    new EmbedBuilder()
      .setColor(0x1DB954)
      .setTitle('▶️ 開始播放本地音樂')
      .setDescription(`🎧 **${trackInfo.name}**`)
      .addFields(
        { name: '檔案', value: trackInfo.filename, inline: true },
        { name: '大小', value: trackInfo.fileSize,  inline: true }
      )
      .setFooter({ text: '使用下方按鈕控制播放' })
      .setTimestamp()
  ]});

  await updateLocalControlPanel(guildId, interaction.channel);
}

// ════════════════════════════════════════════════════════
//  setupLocalMusicCommands
// ════════════════════════════════════════════════════════

function setupLocalMusicCommands(client) {

  // ── 按鈕互動（local_ 前綴）───────────────────────────
  client.on('interactionCreate', async interaction => {
    // ── Autocomplete 處理 ─────────────────────────────
    if (interaction.isAutocomplete()) {
      if (interaction.commandName !== 'localplay') return;

      const focused     = interaction.options.getFocused().toLowerCase();
      const musicFiles  = getMusicFiles();

      const choices = musicFiles
        .filter(f => f.name.toLowerCase().includes(focused) || f.filename.toLowerCase().includes(focused))
        .slice(0, 25) // Discord 最多 25 個選項
        .map(f => ({ name: f.name, value: f.filename }));

      await interaction.respond(choices).catch(() => {});
      return;
    }

    // ── 按鈕互動 ──────────────────────────────────────
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('local_')) return;

    const guildId    = interaction.guildId;
    const playerData = localPlayers.get(guildId);

    if (!playerData) {
      return interaction.reply({ content: '❌ 目前沒有播放本地音樂', ephemeral: true });
    }

    try {
      switch (interaction.customId) {

        case 'local_skip': {
          const queue = localQueues.get(guildId) || [];
          if (queue.length === 0) {
            stopLocalAudio(guildId);
            await interaction.reply({ content: '⏭️ 已跳過，佇列為空，停止播放', ephemeral: true });
          } else {
            playerData.player.stop();
            await interaction.reply({ content: '⏭️ 跳過當前歌曲', ephemeral: true });
          }
          break;
        }

        case 'local_stop':
          stopLocalAudio(guildId);
          await interaction.reply({ content: '⏹️ 已停止本地音樂播放', ephemeral: true });
          break;

        case 'local_loop_one': {
          const cur  = localLoopSettings.get(guildId);
          const next = cur === 'one' ? 'off' : 'one';
          localLoopSettings.set(guildId, next);
          await interaction.reply({
            content:   next === 'one' ? '🔂 單曲循環已開啟' : '❌ 循環已關閉',
            ephemeral: true
          });
          await updateLocalControlPanel(guildId, interaction.channel);
          break;
        }

        case 'local_loop_all': {
          const cur  = localLoopSettings.get(guildId);
          const next = cur === 'all' ? 'off' : 'all';
          localLoopSettings.set(guildId, next);
          await interaction.reply({
            content:   next === 'all' ? '🔁 列表循環已開啟' : '❌ 循環已關閉',
            ephemeral: true
          });
          await updateLocalControlPanel(guildId, interaction.channel);
          break;
        }

        case 'local_queue': {
          const queueList = localQueues.get(guildId) || [];
          const loopMode  = localLoopSettings.get(guildId) || 'off';
          let loopText = '❌ 關閉';
          if (loopMode === 'one') loopText = '🔂 單曲循環';
          if (loopMode === 'all') loopText = '🔁 列表循環';

          const embed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle('🎵 本地音樂佇列')
            .addFields(
              { name: '🎧 正在播放', value: `**${playerData.trackInfo.name}**\n檔案: ${playerData.trackInfo.filename}`, inline: false },
              { name: '循環模式',    value: loopText,                   inline: true },
              { name: '佇列數量',    value: `${queueList.length} 首`,   inline: true }
            )
            .setTimestamp();

          if (queueList.length > 0) {
            const listText = queueList
              .map((t, i) => `${i + 1}. **${t.name}** (${t.filename})`)
              .join('\n');
            embed.addFields({
              name:  '📋 佇列',
              value: listText.length > 1024 ? listText.slice(0, 1021) + '...' : listText,
              inline: false
            });
          }

          await interaction.reply({ embeds: [embed], ephemeral: true });
          break;
        }
      }
    } catch (err) {
      console.error('❌ 本地音樂按鈕互動錯誤:', err);
      try { await interaction.reply({ content: '❌ 操作失敗', ephemeral: true }); } catch {}
    }
  });

  // ── 注入 Slash Commands ───────────────────────────────

  // /localplay - 使用 autocomplete 動態列出音訊檔案
  client.commands.set('localplay', {
    data: new SlashCommandBuilder()
      .setName('localplay')
      .setDescription('播放 music 資料夾內的本地音訊檔案')
      .addStringOption(opt =>
        opt.setName('track')
          .setDescription('選擇要播放的音訊檔案（輸入關鍵字搜尋）')
          .setRequired(true)
          .setAutocomplete(true)
      ),
    async execute(interaction) {
      await interaction.deferReply();
      const filename = interaction.options.getString('track');
      await handleLocalPlay(interaction, filename);
    }
  });

  // /localstop
  client.commands.set('localstop', {
    data: new SlashCommandBuilder()
      .setName('localstop')
      .setDescription('停止本地音樂播放並清空佇列'),
    async execute(interaction) {
      if (!localPlayers.has(interaction.guildId)) {
        return interaction.reply({ content: '❌ 目前沒有播放本地音樂', ephemeral: true });
      }
      stopLocalAudio(interaction.guildId);
      await interaction.reply({ content: '⏹️ 已停止本地音樂播放' });
    }
  });

  // /localskip
  client.commands.set('localskip', {
    data: new SlashCommandBuilder()
      .setName('localskip')
      .setDescription('跳過當前本地音樂'),
    async execute(interaction) {
      const playerData = localPlayers.get(interaction.guildId);
      if (!playerData) {
        return interaction.reply({ content: '❌ 目前沒有播放本地音樂', ephemeral: true });
      }
      const queue = localQueues.get(interaction.guildId) || [];
      if (queue.length === 0) {
        stopLocalAudio(interaction.guildId);
        return interaction.reply({ content: '⏭️ 已跳過，佇列為空，停止播放' });
      }
      playerData.player.stop();
      await interaction.reply({ content: '⏭️ 跳過當前歌曲' });
    }
  });

  // /localqueue
  client.commands.set('localqueue', {
    data: new SlashCommandBuilder()
      .setName('localqueue')
      .setDescription('查看本地音樂播放佇列'),
    async execute(interaction) {
      const playerData = localPlayers.get(interaction.guildId);
      const queue      = localQueues.get(interaction.guildId) || [];
      const loopMode   = localLoopSettings.get(interaction.guildId) || 'off';

      if (!playerData && queue.length === 0) {
        return interaction.reply({ content: '❌ 目前沒有播放本地音樂且佇列為空', ephemeral: true });
      }

      let loopText = '❌ 關閉';
      if (loopMode === 'one') loopText = '🔂 單曲循環';
      if (loopMode === 'all') loopText = '🔁 列表循環';

      const embed = new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle('🎵 本地音樂佇列')
        .setTimestamp();

      if (playerData) {
        embed.addFields({
          name:  '🎧 正在播放',
          value: `**${playerData.trackInfo.name}**\n檔案: ${playerData.trackInfo.filename}`,
          inline: false
        });
      }
      embed.addFields({ name: '循環模式', value: loopText, inline: true });

      if (queue.length > 0) {
        const listText = queue
          .map((t, i) => `${i + 1}. **${t.name}** (${t.filename})`)
          .join('\n');
        embed.addFields({
          name:  `📋 佇列 (${queue.length} 首)`,
          value: listText.length > 1024 ? listText.slice(0, 1021) + '...' : listText,
          inline: false
        });
      }

      await interaction.reply({ embeds: [embed] });
    }
  });

  // /localloop
  client.commands.set('localloop', {
    data: new SlashCommandBuilder()
      .setName('localloop')
      .setDescription('切換本地音樂循環模式（關閉 → 單曲 → 列表）'),
    async execute(interaction) {
      const playerData = localPlayers.get(interaction.guildId);
      if (!playerData) {
        return interaction.reply({ content: '❌ 目前沒有播放本地音樂', ephemeral: true });
      }

      const cur  = localLoopSettings.get(interaction.guildId) || 'off';
      const next = cur === 'off' ? 'one' : cur === 'one' ? 'all' : 'off';
      localLoopSettings.set(interaction.guildId, next);

      const loopText    = next === 'one' ? '🔂 單曲循環已開啟' : next === 'all' ? '🔁 列表循環已開啟' : '❌ 循環已關閉';
      const description = next === 'one' ? '當前歌曲將會不斷重複播放' : next === 'all' ? '播放完所有歌曲後將重新開始' : '播放完當前歌曲後繼續播放佇列';

      await interaction.reply({ embeds: [
        new EmbedBuilder()
          .setColor(next === 'off' ? 0xFF0000 : 0x1DB954)
          .setTitle(loopText)
          .setDescription(description)
          .addFields({
            name:  '正在播放',
            value: `**${playerData.trackInfo.name}**`,
            inline: false
          })
          .setTimestamp()
      ]});
      await updateLocalControlPanel(interaction.guildId, interaction.channel);
    }
  });

  // /locallist - 列出所有可用音訊檔案
  client.commands.set('locallist', {
    data: new SlashCommandBuilder()
      .setName('locallist')
      .setDescription('列出 music 資料夾內所有可播放的音訊檔案'),
    async execute(interaction) {
      const musicFiles = getMusicFiles();

      if (musicFiles.length === 0) {
        return interaction.reply({
          content: '❌ music 資料夾內沒有可播放的音訊檔案\n支援格式：`.mp3` `.wav` `.ogg` `.flac` `.m4a` `.aac`',
          ephemeral: true
        });
      }

      const listText = musicFiles
        .map((f, i) => `${i + 1}. **${f.name}** — \`${f.filename}\` (${getFileSize(f.filePath)})`)
        .join('\n');

      const embed = new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle(`📁 本地音樂清單 (共 ${musicFiles.length} 首)`)
        .setDescription(listText.length > 4096 ? listText.slice(0, 4093) + '...' : listText)
        .setFooter({ text: '使用 /localplay 選擇播放' })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    }
  });

  console.log('✅ 本地音樂 Slash Commands 已載入');
}

function getPlayingLocal(guildId) { return localPlayers.has(guildId); }

module.exports = { setupLocalMusicCommands, stopLocalAudio, getPlayingLocal };