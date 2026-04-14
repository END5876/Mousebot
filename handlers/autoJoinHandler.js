const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const { SlashCommandBuilder } = require('discord.js');

// ─── 狀態管理 ───────────────────────────────────────────
let autoJoinEnabled = true;
let checkInterval   = null;
let isJoining       = false;
const CHECK_INTERVAL_MS = 10_000;
const STARTUP_DELAY_MS  = 3_000;

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

    // 已在目標頻道且連線正常則跳過
    if (botMember?.voice?.channelId === channelId) {
      const existing = getVoiceConnection(guildId);
      if (existing && existing.state.status === VoiceConnectionStatus.Ready) {
        isJoining = false;
        return;
      }
    }

    console.log(`🔊 自動加入語音頻道: ${channel.name} (${channelId})`);
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
      console.log(`✅ 已加入語音頻道: ${channel.name}`);
    } catch (readyErr) {
      console.error('❌ 等待連線就緒失敗:', readyErr.message);
      destroyExistingConnection(guildId);
      isJoining = false;
      return;
    }

    // 監聽斷線事件
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

      const botMember        = channel.guild.members.me;
      const isInTargetChannel = botMember?.voice?.channelId === channelId;

      if (!isInTargetChannel) {
        console.log('🔄 Bot 不在目標頻道，嘗試自動加入...');
        await joinTargetChannel(client);
      }
    } catch (err) {
      console.error('❌ 自動加入檢查失敗:', err.message);
    }
  }, CHECK_INTERVAL_MS);

  console.log(`✅ 自動加入檢查已啟動（每 ${CHECK_INTERVAL_MS / 1000} 秒）`);
}

function stopAutoJoinCheck() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
    console.log('🛑 自動加入檢查已停止');
  }
}

// ════════════════════════════════════════════════════════
//  setupAutoJoinCommands
// ════════════════════════════════════════════════════════
function setupAutoJoinCommands(client) {

    // ── Bot 就緒時啟動自動加入 ───────────────────────────
    client.once('clientReady', async () => {
      console.log('🚀 Bot 就緒，啟動自動加入功能...');
      startAutoJoinCheck(client);

      console.log(`⏳ 等待 ${STARTUP_DELAY_MS / 1000} 秒後加入語音頻道...`);
      setTimeout(() => {
        if (autoJoinEnabled) joinTargetChannel(client);
      }, STARTUP_DELAY_MS);
    });

    // ── 注入 /autojoin 到 client.commands ───────────────
    client.commands.set('autojoin', {
        data: new SlashCommandBuilder()
            .setName('autojoin')
            .setDescription('管理 Bot 自動加入語音頻道功能')
            .addSubcommand(sub =>
                sub.setName('toggle')
                    .setDescription('切換自動加入開關（開啟 / 關閉）')
            )
            .addSubcommand(sub =>
                sub.setName('status')
                    .setDescription('查看目前自動加入狀態與目標頻道')
            ),

        async execute(interaction, client) {
            const sub = interaction.options.getSubcommand();

            // ── /autojoin toggle ─────────────────────────
            if (sub === 'toggle') {
                autoJoinEnabled = !autoJoinEnabled;

                if (autoJoinEnabled) {
                    startAutoJoinCheck(client);
                    await interaction.reply({ content: '✅ 自動加入已**開啟**，Bot 將自動待在語音頻道' });
                    await joinTargetChannel(client); // 立即加入
                } else {
                    stopAutoJoinCheck();
                    await interaction.reply({ content: '🛑 自動加入已**關閉**' });
                }
            }

            // ── /autojoin status ─────────────────────────
            else if (sub === 'status') {
                const channelId  = process.env.TARGET_VOICE_CHANNEL_ID;
                const statusText = autoJoinEnabled ? '✅ 開啟中' : '🛑 已關閉';
                const channelText = channelId ? `<#${channelId}>` : '⚠️ 未設定';

                await interaction.reply({
                    content:
                        `**自動加入狀態**\n` +
                        `狀態：${statusText}\n` +
                        `目標頻道：${channelText}`,
                });
            }
        }
    });
}

module.exports = { setupAutoJoinCommands };