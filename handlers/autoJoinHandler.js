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
  MessageFlags,
} = require('discord.js');
const logger = require('../utils/logger');
const bootSummary = require('../utils/bootSummary');
const voiceMonitor = require('./musicplayer/voiceActivityMonitor');
// 延後在函式內 require playback.js，避免在模組載入順序上造成不必要的耦合
function _getPlaybackModule() {
  return require('./musicplayer/unifiedQueue/playback');
}

// ─── 狀態管理 ───────────────────────────────────────────
let autoJoinEnabled = true;
let checkInterval   = null;
let isJoining       = false;
const CHECK_INTERVAL_MS = 10_000;
const STARTUP_DELAY_MS  = 3_000;

// ─── 防重複註冊 ──────────────────────────────────────────
let autoJoinMenuBound = false;

// ─── 工具：安全銷毀現有連線 ──────────────────────────────
function destroyExistingConnection(guildId) {
  try {
    const existing = getVoiceConnection(guildId);
    if (existing) {
      existing.removeAllListeners();
      existing.destroy();
      console.log('🧹 已銷毀舊語音連線');
    }
  } catch (err) {
    console.warn('⚠️ 銷毀舊連線時發生錯誤（可忽略）:', err.message);
  }
  // 舊連線被銷毀後，掛在它身上的 speaking 監聽器已經失效，
  // 一併停止監控，稍後在新連線建立完成後會重新啟動。
  voiceMonitor.stopMonitoring(guildId);
}

// ─── 加入目標語音頻道 ────────────────────────────────────
async function joinTargetChannel(client) {
  if (isJoining) return;
  isJoining = true;

  const channelId = process.env.TARGET_VOICE_CHANNEL_ID;
  if (!channelId) {
    console.warn('⚠️ TARGET_VOICE_CHANNEL_ID 未設定');
    isJoining = false;
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isVoiceBased()) {
      console.warn(`⚠️ 找不到語音頻道: ${channelId}`);
      isJoining = false;
      return;
    }

    const guildId   = channel.guild.id;
    const botMember = channel.guild.members.me;

    if (botMember?.voice?.channelId === channelId) {
      const existing = getVoiceConnection(guildId);
      if (existing && existing.state.status === VoiceConnectionStatus.Ready) {
        // 已經在目標頻道且連線正常，但仍要確保常駐監控有在跑
        // （例如監控先前被 destroyExistingConnection 清掉、或從未啟動過）。
        if (!voiceMonitor.isMonitoring(guildId)) {
          const { _createPersistentIdleHandler } = _getPlaybackModule();
          voiceMonitor.startMonitoring({
            guildId,
            connection: existing,
            channel,
            client,
            persistent: true,
            onStop: _createPersistentIdleHandler(guildId, channel),
          });
        }
        isJoining = false;
        return;
      }
    }

    logger.debug('AutoJoin', `嘗試加入語音頻道: ${channel.name} (${channelId})`);
    destroyExistingConnection(guildId);
    await new Promise(resolve => setTimeout(resolve, 500));

    const connection = joinVoiceChannel({
      channelId:      channel.id,
      guildId:        channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf:       false,
      selfMute:       false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      logger.success('AutoJoin', `已加入語音頻道: ${channel.name}`);
    } catch (readyErr) {
      console.error('❌ 等待連線就緒失敗:', readyErr.message);
      destroyExistingConnection(guildId);
      isJoining = false;
      return;
    }

    // ── 常駐閒置監控 ─────────────────────────────────────
    // Bot 永遠待在 TARGET_VOICE_CHANNEL_ID，所以用 persistent 模式：
    // 觸發時只停止播放（stopAll），絕不 destroy 連線 / 離開頻道，
    // 監控本身會持續巡檢，供下一輪閒置狀態使用。
    const { _createPersistentIdleHandler } = _getPlaybackModule();
    voiceMonitor.startMonitoring({
      guildId,
      connection,
      channel,
      client,
      persistent: true,
      onStop: _createPersistentIdleHandler(guildId, channel),
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (!autoJoinEnabled) return;
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        console.warn('⚠️ 自動加入：連線中斷，5 秒後嘗試重連...');
        destroyExistingConnection(guildId);
        setTimeout(() => {
          if (autoJoinEnabled) joinTargetChannel(client);
        }, 5_000);
      }
    });

  } catch (error) {
    console.error('❌ 自動加入失敗:', error.message);
  } finally {
    isJoining = false;
  }
}

// ─── 定期檢查是否在目標頻道 ─────────────────────────────
function startAutoJoinCheck(client) {
  if (checkInterval) return;
  checkInterval = setInterval(async () => {
    if (!autoJoinEnabled) return;

    const channelId = process.env.TARGET_VOICE_CHANNEL_ID;
    if (!channelId) return;

    try {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) return;

      const botMember         = channel.guild.members.me;
      const isInTargetChannel = botMember?.voice?.channelId === channelId;

      if (!isInTargetChannel) {
        logger.debug('AutoJoin', 'Bot 不在目標頻道，嘗試自動加入...');
        await joinTargetChannel(client);
      }
    } catch (err) {
      console.error('❌ 自動加入檢查失敗:', err.message);
    }
  }, CHECK_INTERVAL_MS);

  logger.debug('AutoJoin', `檢查已啟動（每 ${CHECK_INTERVAL_MS / 1000} 秒）`);
}

function stopAutoJoinCheck() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
    console.log('🛑 自動加入檢查已停止');
  }
}

// ─── 建立 AutoJoin 選單 ──────────────────────────────────
function buildAutoJoinMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('autojoin_menu')
      .setPlaceholder('請選擇自動加入操作...')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('切換自動加入開關')
          .setDescription(`目前狀態：${autoJoinEnabled ? '✅ 開啟中' : '🛑 已關閉'}，點此切換`)
          .setValue('toggle')
          .setEmoji('🔁'),
        new StringSelectMenuOptionBuilder()
          .setLabel('查看目前狀態')
          .setDescription('顯示自動加入狀態與目標頻道資訊')
          .setValue('status')
          .setEmoji('📊'),
      )
  );
}

// ════════════════════════════════════════════════════════
//  setupAutoJoinCommands
// ════════════════════════════════════════════════════════
function setupAutoJoinCommands(client) {

  // ── Bot 就緒時啟動自動加入 ───────────────────────────
  client.once('clientReady', async () => {
    logger.debug('AutoJoin', 'Bot 就緒，啟動自動加入功能...');
    startAutoJoinCheck(client);

    const targetChannelId = process.env.TARGET_VOICE_CHANNEL_ID;
    bootSummary.report(
      '自動加入語音頻道',
      targetChannelId ? 'ok' : 'off',
      targetChannelId ? `每 ${CHECK_INTERVAL_MS / 1000} 秒檢查一次` : '未設定 TARGET_VOICE_CHANNEL_ID'
    );

    logger.debug('AutoJoin', `等待 ${STARTUP_DELAY_MS / 1000} 秒後加入語音頻道...`);
    setTimeout(() => {
      if (autoJoinEnabled) joinTargetChannel(client);
    }, STARTUP_DELAY_MS);
  });

  // ── 注入 /autojoin 到 client.commands ───────────────
  client.commands.set('autojoin', {
    data: new SlashCommandBuilder()
      .setName('autojoin')
      .setDescription('管理 Bot 自動加入語音頻道功能'),

    async execute(interaction) {
      await interaction.reply({
        content: '🤖 **自動加入管理** — 請從下方選單選擇操作：',
        components: [buildAutoJoinMenu()],
        flags: MessageFlags.Ephemeral,
      });
    }
  });

  // ── 選單互動處理（防重複註冊） ────────────────────────
  if (!autoJoinMenuBound) {
    autoJoinMenuBound = true;

    client.on('interactionCreate', async (interaction) => {
      if (!interaction.isStringSelectMenu()) return;
      if (interaction.customId !== 'autojoin_menu') return;

      const selected = interaction.values[0];

      // ── toggle ───────────────────────────────────────
      if (selected === 'toggle') {
        autoJoinEnabled = !autoJoinEnabled;

        if (autoJoinEnabled) {
          startAutoJoinCheck(client);
          await joinTargetChannel(client);
          await interaction.update({
            content: '✅ 自動加入已 **開啟**，Bot 將自動待在語音頻道',
            components: [buildAutoJoinMenu()],
          });
        } else {
          stopAutoJoinCheck();
          await interaction.update({
            content: '🛑 自動加入已 **關閉**',
            components: [buildAutoJoinMenu()],
          });
        }
      }

      // ── status ───────────────────────────────────────
      else if (selected === 'status') {
        const channelId   = process.env.TARGET_VOICE_CHANNEL_ID;
        const statusText  = autoJoinEnabled ? '✅ 開啟中' : '🛑 已關閉';
        const channelText = channelId ? `<#${channelId}>` : '⚠️ 未設定';

        await interaction.update({
          content:
            `📊 **自動加入狀態**\n` +
            `狀態：${statusText}\n` +
            `目標頻道：${channelText}\n` +
            `檢查間隔：每 ${CHECK_INTERVAL_MS / 1000} 秒`,
          components: [buildAutoJoinMenu()],
        });
      }
    });
  }
}

module.exports = { setupAutoJoinCommands };