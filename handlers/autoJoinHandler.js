// handlers/autoJoinHandler.js
const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const { PREFIX } = require('../config/settings');

// ─── 狀態管理 ───────────────────────────────────────────
let autoJoinEnabled = true;
let checkInterval = null;
const CHECK_INTERVAL_MS = 10_000;

// ─── 加入目標語音頻道 ────────────────────────────────────
async function joinTargetChannel(client) {
  const channelId = process.env.TARGET_VOICE_CHANNEL_ID;
  if (!channelId) {
    console.warn('⚠️ TARGET_VOICE_CHANNEL_ID 未設定');
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isVoiceBased()) {
      console.warn(`⚠️ 找不到語音頻道: ${channelId}`);
      return;
    }

    const guildId = channel.guild.id;
    const existingConnection = getVoiceConnection(guildId);
    const botMember = channel.guild.members.me;

    // 已在目標頻道，不重複加入
    if (existingConnection && botMember?.voice?.channelId === channelId) {
      return;
    }

    console.log(`🔊 自動加入語音頻道: ${channel.name} (${channelId})`);

    // 若已有連線但不在目標頻道，先斷開
    if (existingConnection) {
      existingConnection.destroy();
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,  // 不顯示綠圈、不聽語音
      selfMute: true,  // 不顯示綠圈、不發送語音
    });

    // 等待連線就緒
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    console.log(`✅ 已加入語音頻道: ${channel.name}`);

    // 連線中斷時自動重連
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (!autoJoinEnabled) return;
      try {
        // 嘗試等待重新連線中
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        // 真的斷了，5 秒後重新加入
        console.warn('⚠️ 自動加入：連線中斷，5 秒後嘗試重連...');
        connection.destroy();
        setTimeout(() => {
          if (autoJoinEnabled) joinTargetChannel(client);
        }, 5_000);
      }
    });

  } catch (error) {
    console.error('❌ 自動加入失敗:', error.message);
  }
}

// ─── 定期檢查是否在目標頻道 ─────────────────────────────
function startAutoJoinCheck(client) {
  if (checkInterval) return; // 避免重複啟動

  checkInterval = setInterval(async () => {
    if (!autoJoinEnabled) return;

    const channelId = process.env.TARGET_VOICE_CHANNEL_ID;
    if (!channelId) return;

    try {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) return;

      const botMember = channel.guild.members.me;
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

// ─── 指令處理 ────────────────────────────────────────────
function setupAutoJoinCommands(client) {

  client.once('clientReady', async () => {
    console.log('🚀 Bot 就緒，啟動自動加入功能...');
    startAutoJoinCheck(client);
    await joinTargetChannel(client);
  });

  // 監聽指令
  client.on('messageCreate', async message => {
    if (message.author.bot) return;
    const content = message.content.trim();

    // !autojoin — 切換開關
    if (content === `${PREFIX}autojoin`) {
      autoJoinEnabled = !autoJoinEnabled;

      if (autoJoinEnabled) {
        startAutoJoinCheck(client);
        await joinTargetChannel(client);
        return message.reply('✅ 自動加入已**開啟**，Bot 將自動待在語音頻道');
      } else {
        stopAutoJoinCheck();
        return message.reply('🛑 自動加入已**關閉**');
      }
    }

    // !autojoin status — 查看狀態
    if (content === `${PREFIX}autojoin status`) {
      const channelId = process.env.TARGET_VOICE_CHANNEL_ID;
      const statusText = autoJoinEnabled ? '✅ 開啟中' : '🛑 已關閉';
      const channelText = channelId ? `<#${channelId}>` : '⚠️ 未設定';
      return message.reply(
        `**自動加入狀態**\n` +
        `狀態：${statusText}\n` +
        `目標頻道：${channelText}`
      );
    }
  });
}

module.exports = { setupAutoJoinCommands };