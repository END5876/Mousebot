// handlers/notice/noticeHandler.js
// 合併 /steamfree /setsteamchannel /epicfree /setepicchannel
// 為單一 /notify 指令（check / channel），並啟動雙平台的定時輪詢。

const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const logger = require('../../utils/logger');
const { createNoticeService, createPollingLoop } = require('./noticeService');
const bootSummary = require('../../utils/bootSummary');

const steamProvider = require('./steamFreeHandler');
const epicProvider  = require('./epicFreeHandler');

const MAX_GAMES_PER_REPLY = 10;
const CHECK_INTERVAL_MS   = 30 * 60 * 1000; // 30 分鐘檢查一次
const LOG_INTERVAL_MS     = 24 * 60 * 60 * 1000;

// ── 建立各平台的頻道 / 已通知清單服務 ──────────────────────
const steamService = createNoticeService({
  label: steamProvider.label,
  notifiedFileName: steamProvider.notifiedFileName,
  channelFileName: steamProvider.channelFileName,
});

const epicService = createNoticeService({
  label: epicProvider.label,
  notifiedFileName: epicProvider.notifiedFileName,
  channelFileName: epicProvider.channelFileName,
});

// platform 選項 → { provider, service } 對照表
const PLATFORMS = {
  steam: { name: 'Steam', provider: steamProvider, service: steamService },
  epic:  { name: 'Epic',  provider: epicProvider,  service: epicService },
};

// ════════════════════════════════════════════════════════
//  /notify 單一指令，底下掛 check / channel
// ════════════════════════════════════════════════════════
const notifyCommand = {
  data: new SlashCommandBuilder()
    .setName('notify')
    .setDescription('遊戲限免通知相關功能')

    // ── /notify check ──
    .addSubcommand(sub =>
      sub.setName('check')
        .setDescription('立即查詢目前限免遊戲')
        .addStringOption(opt =>
          opt.setName('platform')
            .setDescription('要查詢的平台')
            .setRequired(true)
            .addChoices(
              { name: 'Steam', value: 'steam' },
              { name: 'Epic Games', value: 'epic' },
              { name: '全部', value: 'all' },
            )
        )
    )

    // ── /notify channel ──
    .addSubcommand(sub =>
      sub.setName('channel')
        .setDescription('管理限免通知頻道（僅管理員可用）')
        .addStringOption(opt =>
          opt.setName('platform')
            .setDescription('要設定的平台')
            .setRequired(true)
            .addChoices(
              { name: 'Steam', value: 'steam' },
              { name: 'Epic Games', value: 'epic' },
            )
        )
        .addStringOption(opt =>
          opt.setName('action')
            .setDescription('要執行的操作')
            .setRequired(true)
            .addChoices(
              { name: '➕ 新增頻道', value: 'add' },
              { name: '➖ 移除頻道', value: 'remove' },
              { name: '📋 查看清單', value: 'list' },
              { name: '🗑️ 清除全部', value: 'clear' },
            )
        )
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('選擇頻道（新增/移除時必填）')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'check')   return handleCheck(interaction);
    if (sub === 'channel') return handleChannel(interaction);
  },
};

// ── /notify check ────────────────────────────────────────
async function handleCheck(interaction) {
  const platformOpt = interaction.options.getString('platform');
  const targets = platformOpt === 'all'
    ? [PLATFORMS.steam, PLATFORMS.epic]
    : [PLATFORMS[platformOpt]];

  await interaction.deferReply();

  try {
    let totalFound = 0;

    for (const { name, provider } of targets) {
      // 查詢失敗要明確回報（不能顯示成「沒有限免」），也不影響另一個平台的結果
      let games;
      try {
        games = await provider.getFreeGames();
      } catch {
        await interaction.followUp(`❌ ${name} 查詢失敗，請稍後再試。`);
        continue;
      }
      totalFound += games.length;

      if (games.length === 0) {
        await interaction.followUp(`😔 目前沒有偵測到 ${name} 限免遊戲。`);
        continue;
      }

      const displayGames = games.slice(0, MAX_GAMES_PER_REPLY);
      await interaction.followUp(
        `✅ ${name} 找到 **${games.length}** 款限免遊戲！` +
        (games.length > MAX_GAMES_PER_REPLY ? `（僅顯示前 ${MAX_GAMES_PER_REPLY} 款）` : '')
      );
      for (const game of displayGames) await interaction.followUp(provider.buildMessage(game));
    }

    if (totalFound === 0 && targets.length > 1) {
      // 兩則「沒有偵測到」的訊息已經個別送出，這裡不用再補充
    }
  } catch (err) {
    logger.error('Notify', '/notify check 指令執行失敗:', err.message);
    await interaction.editReply('❌ 查詢時發生錯誤，請稍後再試。').catch(() => {});
  }
}

// ── /notify channel（僅限管理員） ────────────────────────
async function handleChannel(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      content: '❌ 只有管理員可以使用此指令',
      flags: MessageFlags.Ephemeral,
    });
  }

  const platformOpt = interaction.options.getString('platform');
  const action       = interaction.options.getString('action');
  const channel      = interaction.options.getChannel('channel');
  const { name, service } = PLATFORMS[platformOpt];

  // 頻道清單是所有伺服器共用的，指令只能看到 / 清除自己伺服器的頻道（全域檢視在 owner 專用的管理面板）
  const isOwnGuild = (id) => interaction.client.channels.cache.get(id)?.guildId === interaction.guildId;
  const ownChannelIds = () => service.listChannels().filter(isOwnGuild);

  if (action === 'add') {
    if (!channel)
      return interaction.reply({ content: '❌ 請選擇要新增的頻道！', flags: MessageFlags.Ephemeral });

    const added = service.addChannel(channel.id);
    if (!added)
      return interaction.reply({ content: `⚠️ ${channel} 已經在通知清單中了！`, flags: MessageFlags.Ephemeral });

    return interaction.reply({
      content: `✅ 已新增 ${channel} 為 ${name} 限免通知頻道！\n本伺服器共 **${ownChannelIds().length}** 個頻道。`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'remove') {
    if (!channel)
      return interaction.reply({ content: '❌ 請選擇要移除的頻道！', flags: MessageFlags.Ephemeral });

    const removed = service.removeChannel(channel.id);
    if (!removed)
      return interaction.reply({ content: `⚠️ ${channel} 不在通知清單中！`, flags: MessageFlags.Ephemeral });

    return interaction.reply({
      content: `✅ 已將 ${channel} 從通知清單移除！\n本伺服器剩 **${ownChannelIds().length}** 個頻道。`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'list') {
    const ids = ownChannelIds();
    if (ids.length === 0)
      return interaction.reply({ content: `📋 本伺服器目前沒有設定任何 ${name} 通知頻道。`, flags: MessageFlags.Ephemeral });

    const lines = ids.map((id, i) => `${i + 1}. <#${id}> (\`${id}\`)`).join('\n');
    return interaction.reply({
      content: `📋 **${name} 限免通知頻道清單（共 ${ids.length} 個）**\n${lines}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'clear') {
    const count = service.clearChannels(isOwnGuild);
    return interaction.reply({
      content: `🗑️ 已清除本伺服器的 **${count}** 個 ${name} 通知頻道設定。`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

// ════════════════════════════════════════════════════════
//  setupNoticeCommands：註冊 /notify 指令 + 啟動雙平台輪詢
// ════════════════════════════════════════════════════════
function setupNoticeCommands(client) {
  client.commands.set(notifyCommand.data.name, notifyCommand);

  const steamPolling = createPollingLoop({
    client,
    service: steamService,
    getFreeGames: steamProvider.getFreeGames,
    buildMessage: steamProvider.buildMessage,
    idField: steamProvider.idField,
    checkIntervalMs: CHECK_INTERVAL_MS,
    logIntervalMs: LOG_INTERVAL_MS,
  });

  const epicPolling = createPollingLoop({
    client,
    service: epicService,
    getFreeGames: epicProvider.getFreeGames,
    buildMessage: epicProvider.buildMessage,
    idField: epicProvider.idField,
    checkIntervalMs: CHECK_INTERVAL_MS,
    logIntervalMs: LOG_INTERVAL_MS,
  });

  steamPolling.start();
  epicPolling.start();
  // 管理面板的「立即檢查並推播」直接呼叫同一個輪詢（同時只會跑一次，不會重複推播）
  PLATFORMS.steam.polling = steamPolling;
  PLATFORMS.epic.polling = epicPolling;

  const steamCount = steamService.listChannels().length;
  const epicCount  = epicService.listChannels().length;
  const totalCount = steamCount + epicCount;

  bootSummary.report(
    '限免通知 (/notify)',
    totalCount > 0 ? 'ok' : 'off',
    totalCount > 0
      ? `Steam ${steamCount} 頻道、Epic ${epicCount} 頻道`
      : '尚未設定任何通知頻道，用 /notify channel 新增'
  );
}

// PLATFORMS：管理面板直接操作同一份頻道清單（noticeService 的記憶體與檔案才會一致）
module.exports = { setupNoticeCommands, PLATFORMS };
