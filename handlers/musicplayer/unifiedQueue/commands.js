// handlers/unifiedQueue/commands.js
// 統一佇列 — Slash Commands 註冊、控制面板按鈕互動、閒置監控管理指令

const { getVoiceConnection } = require('@discordjs/voice');
const {
  EmbedBuilder,
  SlashCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');

const voiceMonitor = require('../voiceActivityMonitor');

const { queues, nowPlaying, loopSettings, connections, activeSearchMessages, randomPlaySettings } = require('./state');
const {
  _buildEmbed,
  updateControlPanel,
  stopAll,
  // _createIdleStopHandler, // 已停用（一般模式），保留註解供之後參考
  _createPersistentIdleHandler,
  ensureConnection,
  playRandomLocal,
} = require('./playback');
const { handlePlay, handleAutocomplete } = require('./search');
const bootSummary = require('../../../utils/bootSummary');

// ════════════════════════════════════════════════════════
//  setupUnifiedCommands
// ════════════════════════════════════════════════════════
function setupUnifiedCommands(client) {
  client.on('interactionCreate', async interaction => {
    if (interaction.isAutocomplete()) {
      handleAutocomplete(interaction);
      return;
    }

    // ── 逾時後的殭屍搜尋按鈕/選單防護 ──────────────────────
    // awaitMessageComponent 逾時後，若使用者仍點擊舊的搜尋元件，
    // 給予明確提示而非讓 Discord 顯示「互動失敗」。
    // 正常情況下，合法時間內的搜尋互動已被 awaitMessageComponent
    // 的 filter 攔截消耗掉，這裡只會接到「逾時後才點擊」的殭屍互動。
    
    const ZOMBIE_BUTTON_PREFIXES = ['srch_', 'pl_', 'lm_'];
    const ZOMBIE_SELECT_IDS      = ['srch_pick', 'lm_pick'];

    if ((interaction.isButton() && ZOMBIE_BUTTON_PREFIXES.some(p => interaction.customId.startsWith(p))) ||
        (interaction.isStringSelectMenu() && ZOMBIE_SELECT_IDS.includes(interaction.customId))) {
      // 若此訊息目前正被 _handleOnlineSearch() 等的 awaitMessageComponent()
      // 合法等待中，就不要搶先 reply()！否則會跟它內部真正要處理選擇結果的
      // selection.update() 搶著 ACK 同一個 interaction，導致對方拿到
      // DiscordAPIError[10062] Unknown interaction。交給那邊的 collector 處理即可。
      if (interaction.message && activeSearchMessages.has(interaction.message.id)) {
        return;
      }
      return interaction.reply({
        content: '⌛ 此選單/按鈕已逾時或已被處理，請重新使用 /play',
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }

    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('uq_')) return;

    const guildId = interaction.guildId;
    const np = nowPlaying.get(guildId);
    if (!np) {
      return interaction.reply({ content: '❌ 目前沒有播放音樂', flags: MessageFlags.Ephemeral });
    }

    // ★ 使用者操作控制面板按鈕，視為頻道仍活躍，重置閒置計時器
    voiceMonitor.touchActivity(guildId);

    try {
      switch (interaction.customId) {
        case 'uq_skip': {
          const queue = queues.get(guildId) || [];
          const loopMode = loopSettings.get(guildId) || 'off';
          const isRandomPlay = randomPlaySettings.get(guildId) || false;

          // 隨機連播模式下，skip 直接觸發 player.stop()，
          // Idle 事件會自動隨機挑下一首
          if (isRandomPlay) {
            np.player.stop();
            await interaction.reply({ content: '⏭️ 跳過，隨機連播下一首', flags: MessageFlags.Ephemeral });
            break;
          }

          // 只有「佇列真的空了」且「循環模式關閉」時才整組停止；
          // 否則交給 player.stop() 觸發 Idle 事件，讓 playback.js 的
          // 循環邏輯（單曲重播 / 列表循環）接手判斷，避免跳過鍵誤殺循環設定
          if (queue.length === 0 && loopMode === 'off') {
            stopAll(guildId);
            await interaction.reply({ content: '⏭️ 已跳過，佇列為空，停止播放', flags: MessageFlags.Ephemeral });
          } else {
            np.player.stop();
            await interaction.reply({ content: '⏭️ 跳過當前歌曲', flags: MessageFlags.Ephemeral });
          }
          break;
        }

        case 'uq_stop':
          stopAll(guildId);
          await interaction.reply({ content: '⏹️ 已停止播放', flags: MessageFlags.Ephemeral });
          break;

        case 'uq_loop_one': {
          // 開啟單曲循環時，關閉隨機連播（互斥）
          randomPlaySettings.set(guildId, false);
          const cur = loopSettings.get(guildId);
          const next = cur === 'one' ? 'off' : 'one';
          loopSettings.set(guildId, next);
          await interaction.reply({
            content: next === 'one' ? '🔂 單曲循環已開啟' : '❌ 循環已關閉',
            flags: MessageFlags.Ephemeral,
          });
          await updateControlPanel(guildId, interaction.channel);
          break;
        }

        case 'uq_loop_all': {
          // 開啟列表循環時，關閉隨機連播（互斥）
          randomPlaySettings.set(guildId, false);
          const cur = loopSettings.get(guildId);
          const next = cur === 'all' ? 'off' : 'all';
          loopSettings.set(guildId, next);
          await interaction.reply({
            content: next === 'all' ? '🔁 列表循環已開啟' : '❌ 循環已關閉',
            flags: MessageFlags.Ephemeral,
          });
          await updateControlPanel(guildId, interaction.channel);
          break;
        }

        case 'uq_random_play': {
          const cur = randomPlaySettings.get(guildId) || false;
          const next = !cur;
          randomPlaySettings.set(guildId, next);

          if (next) {
            // 開啟隨機連播時，關閉其他循環模式（互斥）
            loopSettings.set(guildId, 'off');
            await interaction.reply({
              content: '🎲 隨機連播已開啟，播完當前歌曲後將自動隨機挑選下一首本地音樂',
              flags: MessageFlags.Ephemeral,
            });
          } else {
            await interaction.reply({
              content: '❌ 隨機連播已關閉',
              flags: MessageFlags.Ephemeral,
            });
          }
          await updateControlPanel(guildId, interaction.channel);
          break;
        }

        case 'uq_queue': {
          const queueList = queues.get(guildId) || [];
          const loopMode = loopSettings.get(guildId) || 'off';
          const isRandomPlay = randomPlaySettings.get(guildId) || false;
          let loopText = '❌ 關閉';
          if (loopMode === 'one') loopText = '🔂 單曲循環';
          if (loopMode === 'all') loopText = '🔁 列表循環';
          if (isRandomPlay) loopText = '🎲 隨機連播';

          const embed = new EmbedBuilder()
            .setColor(isRandomPlay ? 0xFF8C00 : 0x1DB954)
            .setTitle('🎵 播放佇列')
            .addFields(
              {
                name: '🎧 正在播放',
                value: np.item.type === 'bilibili'
                  ? `[${np.item.title}](${np.item.url})`
                  : `**${np.item.title}**`,
                inline: false,
              },
              { name: '循環模式', value: loopText, inline: true },
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
              name: '📋 佇列',
              value: listText.length > 1024 ? listText.slice(0, 1021) + '...' : listText,
              inline: false,
            });
          }

          await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
          break;
        }
      }
    } catch (err) {
      console.error('❌ [UnifiedQueue] 按鈕互動錯誤:', err);
      try { await interaction.reply({ content: '❌ 操作失敗', flags: MessageFlags.Ephemeral }); } catch {}
    }
  });

  client.commands.set(playCommand.data.name, playCommand);
  client.commands.set(musicCommand.data.name, musicCommand);

  bootSummary.report('音樂播放 (/play, /music)', 'ok', 'YouTube / Bilibili / 本地音樂佇列已就緒');
}

// ════════════════════════════════════════════════════════
//  /play：獨立頂層指令（依需求維持原樣，不併入 /music）
// ════════════════════════════════════════════════════════
const playCommand = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('播放 Bilibili / YouTube 影片，或本地音訊檔案')
    .addStringOption(opt =>
      opt.setName('input')
        .setDescription('影片網址 或 本地檔名（輸入關鍵字可搜尋；選「全部本地音樂」一次加入所有）')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(opt =>
      opt.setName('shuffle')
        .setDescription('全部加入時的排序方式（單首播放時忽略此選項）')
        .setRequired(false)
        .addChoices(
          { name: '📋 依檔名順序（預設）', value: 'no' },
          { name: '🔀 隨機排序', value: 'yes' },
        )
    ),
  async execute(interaction) {
    return handleMusicPlay(interaction);
  }
};

// ════════════════════════════════════════════════════════
//  /music 單一指令，底下掛 stop / skip / loop / queue /
//  clear / nowplaying / randomplay /
//  local(group: list) / idle(group: enable/disable/status)
//  （play 已依需求拆回獨立的 /play 指令）
// ════════════════════════════════════════════════════════
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
    .addSubcommandGroup(group =>
      group.setName('idle')
        .setDescription('閒置自動離開語音頻道功能（僅管理員可用）')
        .addSubcommand(sub => sub.setName('enable').setDescription('開啟閒置自動離開功能'))
        .addSubcommand(sub => sub.setName('disable').setDescription('關閉閒置自動離開功能'))
        .addSubcommand(sub => sub.setName('status').setDescription('查看目前閒置監控狀態'))
    ),

  async execute(interaction) {
    const sub   = interaction.options.getSubcommand();
    const group = interaction.options.getSubcommandGroup(false);

    if (group === 'local')  return handleMusicLocal(interaction, sub);
    if (group === 'idle')   return handleMusicIdle(interaction, sub);

    switch (sub) {
      case 'stop':         return handleMusicStop(interaction);
      case 'skip':         return handleMusicSkip(interaction);
      case 'loop':         return handleMusicLoop(interaction);
      case 'queue':        return handleMusicQueue(interaction);
      case 'clear':        return handleMusicClear(interaction);
      case 'nowplaying':   return handleMusicNowPlaying(interaction);
      case 'randomplay':   return handleMusicRandomPlay(interaction);
    }
  }
};

// ── /play ──────────────────────────────────────────
async function handleMusicPlay(interaction) {
  await interaction.deferReply();
  const input = interaction.options.getString('input');
  const shuffleOpt = interaction.options.getString('shuffle') ?? 'no';
  await handlePlay(interaction, input, shuffleOpt);
}

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
    const { buildLocalListReply } = require('../localMusicHandler');
    await interaction.reply(buildLocalListReply());
  }
}

// ── /music idle enable / disable / status（管理員專用） ──
async function handleMusicIdle(interaction, sub) {
  // 執行期權限二次檢查（防止管理員在「整合」設定中覆寫了指令權限）
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      content: '❌ 只有管理員可以使用此指令',
      flags: MessageFlags.Ephemeral,
    });
  }

  const guildId = interaction.guildId;

  if (sub === 'status') {
    const enabled = voiceMonitor.isEnabled(guildId);
    return interaction.reply({
      content: `📊 閒置自動離開功能目前狀態：${enabled ? '✅ 開啟' : '❌ 關閉'}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const enable = sub === 'enable';
  voiceMonitor.setEnabled(guildId, enable);

  if (enable) {
    // 若機器人目前已在語音頻道內，立即啟動監控（不需等下次重新連線）
    const connection = connections.get(guildId) || getVoiceConnection(guildId);
    let monitorStarted = false;

    if (connection) {
      const channelId = connection.joinConfig?.channelId;
      const voiceChannel = channelId ? interaction.guild.channels.cache.get(channelId) : null;

      if (voiceChannel) {
        // ★ 本專案目前只使用常駐模式（閒置只停止播放、不離開頻道）。
        //   一般模式（依頻道是否為 TARGET_VOICE_CHANNEL_ID 決定要不要離開頻道）
        //   已停用，保留註解供之後參考：
        //
        // const isTargetChannel = voiceChannel.id === process.env.TARGET_VOICE_CHANNEL_ID;
        // onStop: isTargetChannel
        //   ? _createPersistentIdleHandler(guildId, voiceChannel)
        //   : _createIdleStopHandler(guildId, connection, interaction.channel),

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

module.exports = {
  setupUnifiedCommands,
};