const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType
} = require('@discordjs/voice');
const { EmbedBuilder } = require('discord.js');
const { PREFIX } = require('../config/settings');
const { Readable } = require('stream');

// 創建靜音音頻流
function createSilenceStream() {
  const silence = Buffer.alloc(3840, 0);
  let index = 0;

  return new Readable({
    read() {
      if (index < 100) {
        this.push(silence);
        index++;
      } else {
        index = 0;
        this.push(silence);
      }
    }
  });
}

const silencePlayers = new Map();
const autoJoinEnabled = new Map(); // guildId -> boolean
let autoJoinCheckInterval = null;

/**
 * 檢查並自動加入指定語音頻道
 */
async function checkAndAutoJoin(client) {
  const targetChannelId = process.env.AUTO_JOIN_CHANNEL_ID;
  if (!targetChannelId) return;

  for (const [guildId, enabled] of autoJoinEnabled.entries()) {
    if (!enabled) continue;

    try {
      // ✅ 用 fetch 確保 guild 資料完整
      const guild = await client.guilds.fetch(guildId);
      if (!guild) continue;

      // ✅ 直接 fetch 指定頻道，避免 cache 未載入問題
      const targetChannel = await guild.channels.fetch(targetChannelId).catch(() => null);
      if (!targetChannel || targetChannel.type !== 2) continue; // type 2 = GuildVoice

      const existingConnection = getVoiceConnection(guildId);

      // 若已在目標頻道，跳過
      if (existingConnection && existingConnection.joinConfig.channelId === targetChannelId) {
        continue;
      }

      // 若在其他頻道，先斷開
      if (existingConnection) {
        existingConnection.destroy();
      }

      console.log(`🔊 [AutoJoin] 自動加入頻道: ${targetChannel.name} (Guild: ${guild.name})`);

      const connection = joinVoiceChannel({
        channelId: targetChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      connection.on(VoiceConnectionStatus.Ready, () => {
        console.log(`✅ [AutoJoin] 已加入: ${targetChannel.name}`);
        startSilencePlayer(guildId, connection);
      });

      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          console.warn(`⚠️ [AutoJoin] 連線中斷，將於下次檢查時重新加入`);
          connection.destroy();
        }
      });

    } catch (err) {
      console.error(`❌ [AutoJoin] 錯誤 (Guild: ${guildId}):`, err.message);
    }
  }
}

/**
 * 啟動靜音播放器（保持連線用）
 */
function startSilencePlayer(guildId, connection) {
  if (silencePlayers.has(guildId)) return;

  const player = createAudioPlayer();
  const resource = createAudioResource(createSilenceStream(), {
    inputType: StreamType.Raw,
  });

  player.play(resource);
  connection.subscribe(player);
  silencePlayers.set(guildId, player);

  player.on(AudioPlayerStatus.Idle, () => {
    const newResource = createAudioResource(createSilenceStream(), {
      inputType: StreamType.Raw,
    });
    player.play(newResource);
  });
}

function setupVoiceCommands(client) {

  // ✅ 改用 clientReady（discord.js v14 正確事件名稱）
  client.once('clientReady', async () => {
    const targetChannelId = process.env.AUTO_JOIN_CHANNEL_ID;

    if (!targetChannelId) {
      console.warn('⚠️ [AutoJoin] 未設定 AUTO_JOIN_CHANNEL_ID，跳過自動加入');
      return;
    }

    console.log(`🚀 [AutoJoin] Bot 啟動，預設開啟自動加入，目標頻道 ID: ${targetChannelId}`);

    // 對所有伺服器預設開啟
    for (const [guildId] of client.guilds.cache) {
      autoJoinEnabled.set(guildId, true);
    }

    // 啟動定期檢查（每 10 秒）
    if (!autoJoinCheckInterval) {
      autoJoinCheckInterval = setInterval(() => checkAndAutoJoin(client), 10_000);
    }

    // 立即執行一次
    await checkAndAutoJoin(client);
  });

  client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const content = message.content.trim();
    const guildId = message.guild?.id;

    // ─────────────────────────────────────────
    // !autojoin on / off / status
    // ─────────────────────────────────────────
    if (content === `${PREFIX}autojoin on`) {
      const targetChannelId = process.env.AUTO_JOIN_CHANNEL_ID;

      if (!targetChannelId) {
        return message.reply('❌ 未設定 `AUTO_JOIN_CHANNEL_ID` 環境變數');
      }

      autoJoinEnabled.set(guildId, true);

      if (!autoJoinCheckInterval) {
        autoJoinCheckInterval = setInterval(() => checkAndAutoJoin(client), 10_000);
      }

      await checkAndAutoJoin(client);
      return message.reply(`✅ 自動加入已**開啟**，目標頻道 ID: \`${targetChannelId}\``);
    }

    if (content === `${PREFIX}autojoin off`) {
      autoJoinEnabled.set(guildId, false);

      const anyEnabled = [...autoJoinEnabled.values()].some(v => v);
      if (!anyEnabled && autoJoinCheckInterval) {
        clearInterval(autoJoinCheckInterval);
        autoJoinCheckInterval = null;
      }

      return message.reply('🔕 自動加入已**關閉**');
    }

    if (content === `${PREFIX}autojoin status`) {
      const enabled = autoJoinEnabled.get(guildId) ?? false;
      const targetChannelId = process.env.AUTO_JOIN_CHANNEL_ID;
      return message.reply(
        `📊 自動加入狀態：**${enabled ? '開啟 ✅' : '關閉 ❌'}**\n` +
        `目標頻道 ID：\`${targetChannelId || '未設定'}\``
      );
    }

    // ─────────────────────────────────────────
    // !join
    // ─────────────────────────────────────────
    if (content === `${PREFIX}join`) {
      if (!message.member.voice.channel) {
        return message.reply('你要我去哪?');
      }

      const channel = message.member.voice.channel;

      try {
        const connection = joinVoiceChannel({
          channelId: channel.id,
          guildId: channel.guild.id,
          adapterCreator: channel.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false,
        });

        connection.on(VoiceConnectionStatus.Ready, () => {
          console.log('✅ 語音連接已就緒');
        });

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
          try {
            await Promise.race([
              entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
              entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
          } catch {
            connection.destroy();
          }
        });

        await message.reply(`✅ 已加入 **${channel.name}**`);
      } catch (err) {
        console.error('加入語音頻道失敗:', err);
        await message.reply('❌ 無法加入語音頻道');
      }
    }

    // ─────────────────────────────────────────
    // !leave
    // ─────────────────────────────────────────
    if (content === `${PREFIX}leave`) {
      const connection = getVoiceConnection(guildId);
      if (!connection) {
        return message.reply('我沒有在任何語音頻道');
      }

      if (silencePlayers.has(guildId)) {
        silencePlayers.get(guildId).stop();
        silencePlayers.delete(guildId);
      }

      connection.destroy();
      await message.reply('👋 已離開語音頻道');
    }
  });
}

module.exports = { setupVoiceCommands };