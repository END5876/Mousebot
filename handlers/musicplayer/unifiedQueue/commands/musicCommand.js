// handlers/musicplayer/unifiedQueue/commands/musicCommand.js
// 職責：/music 單一指令，底下掛 stop / skip / loop / queue / clear /
// nowplaying / randomplay / local(group: list) / idle

const { getVoiceConnection } = require('@discordjs/voice');
const {
  EmbedBuilder,
  SlashCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');

const voiceMonitor = require('../../voiceActivityMonitor');
const { queues, nowPlaying, loopSettings, connections, randomPlaySettings } = require('../state');
const {
  _buildEmbed,
  updateControlPanel,
  stopAll,
  _createPersistentIdleHandler,
  ensureConnection,
  playRandomLocal,
} = require('../playback');

// ── /music stop ──────────────────────────────────────────
async function handleMusicStop(interaction) {
  if (!nowPlaying.has(interaction.guildId)) {
    return interaction.reply({ content: '❌ 目前沒有播放音樂', flags: MessageFlags.Ephemeral });
  }
  stopAll(interaction.guildId);
  await interaction.reply({ content: '⏹️ 已停止播放' });
}

// ── /music skip ──────────────────────────────────────────
async function handleMusicSkip(interaction) {
  const np = nowPlaying.get(interaction.guildId);
  if (!np) return interaction.reply({ content: '❌ 目前沒有播放音樂', flags: MessageFlags.Ephemeral });

  const queue = queues.get(interaction.guildId) || [];
  const loopMode = loopSettings.get(interaction.guildId) || 'off';
  const isRandomPlay = randomPlaySettings.get(interaction.guildId) || false;

  // 隨機連播模式下，skip 直接觸發 player.stop()，Idle 事件自動隨機下一首
  if (isRandomPlay) {
    np.player.stop();
    return interaction.reply({ content: '⏭️ 跳過，隨機連播下一首' });
  }

  // 邏輯與 uq_skip 按鈕保持一致：尊重循環模式，不再無條件停止
  if (queue.length === 0 && loopMode === 'off') {
    stopAll(interaction.guildId);
    return interaction.reply({ content: '⏭️ 已跳過，佇列為空，停止播放' });
  }
  np.player.stop();
  await interaction.reply({ content: '⏭️ 跳過當前歌曲' });
}

// ── /music loop ───────────────────────────────────────────
async function handleMusicLoop(interaction) {
  const np = nowPlaying.get(interaction.guildId);
  if (!np) return interaction.reply({ content: '❌ 目前沒有播放音樂', flags: MessageFlags.Ephemeral });

  // 切換循環模式時，關閉隨機連播（互斥）
  randomPlaySettings.set(interaction.guildId, false);

  const cur = loopSettings.get(interaction.guildId) || 'off';
  const next = cur === 'off' ? 'one' : cur === 'one' ? 'all' : 'off';
  loopSettings.set(interaction.guildId, next);

  const loopText = next === 'one' ? '🔂 單曲循環已開啟' : next === 'all' ? '🔁 列表循環已開啟' : '❌ 循環已關閉';
  const description = next === 'one' ? '當前歌曲將會不斷重複播放' : next === 'all' ? '播放完所有歌曲後將重新開始' : '播放完當前歌曲後繼續播放佇列';

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(next === 'off' ? 0xFF0000 : 0x1DB954)
        .setTitle(loopText)
        .setDescription(description)
        .addFields({
          name: '正在播放',
          value: np.item.type === 'bilibili'
            ? `[${np.item.title}](${np.item.url})`
            : `**${np.item.title}**`,
          inline: false,
        })
        .setTimestamp()
    ]
  });
  await updateControlPanel(interaction.guildId, interaction.channel);
}

// ── /music queue ──────────────────────────────────────────
async function handleMusicQueue(interaction) {
  const np = nowPlaying.get(interaction.guildId);
  const queueList = queues.get(interaction.guildId) || [];
  const loopMode = loopSettings.get(interaction.guildId) || 'off';
  const isRandomPlay = randomPlaySettings.get(interaction.guildId) || false;

  if (!np && queueList.length === 0) {
    return interaction.reply({ content: '❌ 目前沒有播放音樂且佇列為空', flags: MessageFlags.Ephemeral });
  }

  let loopText = '❌ 關閉';
  if (loopMode === 'one') loopText = '🔂 單曲循環';
  if (loopMode === 'all') loopText = '🔁 列表循環';
  if (isRandomPlay) loopText = '🎲 隨機連播';

  const embed = new EmbedBuilder()
    .setColor(isRandomPlay ? 0xFF8C00 : 0x1DB954)
    .setTitle('🎵 播放佇列')
    .setTimestamp();

  if (np) {
    embed.addFields({
      name: '🎧 正在播放',
      value: np.item.type === 'bilibili'
        ? `[${np.item.title}](${np.item.url})\n作者: ${np.item.author || '未知'}`
        : `**${np.item.title}**`,
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
      name: `📋 佇列 (${queueList.length} 首)`,
      value: listText.length > 1024 ? listText.slice(0, 1021) + '...' : listText,
      inline: false,
    });
  }

  await interaction.reply({ embeds: [embed] });
}

// ── /music clear ──────────────────────────────────────────
async function handleMusicClear(interaction) {
  const queue = queues.get(interaction.guildId);
  if (!queue || queue.length === 0) {
    return interaction.reply({ content: '❌ 佇列已經是空的', flags: MessageFlags.Ephemeral });
  }
  const count = queue.length;
  queues.set(interaction.guildId, []);
  await interaction.reply({ content: `🗑️ 已清空佇列 (${count} 首)` });
}

// ── /music nowplaying ─────────────────────────────────────
async function handleMusicNowPlaying(interaction) {
  const np = nowPlaying.get(interaction.guildId);
  if (!np) return interaction.reply({ content: '❌ 目前沒有播放音樂', flags: MessageFlags.Ephemeral });
  const embed = _buildEmbed(interaction.guildId);
  await interaction.reply({ embeds: [embed] });
}

// ── /music randomplay ─────────────────────────────────────
async function handleMusicRandomPlay(interaction) {
  await interaction.deferReply();

  const guildId = interaction.guildId;
  const continuousOpt = interaction.options.getString('continuous') ?? 'no';
  const enableContinuous = continuousOpt === 'yes';

  // 確保語音連線
  let connection;
  try {
    connection = await ensureConnection(interaction);
  } catch {
    return interaction.editReply('❌ 加入語音頻道時發生錯誤');
  }
  if (!connection) return interaction.editReply('❌ 你必須先加入語音頻道！');

  // 若目前正在播放，先停止（隨機播放視為全新開始）
  if (nowPlaying.has(guildId)) {
    stopAll(guildId);
  }

  const track = await playRandomLocal(guildId, interaction.channel, { enableContinuous });

  if (!track) {
    return interaction.editReply('❌ data/music 資料夾內沒有可播放的音訊檔案！');
  }

  const embed = new EmbedBuilder()
    .setColor(enableContinuous ? 0xFF8C00 : 0x1DB954)
    .setTitle(enableContinuous ? '🎲 隨機連播已開始' : '🎲 隨機播放')
    .setDescription(`🎧 **${track.title}**`)
    .addFields(
      {
        name: '模式',
        value: enableContinuous
          ? '🎲 隨機連播（播完後自動隨機下一首，直到手動停止）'
          : '▶️ 單首播放',
        inline: false,
      },
    )
    .setFooter({ text: enableContinuous ? '使用控制面板的「隨機連播」按鈕可隨時關閉' : '使用 /music randomplay continuous:開啟隨機連播 可啟用連播' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
  await updateControlPanel(guildId, interaction.channel);
}

// ── /music local list ─────────────────────────────────────
// 延遲 require 避免與 localMusicHandler.js → unifiedQueue/index.js 形成循環依賴
async function handleMusicLocal(interaction, sub) {
  if (sub === 'list') {
    const { buildLocalListReply } = require('../../localMusicHandler');
    await interaction.reply(buildLocalListReply());
  }
}

// ── /music idle（單一指令版）：enable / disable / status（管理員專用） ──
async function handleMusicIdle(interaction, action) {
  // 執行期權限二次檢查（防止管理員在「整合」設定中覆寫了指令權限）
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      content: '❌ 只有管理員可以使用此指令',
      flags: MessageFlags.Ephemeral,
    });
  }

  const guildId = interaction.guildId;

  if (action === 'status') {
    const enabled = voiceMonitor.isEnabled(guildId);
    return interaction.reply({
      content: `📊 閒置自動離開功能目前狀態：${enabled ? '✅ 開啟' : '❌ 關閉'}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const enable = action === 'enable';
  voiceMonitor.setEnabled(guildId, enable);

  if (enable) {
    // 若機器人目前已在語音頻道內，立即啟動監控（不需等下次重新連線）
    const connection = connections.get(guildId) || getVoiceConnection(guildId);
    let monitorStarted = false;

    if (connection) {
      const channelId = connection.joinConfig?.channelId;
      const voiceChannel = channelId ? interaction.guild.channels.cache.get(channelId) : null;

      if (voiceChannel) {
        voiceMonitor.startMonitoring({
          guildId,
          connection,
          channel: voiceChannel,
          client: interaction.client,
          onStop: _createPersistentIdleHandler(guildId, voiceChannel),
        });
        monitorStarted = true;
      }
    }

    // 誠實反映本次操作是否真的立即生效，避免管理員被誤導
    const statusNote = monitorStarted
      ? '（已立即套用於目前的語音連線）'
      : '（目前機器人不在語音頻道內，將於下次 /play 時套用）';

    await interaction.reply({
      content: `✅ 閒置自動偵測功能已開啟\n${statusNote}\n頻道空 30 分鐘 / 靜音 60 分鐘將自動停止播放（Bot 仍會留在頻道）`,
      flags: MessageFlags.Ephemeral,
    });
  } else {
    // 立即停止當前監控計時器（若有正在跑的）
    voiceMonitor.stopMonitoring(guildId);

    await interaction.reply({
      content: '❌ 閒置自動離開功能已關閉\n（機器人將不再因頻道閒置而自動離開）',
      flags: MessageFlags.Ephemeral,
    });
  }
}

const musicCommand = {
  data: new SlashCommandBuilder()
    .setName('music')
    .setDescription('音樂播放相關功能')
    .addSubcommand(sub => sub.setName('stop').setDescription('停止播放並清空佇列'))
    .addSubcommand(sub => sub.setName('skip').setDescription('跳過當前歌曲'))
    .addSubcommand(sub => sub.setName('loop').setDescription('切換循環模式（關閉 → 單曲 → 列表）'))
    .addSubcommand(sub => sub.setName('queue').setDescription('查看播放佇列'))
    .addSubcommand(sub => sub.setName('clear').setDescription('清空播放佇列'))
    .addSubcommand(sub => sub.setName('nowplaying').setDescription('查看目前播放的詳細資訊'))
    .addSubcommand(sub =>
      sub.setName('randomplay')
        .setDescription('立即隨機播放一首本地音樂，可選擇開啟隨機連播模式')
        .addStringOption(opt =>
          opt.setName('continuous')
            .setDescription('是否開啟隨機連播（播完後自動隨機下一首，直到手動停止）')
            .setRequired(false)
            .addChoices(
              { name: '🎲 開啟隨機連播', value: 'yes' },
              { name: '▶️ 只播一首', value: 'no' },
            )
        )
    )
    .addSubcommandGroup(group =>
      group.setName('local')
        .setDescription('本地音樂功能')
        .addSubcommand(sub =>
          sub.setName('list').setDescription('列出 data/music 資料夾內所有可播放的音訊檔案')
        )
    )
    .addSubcommand(sub =>
      sub.setName('idle')
        .setDescription('管理閒置自動離開功能（僅管理員可用，留空則查看目前狀態）')
        .addStringOption(opt =>
          opt.setName('action')
            .setDescription('選擇操作，留空則查看目前狀態')
            .addChoices(
              { name: '開啟', value: 'enable' },
              { name: '關閉', value: 'disable' },
              { name: '查看狀態', value: 'status' },
            )
        )
    ),

  async execute(interaction) {
    const sub   = interaction.options.getSubcommand();
    const group = interaction.options.getSubcommandGroup(false);

    if (group === 'local')  return handleMusicLocal(interaction, sub);

    switch (sub) {
      case 'stop':         return handleMusicStop(interaction);
      case 'skip':         return handleMusicSkip(interaction);
      case 'loop':         return handleMusicLoop(interaction);
      case 'queue':        return handleMusicQueue(interaction);
      case 'clear':        return handleMusicClear(interaction);
      case 'nowplaying':   return handleMusicNowPlaying(interaction);
      case 'randomplay':   return handleMusicRandomPlay(interaction);
      case 'idle': {
        const action = interaction.options.getString('action') ?? 'status';
        return handleMusicIdle(interaction, action);
      }
    }
  }
};

module.exports = { musicCommand };
