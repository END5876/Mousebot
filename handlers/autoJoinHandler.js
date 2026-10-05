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
const { isOwner } = require('../utils/config');
const voiceMonitor = require('./musicplayer/voiceActivityMonitor');

// 延後載入，避免模組載入順序造成耦合。
function getPlaybackModule() {
  return require('./musicplayer/unifiedQueue/playback');
}

const CHECK_INTERVAL_MS = 10_000;
// 重新部署時，舊行程留下的語音狀態只會殘留約 30～60 秒，啟動後要盡快接手。
const STARTUP_DELAY_MS = 1_000;
const CONFIG_PATH = path.join(__dirname, '..', 'data', 'autojoin.json');

// 建立新連線時等待就緒的時間。
const READY_TIMEOUT_MS = 15_000;
// 用原連線 rejoin 後等待就緒的時間。
const REJOIN_READY_TIMEOUT_MS = 10_000;
// Signalling / Connecting：給 @discordjs/voice 自行恢復的寬限期。
const RECOVERING_GRACE_MS = 20_000;
// Disconnected：除了被移動頻道外幾乎不會自行恢復，寬限期較短。
const DISCONNECTED_GRACE_MS = 5_000;
// 原連線 rejoin 的最大次數；全部失敗後才銷毀並重建。
const MAX_REJOIN_ATTEMPTS = 3;

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
let isReconciling = false;
let rerunRequested = false;
let scheduledCheck = null;
let autoJoinMenuBound = false;
let processGuardsBound = false;
let firstReadyLogged = false;
// 目前由本模組維護連線的伺服器；目標跨伺服器變更時用來清理舊連線。
let managedGuildId = null;
// 已掛上監聽器的連線，避免重複綁定。
const listenedConnections = new WeakSet();
// 目前連線的恢復進度：首次發現異常的時間與已嘗試 rejoin 的次數。
const recovery = { connection: null, since: null, attempts: 0 };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

// Client 層級保護：EventEmitter 發出 'error' 卻沒有監聽器時會直接丟例外，讓程序崩潰。
// （process 層級的 unhandledRejection / uncaughtException 已集中到 utils/processGuards.js）
function bindProcessGuards(client) {
  if (processGuardsBound) return;
  processGuardsBound = true;

  if (client.listenerCount('error') === 0) {
    client.on('error', error => {
      console.error('❌ Discord client 錯誤:', error);
    });
  }

  if (client.listenerCount('shardError') === 0) {
    client.on('shardError', error => {
      console.error('❌ Discord shard 錯誤:', error);
    });
  }
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

/* ------------------------------------------------------------------ */
/* 恢復進度                                                            */
/* ------------------------------------------------------------------ */

function resetRecovery(connection = null) {
  recovery.connection = connection;
  recovery.since = null;
  recovery.attempts = 0;
}

// 記錄連線處於異常狀態，回傳已持續的毫秒數。連線物件更換時自動重新計時。
function markUnhealthy(connection) {
  if (recovery.connection !== connection) resetRecovery(connection);

  recovery.since ??= Date.now();
  return Date.now() - recovery.since;
}

function graceFor(status) {
  return status === VoiceConnectionStatus.Disconnected
    ? DISCONNECTED_GRACE_MS
    : RECOVERING_GRACE_MS;
}

/* ------------------------------------------------------------------ */
/* 連線操作                                                            */
/* ------------------------------------------------------------------ */

// 銷毀是最後手段，且只銷毀「預期中的那一條」連線，
// 避免舊的重試流程誤刪已被取代的新連線。
// announceLeave=false（預設）：只丟棄本地連線物件，不通知 Discord 離開語音頻道，
// 讓機器人在頻道成員名單上不會出現「離開再進來」；隨後的新連線會直接接手。
// announceLeave=true：真的離開（例如目標改到其他伺服器後清理舊伺服器）。
function destroyConnection(guildId, expected, { announceLeave = false } = {}) {
  const current = getVoiceConnection(guildId);

  if (!current || current.state.status === VoiceConnectionStatus.Destroyed) {
    return false;
  }

  if (expected && current !== expected) return false;

  try {
    current.destroy(announceLeave);
    console.log(
      announceLeave
        ? '🧹 已銷毀語音連線並離開頻道'
        : '🧹 已丟棄舊語音連線（未通知 Discord 離開）'
    );
  } catch (error) {
    console.warn('⚠️ 銷毀連線時發生錯誤:', error.message);
  }

  // 舊連線的監控已失效，新連線就緒後再啟動。
  voiceMonitor.stopMonitoring(guildId);
  return true;
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

// 目標已改到其他伺服器，且新伺服器連線已就緒時，才清理舊伺服器的連線。
function settleManagedGuild(guildId) {
  if (managedGuildId && managedGuildId !== guildId) {
    console.log(`🧹 目標已移至其他伺服器，清理舊伺服器 (${managedGuildId}) 的連線`);
    destroyConnection(managedGuildId, undefined, { announceLeave: true });
  }

  managedGuildId = guildId;
}

// 連線確認健康後的收尾：重置恢復進度、清理舊伺服器、補上語音監控。
function adoptConnection(client, channel, connection, { restartMonitor }) {
  const guildId = channel.guild.id;

  resetRecovery();
  settleManagedGuild(guildId);

  if (restartMonitor) voiceMonitor.stopMonitoring(guildId);

  if (!voiceMonitor.isMonitoring(guildId)) {
    startPersistentMonitor(client, channel, connection);
  }
}

// 斷線事件只負責「安排一次檢查」，不直接銷毀或重連。
function scheduleCheck(client, delayMs = 0) {
  if (scheduledCheck) return;

  scheduledCheck = setTimeout(() => {
    scheduledCheck = null;
    ensureConnected(client);
  }, delayMs);
}

function ensureListeners(client, connection, guildId) {
  if (listenedConnections.has(connection)) return;
  listenedConnections.add(connection);

  connection.on('error', error => {
    console.error('❌ 語音連線錯誤:', error?.message || error);
  });

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    // 已被取代的舊連線，不需處理。
    if (getVoiceConnection(guildId) !== connection) return;

    markUnhealthy(connection);
    // 稍晚於寬限期檢查，屆時由 ensureConnected 決定等待、rejoin 或重建。
    scheduleCheck(client, DISCONNECTED_GRACE_MS + 500);
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    // 被本模組或其他模組銷毀時，盡快檢查是否需要重新加入。
    scheduleCheck(client, 1_000);
  });
}

async function establishNewConnection(client, channel) {
  const guildId = channel.guild.id;

  logger.debug(
    'AutoJoin',
    `建立語音連線: ${channel.name} (${channel.id})`
  );

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  ensureListeners(client, connection, guildId);
  markUnhealthy(connection);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
  } catch (error) {
    // 不立刻銷毀：交給恢復流程（等待 → rejoin → 最後才重建）。
    console.error('❌ 等待語音連線就緒失敗:', error.message);
    return;
  }

  // 等待期間目標已變更：交給下一輪處理。
  if (config.targetChannelId !== channel.id) return;

  adoptConnection(client, channel, connection, { restartMonitor: true });
  logger.success('AutoJoin', `已加入語音頻道: ${channel.name}`);

  // 記錄程序啟動到首次就緒的秒數，用來確認重新部署的接手速度。
  if (!firstReadyLogged) {
    firstReadyLogged = true;
    logger.debug(
      'AutoJoin',
      `程序啟動後 ${process.uptime().toFixed(1)} 秒完成首次語音就緒`
    );
  }
}

/* ------------------------------------------------------------------ */
/* 統一的恢復流程                                                      */
/* ------------------------------------------------------------------ */

// 巡檢、斷線事件、設定變更都走這裡。
// 決策順序：健康 → 不動；換頻道 → 用原連線移動；非 Ready → 等待、rejoin、最後才重建。
async function ensureConnected(client) {
  if (!config.enabled) return;

  if (isReconciling) {
    rerunRequested = true;
    return;
  }

  isReconciling = true;
  rerunRequested = false;

  const targetChannelId = config.targetChannelId;
  const stillWanted = () =>
    config.enabled && config.targetChannelId === targetChannelId;

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
    if (!stillWanted()) return;

    const guildId = channel.guild.id;

    if (config.targetGuildId && config.targetGuildId !== guildId) {
      console.warn('⚠️ 目標頻道與儲存的伺服器不一致');
      return;
    }

    const connection = getVoiceConnection(guildId);
    const alive =
      Boolean(connection) &&
      connection.state.status !== VoiceConnectionStatus.Destroyed;
    const status = alive ? connection.state.status : null;

    if (alive) ensureListeners(client, connection, guildId);

    // 1. 健康：連線就緒且在目標頻道 → 不動，最多只補上語音監控。
    //    以連線自身狀態為準，不依賴可能暫時缺資料的成員快取。
    if (
      status === VoiceConnectionStatus.Ready &&
      connection.joinConfig.channelId === targetChannelId
    ) {
      adoptConnection(client, channel, connection, { restartMonitor: false });
      return;
    }

    // 以下都需要實際動作，先確認權限。
    const botMember =
      channel.guild.members.me ||
      await channel.guild.members.fetchMe().catch(() => null);

    const permissions = botMember && channel.permissionsFor(botMember);

    if (!permissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.Connect,
    ])) {
      console.warn(`⚠️ Bot 無權限檢視或加入語音頻道: ${channel.name}`);
      return;
    }

    if (!stillWanted()) return;

    // 2. 連線就緒但在其他頻道（同伺服器變更目標、被人移動）→ 用原連線移動，不銷毀。
    if (status === VoiceConnectionStatus.Ready) {
      console.log(`🔀 透過既有連線移動到目標頻道: ${channel.name}`);

      const moved = connection.rejoin({
        channelId: channel.id,
        selfDeaf: false,
        selfMute: false,
      });

      if (!moved) {
        console.warn('⚠️ 無法透過既有連線移動，交由恢復流程處理');
        return;
      }

      // 監控綁定頻道，換頻道後需重新啟動。
      adoptConnection(client, channel, connection, { restartMonitor: true });
      return;
    }

    // 3. 該伺服器沒有存活的連線 → 建立新連線
    //    （跨伺服器變更目標時，舊伺服器的連線在新連線就緒後才清理）。
    if (!alive) {
      resetRecovery();
      await establishNewConnection(client, channel);
      return;
    }

    // 4. 連線存活但非 Ready → 恢復階梯：等待自癒 → 原連線 rejoin → 最後才重建。
    const elapsed = markUnhealthy(connection);
    const grace = graceFor(status);

    if (elapsed < grace) {
      logger.debug(
        'AutoJoin',
        `連線狀態 ${status}，等待自行恢復 (${Math.round(elapsed / 1000)}/${grace / 1000} 秒)`
      );
      return;
    }

    if (recovery.attempts < MAX_REJOIN_ATTEMPTS) {
      recovery.attempts += 1;

      console.warn(
        `⚠️ 語音連線未恢復 (${status})，嘗試以原連線重新加入 ` +
          `(${recovery.attempts}/${MAX_REJOIN_ATTEMPTS})`
      );

      const rejoined = connection.rejoin({
        channelId: channel.id,
        selfDeaf: false,
        selfMute: false,
      });

      if (!rejoined) return;

      try {
        await entersState(
          connection,
          VoiceConnectionStatus.Ready,
          REJOIN_READY_TIMEOUT_MS
        );
      } catch (error) {
        console.warn('⚠️ 原連線重新加入後仍未就緒:', error.message);
        return;
      }

      if (config.targetChannelId === channel.id) {
        adoptConnection(client, channel, connection, { restartMonitor: false });
        logger.success('AutoJoin', `原連線已恢復: ${channel.name}`);
      }
      return;
    }

    // 最後手段：多次 rejoin 失敗，銷毀並建立新連線。
    console.warn('⚠️ 多次重新加入失敗，銷毀並重建語音連線');

    // 確認要銷毀的仍是這條連線，已被取代就不動。
    if (!destroyConnection(guildId, connection)) return;

    resetRecovery();
    if (!stillWanted()) return;

    await sleep(500);

    // 等待期間可能已有其他流程建立了連線，交給下一輪處理。
    if (!stillWanted() || getVoiceConnection(guildId)) return;

    await establishNewConnection(client, channel);
  } catch (error) {
    console.error('❌ 自動加入失敗:', error);
  } finally {
    isReconciling = false;

    // 執行期間目標已變更，或有新的檢查請求被擋下，接著再跑一輪。
    const targetChanged =
      config.enabled &&
      config.targetChannelId &&
      config.targetChannelId !== targetChannelId;

    if (config.enabled && (targetChanged || rerunRequested)) {
      rerunRequested = false;
      scheduleCheck(client, 0);
    }
  }
}

function startAutoJoinCheck(client) {
  if (checkInterval) return;

  checkInterval = setInterval(() => {
    if (!config.enabled || !config.targetChannelId || isReconciling) return;

    ensureConnected(client);
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
  resetRecovery();
  console.log('🛑 自動加入檢查已停止');
}

/* ------------------------------------------------------------------ */
/* 斜線指令與選單                                                      */
/* ------------------------------------------------------------------ */

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
  if (isOwner(userId)) {
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
  bindProcessGuards(client);

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
      scheduleCheck(client, STARTUP_DELAY_MS);
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
        !isOwner(interaction.user.id)
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
          await ensureConnected(client);
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

        if (config.enabled) await ensureConnected(client);
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
