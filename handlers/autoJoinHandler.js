const fs = require('node:fs');
const path = require('node:path');

const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');

const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

const logger = require('../utils/logger');
const bootSummary = require('../utils/bootSummary');
const voiceMonitor = require('./musicplayer/voiceActivityMonitor');

// 延後載入，避免模組載入順序造成耦合。
function getPlaybackModule() {
  return require('./musicplayer/unifiedQueue/playback');
}

const TARGET_CHANNEL_MANAGER_ID = '598054316510806017';
const CHECK_INTERVAL_MS = 10_000;
const STARTUP_DELAY_MS = 3_000;
const CONFIG_PATH = path.join(__dirname, '..', 'data', 'autojoin.json');

// .env 僅作為尚未建立設定檔時的初始預設值。
function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

    return {
      enabled: typeof saved.enabled === 'boolean' ? saved.enabled : true,
      targetChannelId: saved.targetChannelId || null,
      targetGuildId: saved.targetGuildId || null,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('❌ 讀取自動加入設定失敗，改用預設設定:', error);
    }

    return {
      enabled: true,
      targetChannelId: process.env.TARGET_VOICE_CHANNEL_ID || null,
      targetGuildId: null,
    };
  }
}

let config = loadConfig();
let checkInterval = null;
let isJoining = false;
let autoJoinMenuBound = false;

function saveConfig(nextConfig) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });

  const temporaryPath = `${CONFIG_PATH}.tmp`;

  try {
    fs.writeFileSync(
      temporaryPath,
      JSON.stringify(nextConfig, null, 2) + '\n',
      'utf8'
    );
    fs.renameSync(temporaryPath, CONFIG_PATH);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // 暫存檔可能不存在。
    }
    throw error;
  }

  // 寫入成功後才更新記憶體中的設定。
  config = nextConfig;
}

function resolveFallbackTextChannel(guild) {
  const botMember = guild.members.me;

  const canSend = channel =>
    channel?.isTextBased() &&
    !channel.isVoiceBased() &&
    botMember &&
    channel.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages);

  if (canSend(guild.systemChannel)) return guild.systemChannel;

  return guild.channels.cache.find(canSend) || null;
}

function destroyExistingConnection(guildId) {
  try {
    const existing = getVoiceConnection(guildId);

    if (existing) {
      existing.removeAllListeners();
      existing.destroy();
      console.log('🧹 已銷毀舊語音連線');
    }
  } catch (error) {
    console.warn('⚠️ 銷毀舊連線時發生錯誤:', error.message);
  }

  // 舊連線的監聽器已失效，新連線就緒後再啟動。
  voiceMonitor.stopMonitoring(guildId);
}

function startPersistentMonitor(client, channel, connection) {
  const guildId = channel.guild.id;
  const { _createPersistentIdleHandler } = getPlaybackModule();

  voiceMonitor.startMonitoring({
    guildId,
    connection,
    channel,
    client,
    persistent: true,
    onStop: _createPersistentIdleHandler(
      guildId,
      resolveFallbackTextChannel(channel.guild)
    ),
  });
}

async function joinTargetChannel(client) {
  if (isJoining || !config.enabled) return;

  isJoining = true;
  const targetChannelId = config.targetChannelId;

  try {
    if (!targetChannelId) {
      console.warn('⚠️ 尚未設定自動加入的目標語音頻道');
      return;
    }

    const channel = await client.channels
      .fetch(targetChannelId)
      .catch(() => null);

    if (!channel || !channel.isVoiceBased()) {
      console.warn(`⚠️ 找不到目標語音頻道: ${targetChannelId}`);
      return;
    }

    // 等待 Discord API 的期間，管理員可能已變更設定。
    if (!config.enabled || config.targetChannelId !== targetChannelId) return;

    const guildId = channel.guild.id;
    const botMember =
      channel.guild.members.me ||
      await channel.guild.members.fetchMe().catch(() => null);

    if (config.targetGuildId && config.targetGuildId !== guildId) {
      console.warn('⚠️ 目標頻道與儲存的伺服器不一致');
      return;
    }

    const permissions = botMember && channel.permissionsFor(botMember);

    if (!permissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.Connect,
    ])) {
      console.warn(`⚠️ Bot 無權限檢視或加入語音頻道: ${channel.name}`);
      return;
    }

    const existing = getVoiceConnection(guildId);

    if (
      botMember.voice.channelId === targetChannelId &&
      existing?.state.status === VoiceConnectionStatus.Ready
    ) {
      if (!voiceMonitor.isMonitoring(guildId)) {
        startPersistentMonitor(client, channel, existing);
      }
      return;
    }

    logger.debug(
      'AutoJoin',
      `嘗試加入語音頻道: ${channel.name} (${targetChannelId})`
    );

    destroyExistingConnection(guildId);
    await new Promise(resolve => setTimeout(resolve, 500));

    if (!config.enabled || config.targetChannelId !== targetChannelId) return;

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
      console.error('❌ 等待語音連線就緒失敗:', error.message);
      destroyExistingConnection(guildId);
      return;
    }

    if (!config.enabled || config.targetChannelId !== targetChannelId) {
      destroyExistingConnection(guildId);
      return;
    }

    logger.success('AutoJoin', `已加入語音頻道: ${channel.name}`);
    startPersistentMonitor(client, channel, connection);

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (!config.enabled || config.targetChannelId !== targetChannelId) return;

      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (!config.enabled || config.targetChannelId !== targetChannelId) {
          return;
        }

        console.warn('⚠️ 語音連線中斷，5 秒後嘗試重連...');
        destroyExistingConnection(guildId);

        setTimeout(() => {
          if (config.enabled && config.targetChannelId === targetChannelId) {
            joinTargetChannel(client);
          }
        }, 5_000);
      }
    });
  } catch (error) {
    console.error('❌ 自動加入失敗:', error);
  } finally {
    isJoining = false;

    // 若加入期間目標已變更，接著處理新目標。
    if (
      config.enabled &&
      config.targetChannelId &&
      config.targetChannelId !== targetChannelId
    ) {
      setTimeout(() => joinTargetChannel(client), 0);
    }
  }
}

function startAutoJoinCheck(client) {
  if (checkInterval) return;

  checkInterval = setInterval(async () => {
    if (!config.enabled || !config.targetChannelId || isJoining) return;

    try {
      const channel = await client.channels
        .fetch(config.targetChannelId)
        .catch(() => null);

      if (!channel || !channel.isVoiceBased()) return;

      const connection = getVoiceConnection(channel.guild.id);
      const botChannelId = channel.guild.members.me?.voice?.channelId;
      const connectionReady =
        connection?.state.status === VoiceConnectionStatus.Ready;

      if (
        botChannelId !== config.targetChannelId ||
        !connectionReady ||
        !voiceMonitor.isMonitoring(channel.guild.id)
      ) {
        await joinTargetChannel(client);
      }
    } catch (error) {
      console.error('❌ 自動加入檢查失敗:', error);
    }
  }, CHECK_INTERVAL_MS);

  logger.debug(
    'AutoJoin',
    `檢查已啟動（每 ${CHECK_INTERVAL_MS / 1000} 秒）`
  );
}

function stopAutoJoinCheck() {
  if (!checkInterval) return;

  clearInterval(checkInterval);
  checkInterval = null;
  console.log('🛑 自動加入檢查已停止');
}

function buildAutoJoinMenu(userId) {
  const options = [
    new StringSelectMenuOptionBuilder()
      .setLabel('切換自動加入開關')
      .setDescription(
        `目前狀態：${config.enabled ? '✅ 開啟中' : '🛑 已關閉'}`
      )
      .setValue('toggle')
      .setEmoji('🔁'),

    new StringSelectMenuOptionBuilder()
      .setLabel('查看目前狀態')
      .setDescription('顯示開關與目標頻道')
      .setValue('status')
      .setEmoji('📊'),
  ];

  // 只有指定使用者看得到變更頻道選項；實際提交時仍會再次驗證。
  if (userId === TARGET_CHANNEL_MANAGER_ID) {
    options.splice(
      1,
      0,
      new StringSelectMenuOptionBuilder()
        .setLabel('變更目標語音頻道')
        .setDescription('從目前伺服器選擇新的目標頻道')
        .setValue('change_channel')
        .setEmoji('🔊')
    );
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('autojoin_menu')
      .setPlaceholder('請選擇自動加入操作...')
      .addOptions(options)
  );
}

function buildChannelPicker() {
  return new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('autojoin_channel')
      .setPlaceholder('請選擇目標語音頻道...')
      .setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
      .setMinValues(1)
      .setMaxValues(1)
  );
}

async function canManageHere(interaction, client) {
  if (
    !interaction.inGuild() ||
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    return false;
  }

  if (config.targetGuildId) {
    return interaction.guildId === config.targetGuildId;
  }

  // 相容舊版從 .env 指定的頻道：限制在該頻道所屬伺服器操作。
  if (config.targetChannelId) {
    const original = await client.channels
      .fetch(config.targetChannelId)
      .catch(() => null);

    // 舊頻道已失效時，允許管理員進入選單重新設定。
    if (original) return original.guildId === interaction.guildId;
  }

  return true;
}

function setupAutoJoinCommands(client) {
  client.once('clientReady', async () => {
    logger.debug('AutoJoin', 'Bot 就緒，啟動自動加入功能...');

    if (config.enabled) startAutoJoinCheck(client);

    bootSummary.report(
      '自動加入語音頻道',
      config.enabled && config.targetChannelId ? 'ok' : 'off',
      config.targetChannelId
        ? `目標：${config.targetChannelId}；每 ${CHECK_INTERVAL_MS / 1000} 秒檢查`
        : '尚未設定目標頻道，可使用 /autojoin 設定'
    );

    if (config.enabled && config.targetChannelId) {
      setTimeout(() => joinTargetChannel(client), STARTUP_DELAY_MS);
    }
  });

  client.commands.set('autojoin', {
    data: new SlashCommandBuilder()
      .setName('autojoin')
      .setDescription('管理 Bot 自動加入語音頻道功能')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
      if (!await canManageHere(interaction, client)) {
        await interaction.reply({
          content: '⚠️ 只有目標伺服器中具備「管理伺服器」權限的成員可以使用。',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({
        content: '🤖 **自動加入管理** — 請從下方選單選擇操作：',
        components: [buildAutoJoinMenu(interaction.user.id)],
        flags: MessageFlags.Ephemeral,
      });
    },
  });

  if (autoJoinMenuBound) return;
  autoJoinMenuBound = true;

  client.on('interactionCreate', async interaction => {
    if (
      !interaction.isStringSelectMenu() &&
      !interaction.isChannelSelectMenu()
    ) {
      return;
    }

    if (
      interaction.customId !== 'autojoin_menu' &&
      interaction.customId !== 'autojoin_channel'
    ) {
      return;
    }

    try {
      if (!await canManageHere(interaction, client)) {
        await interaction.reply({
          content: '⚠️ 你沒有權限在此伺服器操作自動加入設定。',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const isChangingTarget =
        interaction.customId === 'autojoin_channel' ||
        (
          interaction.customId === 'autojoin_menu' &&
          interaction.values[0] === 'change_channel'
        );

      // 同時檢查「開啟選擇器」與「提交新頻道」，避免繞過選單。
      if (
        isChangingTarget &&
        interaction.user.id !== TARGET_CHANNEL_MANAGER_ID
      ) {
        await interaction.reply({
          content: '⛔ 只有指定使用者可以變更目標語音頻道。',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.isChannelSelectMenu()) {
        await interaction.deferUpdate();

        const channel = await interaction.guild.channels
          .fetch(interaction.values[0])
          .catch(() => null);

        if (
          !channel ||
          ![
            ChannelType.GuildVoice,
            ChannelType.GuildStageVoice,
          ].includes(channel.type)
        ) {
          await interaction.editReply({
            content: '⚠️ 請選擇此伺服器的語音或舞台頻道。',
            components: [buildAutoJoinMenu(interaction.user.id)],
          });
          return;
        }

        const botMember =
          interaction.guild.members.me ||
          await interaction.guild.members.fetchMe().catch(() => null);

        const permissions = botMember && channel.permissionsFor(botMember);

        if (!permissions?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
        ])) {
          await interaction.editReply({
            content: '⚠️ Bot 沒有檢視頻道或連線權限，請先調整頻道權限。',
            components: [buildAutoJoinMenu(interaction.user.id)],
          });
          return;
        }

        const previousChannelId = config.targetChannelId;

        saveConfig({
          ...config,
          targetChannelId: channel.id,
          targetGuildId: interaction.guildId,
        });

        await interaction.editReply({
          content:
            `✅ 目標頻道已設為 <#${channel.id}>` +
            (
              config.enabled
                ? '，正在嘗試加入。'
                : '；自動加入目前為關閉狀態。'
            ),
          components: [buildAutoJoinMenu(interaction.user.id)],
        });

        if (config.enabled && previousChannelId !== channel.id) {
          await joinTargetChannel(client);
        }

        return;
      }

      const selected = interaction.values[0];

      if (selected === 'change_channel') {
        await interaction.update({
          content: '🔊 請選擇 Bot 要常駐的語音頻道：',
          components: [buildChannelPicker()],
        });
        return;
      }

      if (selected === 'toggle') {
        await interaction.deferUpdate();

        saveConfig({ ...config, enabled: !config.enabled });

        if (config.enabled) {
          startAutoJoinCheck(client);
        } else {
          stopAutoJoinCheck();
          // 保留原本行為：關閉自動加入不會立即離開語音頻道。
        }

        await interaction.editReply({
          content: config.enabled
            ? '✅ 自動加入已**開啟**，Bot 將嘗試加入目標頻道。'
            : '🛑 自動加入已**關閉**；Bot 不會因此立即離開語音頻道。',
          components: [buildAutoJoinMenu(interaction.user.id)],
        });

        if (config.enabled) await joinTargetChannel(client);
        return;
      }

      if (selected === 'status') {
        await interaction.update({
          content:
            `📊 **自動加入狀態**\n` +
            `狀態：${config.enabled ? '✅ 開啟中' : '🛑 已關閉'}\n` +
            `目標頻道：${
              config.targetChannelId
                ? `<#${config.targetChannelId}>`
                : '⚠️ 尚未設定'
            }\n` +
            `檢查間隔：每 ${CHECK_INTERVAL_MS / 1000} 秒`,
          components: [buildAutoJoinMenu(interaction.user.id)],
        });
      }
    } catch (error) {
      console.error('❌ 處理自動加入選單失敗:', error);

      const response = {
        content: '❌ 操作失敗；請確認 Bot 有權限寫入設定檔，然後再試一次。',
        components: [buildAutoJoinMenu(interaction.user.id)],
      };

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(response).catch(() => {});
      } else {
        await interaction.reply({
          content: response.content,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
    }
  });
}

module.exports = { setupAutoJoinCommands };