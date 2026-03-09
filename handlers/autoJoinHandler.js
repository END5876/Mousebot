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
let isJoining = false; // 防止重複加入
const CHECK_INTERVAL_MS = 10_000;
const STARTUP_DELAY_MS = 3_000; // 啟動延遲，等待 Discord 連線穩定

// ─── 工具：安全銷毀現有連線 ──────────────────────────────
function destroyExistingConnection(guildId) {
  try {
    const existing = getVoiceConnection(guildId);
    if (existing) {
      existing.removeAllListeners(); // 避免舊監聽器觸發重連
      existing.destroy();
      console.log('🧹 已銷毀舊語音連線');
    }
  } catch (err) {
    console.warn('⚠️ 銷毀舊連線時發生錯誤（可忽略）:', err.message);
  }
}

// ─── 加入目標語音頻道 ────────────────────────────────────
async function joinTargetChannel(client) {
  if (isJoining) return; // 防止重複執行
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

    const guildId = channel.guild.id;
    const botMember = channel.guild.members.me;

    // 已在目標頻道則跳過
    if (botMember?.voice?.channelId === channelId) {
      const existing = getVoiceConnection(guildId);
      if (existing && existing.state.status === VoiceConnectionStatus.Ready) {
        isJoining = false;
        return;
      }
    }

    console.log(`🔊 自動加入語音頻道: ${channel.name} (${channelId})`);

    // 先強制銷毀舊連線（避免殘留 socket 問題）
    destroyExistingConnection(guildId);

    // 短暫等待確保舊連線資源釋放
    await new Promise(resolve => setTimeout(resolve, 500));

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    // 等待連線就緒（加上 try/catch 防止 unhandled rejection）
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
        // 嘗試判斷是否為短暫斷線（可恢復）
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
    isJoining = false; // 無論成功或失敗都解鎖
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

    // ✅ 延遲加入，避免重啟後 socket 尚未就緒
    console.log(`⏳ 等待 ${STARTUP_DELAY_MS / 1000} 秒後加入語音頻道...`);
    setTimeout(() => {
      if (autoJoinEnabled) joinTargetChannel(client);
    }, STARTUP_DELAY_MS);
  });

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