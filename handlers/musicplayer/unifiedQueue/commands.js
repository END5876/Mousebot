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

const { queues, nowPlaying, loopSettings, connections, activeSearchMessages } = require('./state');
const {
  _buildEmbed,
  updateControlPanel,
  stopAll,
  _createIdleStopHandler,
} = require('./playback');
const { handlePlay, handleAutocomplete } = require('./search');

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
    if ((interaction.isButton() && interaction.customId.startsWith('srch_')) ||
        (interaction.isStringSelectMenu() && interaction.customId === 'srch_pick')) {
      // 若此訊息目前正被 _handleOnlineSearch() 的 awaitMessageComponent()
      // 合法等待中，就不要搶先 reply()！否則會跟它內部真正要處理選擇結果的
      // selection.update() 搶著 ACK 同一個 interaction，導致對方拿到
      // DiscordAPIError[10062] Unknown interaction。交給那邊的 collector 處理即可。
      if (interaction.message && activeSearchMessages.has(interaction.message.id)) {
        return;
      }
      return interaction.reply({
        content: '⌛ 此搜尋已逾時或已被處理，請重新使用 /play',
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
          if (queue.length === 0) {
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

        case 'uq_queue': {
          const queueList = queues.get(guildId) || [];
          const loopMode = loopSettings.get(guildId) || 'off';
          let loopText = '❌ 關閉';
          if (loopMode === 'one') loopText = '🔂 單曲循環';
          if (loopMode === 'all') loopText = '🔁 列表循環';

          const embed = new EmbedBuilder()
            .setColor(0x1DB954)
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

  // ── /play ─────────────────────────────────────────────
  client.commands.set('play', {
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
      await interaction.deferReply();
      const input = interaction.options.getString('input');
      const shuffleOpt = interaction.options.getString('shuffle') ?? 'no';
      await handlePlay(interaction, input, shuffleOpt);
    },
  });

  // ── /stop ─────────────────────────────────────────────
  client.commands.set('stop', {
    data: new SlashCommandBuilder()
      .setName('stop')
      .setDescription('停止播放並清空佇列'),
    async execute(interaction) {
      if (!nowPlaying.has(interaction.guildId)) {
        return interaction.reply({ content: '❌ 目前沒有播放音樂', flags: MessageFlags.Ephemeral });
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
      if (!np) return interaction.reply({ content: '❌ 目前沒有播放音樂', flags: MessageFlags.Ephemeral });

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
      if (!np) return interaction.reply({ content: '❌ 目前沒有播放音樂', flags: MessageFlags.Ephemeral });

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
    },
  });

  // ── /queue ────────────────────────────────────────────
  client.commands.set('queue', {
    data: new SlashCommandBuilder()
      .setName('queue')
      .setDescription('查看播放佇列'),
    async execute(interaction) {
      const np = nowPlaying.get(interaction.guildId);
      const queueList = queues.get(interaction.guildId) || [];
      const loopMode = loopSettings.get(interaction.guildId) || 'off';

      if (!np && queueList.length === 0) {
        return interaction.reply({ content: '❌ 目前沒有播放音樂且佇列為空', flags: MessageFlags.Ephemeral });
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
        return interaction.reply({ content: '❌ 佇列已經是空的', flags: MessageFlags.Ephemeral });
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
      if (!np) return interaction.reply({ content: '❌ 目前沒有播放音樂', flags: MessageFlags.Ephemeral });
      const embed = _buildEmbed(interaction.guildId);
      await interaction.reply({ embeds: [embed] });
    },
  });

  // ── /idlemonitor（管理員專用：開關閒置自動離開功能）──────
  client.commands.set('idlemonitor', {
    data: new SlashCommandBuilder()
      .setName('idlemonitor')
      .setDescription('管理閒置自動離開語音頻道功能（僅管理員可用）')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand(sub =>
        sub.setName('enable').setDescription('開啟閒置自動離開功能')
      )
      .addSubcommand(sub =>
        sub.setName('disable').setDescription('關閉閒置自動離開功能')
      )
      .addSubcommand(sub =>
        sub.setName('status').setDescription('查看目前閒置監控狀態')
      ),
    async execute(interaction) {
      // 執行期權限二次檢查（防止管理員在「整合」設定中覆寫了指令權限）
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
          content: '❌ 只有管理員可以使用此指令',
          flags: MessageFlags.Ephemeral,
        });
      }

      const guildId = interaction.guildId;
      const sub = interaction.options.getSubcommand();

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
            voiceMonitor.startMonitoring({
              guildId,
              connection,
              channel: voiceChannel,
              client: interaction.client,
              onStop: _createIdleStopHandler(guildId, connection, interaction.channel),
            });
            monitorStarted = true;
          }
        }

        // 誠實反映本次操作是否真的立即生效，避免管理員被誤導
        const statusNote = monitorStarted
          ? '（已立即套用於目前的語音連線）'
          : '（目前機器人不在語音頻道內，將於下次 /play 時套用）';

        await interaction.reply({
          content: `✅ 閒置自動離開功能已開啟\n${statusNote}\n頻道空 30 分鐘 / 靜音 60 分鐘將自動停止播放並離開`,
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
    },
  });

  console.log('✅ [UnifiedQueue] 所有 Slash Commands 已載入');
}

module.exports = {
  setupUnifiedCommands,
};