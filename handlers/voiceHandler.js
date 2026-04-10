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
const fs = require('fs');
const path = require('path');

// STT 相關
const { startSTTListening, stopSTTListening } = require('./voice/sttHandler');
const { getGeminiResponse } = require('./ai/aiHandler');
const { playTTS } = require('./ttsHandler');

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

// 全局變量
const silencePlayers = new Map();
const silenceTimers = new Map();

// 🆕 記錄每個 Guild 的 STT 啟動狀態
const sttActiveGuilds = new Map();

function setupVoiceCommands(client) {
  client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const content = message.content;

    // ─────────────────────────────────────────
    // !join — 只加入語音頻道，不啟動 STT
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
          } catch (error) {
            connection.destroy();
            console.log('❌ 語音連接已斷開');
            stopSilenceAudio(message.guild.id);
            // 斷線時若 STT 有啟動則一併停止
            if (sttActiveGuilds.has(message.guild.id)) {
              stopSTTListening(message.guild.id);
              sttActiveGuilds.delete(message.guild.id);
            }
          }
        });

        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        console.log(`✅ 已加入語音頻道：${channel.name} (${channel.guild.name})`);

        message.reply(
          `✅ 已加入語音頻道：**${channel.name}**\n💡 使用 \`${PREFIX}stt\` 來啟動語音辨識`
        );

      } catch (error) {
        console.error('加入語音頻道時發生錯誤：', error);
        message.reply('❌ 加入語音頻道時發生錯誤');
      }
    }

    // ─────────────────────────────────────────
    // !leave — 離開語音頻道
    // ─────────────────────────────────────────
    if (content === `${PREFIX}leave`) {
      const connection = getVoiceConnection(message.guild.id);

      if (!connection) {
        return message.reply('你要我離開哪?');
      }

      connection.destroy();

      stopSilenceAudio(message.guild.id);
      const { stopBilibiliAudio } = require('./bilibiliHandler');
      stopBilibiliAudio(message.guild.id);

      // 離開時若 STT 有啟動則一併停止
      if (sttActiveGuilds.has(message.guild.id)) {
        stopSTTListening(message.guild.id);
        sttActiveGuilds.delete(message.guild.id);
      }

      console.log(`👋 已離開語音頻道 (${message.guild.name})`);
      message.reply('👋 已離開語音頻道');
    }

    // ─────────────────────────────────────────
    // 🆕 !stt — 啟動 STT 語音監聽
    // ─────────────────────────────────────────
    if (content === `${PREFIX}stt`) {
      const connection = getVoiceConnection(message.guild.id);

      if (!connection) {
        return message.reply(`❌ Bot 尚未加入語音頻道，請先使用 \`${PREFIX}join\``);
      }

      if (sttActiveGuilds.has(message.guild.id)) {
        return message.reply('🎙️ STT 語音辨識已經在運行中');
      }

      // 找「語音轉錄」頻道，找不到就用當前頻道
      const sttTextChannel = message.guild.channels.cache.find(
        ch => ch.name === '語音轉錄' && ch.isTextBased()
      ) || message.channel;

      startSTTListening(
        connection,
        message.guild,
        sttTextChannel,
        async (userId, member, text, channel) => {
          try {
            // 1. AI 思考
            const aiReply = await getGeminiResponse(userId, text);
            await channel.send(`🤖 **氣鳥**：${aiReply}`);

            // 2. TTS 發聲 (假設 playTTS 會等待播放完畢才 resolve)
            const result = await playTTS(message.guild.id, aiReply);
            if (!result.success) {
              console.warn(`[STT] TTS 失敗：${result.reason}`);
            }
          } catch (err) {
            console.error('[STT Callback] 錯誤：', err.message);
            await channel.send(`❌ 處理語音指令時發生錯誤`);
          } finally {
            // 3. 【關鍵】：無論成功或失敗，最後一定要解除鎖定！
            releaseSTTLock(message.guild.id);
          }
        }
      );

      sttActiveGuilds.set(message.guild.id, true);

      const targetChannelName = sttTextChannel.id === message.channel.id
        ? '此頻道'
        : `**#${sttTextChannel.name}**`;

      message.reply(
        `🎙️ STT 語音辨識已啟動！\n📝 轉錄結果將發送至 ${targetChannelName}\n🔇 說出喚醒詞來呼叫我`
      );

      console.log(`[STT] 手動啟動 Guild: ${message.guild.name}`);
    }

    // ─────────────────────────────────────────
    // 🆕 !sttstop — 停止 STT 語音監聽
    // ─────────────────────────────────────────
    if (content === `${PREFIX}sttstop`) {
      if (!sttActiveGuilds.has(message.guild.id)) {
        return message.reply('❌ STT 語音辨識目前未在運行');
      }

      stopSTTListening(message.guild.id);
      sttActiveGuilds.delete(message.guild.id);

      message.reply('⏹️ STT 語音辨識已停止');
      console.log(`[STT] 手動停止 Guild: ${message.guild.name}`);
    }

    // ─────────────────────────────────────────
    // !voice — 查看語音頻道狀態
    // ─────────────────────────────────────────
    if (content === `${PREFIX}voice`) {
      const connection = getVoiceConnection(message.guild.id);

      if (!connection) {
        return message.reply('📢 Bot 目前不在任何語音頻道中');
      }

      const channel = message.guild.channels.cache.get(connection.joinConfig.channelId);
      const isSilencePlaying = silencePlayers.has(message.guild.id);
      const isSttActive = sttActiveGuilds.has(message.guild.id);  // 🆕

      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('🎤 語音頻道狀態')
        .addFields(
          { name: '頻道名稱', value: channel?.name || '未知', inline: true },
          { name: '連接狀態', value: connection.state.status, inline: true },
          { name: '頻道成員', value: `${channel?.members.size || 0} 人`, inline: true },
          { name: '防踢狀態', value: isSilencePlaying ? '🔇 靜音播放中' : '⏸️ 未啟用', inline: true },
          { name: 'STT 狀態', value: isSttActive ? '🎙️ 監聽中' : '⏸️ 未啟用', inline: true }  // 🆕
        )
        .setTimestamp();

      message.reply({ embeds: [embed] });
    }

    // ─────────────────────────────────────────
    // !silence / !stopsilence / !autosilence
    // ─────────────────────────────────────────
    if (content === `${PREFIX}silence`) {
      const connection = getVoiceConnection(message.guild.id);

      if (!connection) {
        return message.reply('❌ Bot 必須先加入語音頻道才能播放靜音音頻');
      }

      if (silencePlayers.has(message.guild.id)) {
        return message.reply('🔇 靜音音頻已經在播放中');
      }

      startSilenceAudio(message.guild.id, connection);
      message.reply('🔇 已開始播放靜音音頻，防止被踢出頻道');
    }

    if (content === `${PREFIX}stopsilence`) {
      if (!silencePlayers.has(message.guild.id)) {
        return message.reply('❌ 目前沒有播放靜音音頻');
      }

      stopSilenceAudio(message.guild.id);
      message.reply('⏹️ 已停止播放靜音音頻');
    }

    if (content === `${PREFIX}autosilence`) {
      const connection = getVoiceConnection(message.guild.id);

      if (!connection) {
        return message.reply('❌ Bot 必須先加入語音頻道');
      }

      if (silenceTimers.has(message.guild.id)) {
        clearTimeout(silenceTimers.get(message.guild.id));
      }

      const timer = setTimeout(() => {
        if (getVoiceConnection(message.guild.id) && !silencePlayers.has(message.guild.id)) {
          startSilenceAudio(message.guild.id, getVoiceConnection(message.guild.id));
          console.log(`🔇 自動開始播放靜音音頻 (${message.guild.name})`);
        }
        silenceTimers.delete(message.guild.id);
      }, 5 * 60 * 1000);

      silenceTimers.set(message.guild.id, timer);
      message.reply('⏰ 已設置自動靜音模式，5分鐘後將自動開始播放靜音音頻');
    }
  });
}

// 開始播放靜音音頻
function startSilenceAudio(guildId, connection) {
  try {
    const player = createAudioPlayer();
    const silenceStream = createSilenceStream();
    const resource = createAudioResource(silenceStream, {
      inputType: StreamType.Raw,
      inlineVolume: true
    });

    resource.volume.setVolume(0.01);
    player.play(resource);
    connection.subscribe(player);

    player.on(AudioPlayerStatus.Idle, () => {
      if (silencePlayers.has(guildId)) {
        const newSilenceStream = createSilenceStream();
        const newResource = createAudioResource(newSilenceStream, {
          inputType: StreamType.Raw,
          inlineVolume: true
        });
        newResource.volume.setVolume(0.01);
        player.play(newResource);
      }
    });

    player.on('error', (error) => {
      console.error('靜音播放器錯誤：', error);
      stopSilenceAudio(guildId);
    });

    silencePlayers.set(guildId, player);
    console.log(`🔇 開始播放靜音音頻 (Guild: ${guildId})`);

  } catch (error) {
    console.error('創建靜音播放器時發生錯誤：', error);
  }
}

// 停止播放靜音音頻
function stopSilenceAudio(guildId) {
  const player = silencePlayers.get(guildId);
  if (player) {
    player.stop();
    silencePlayers.delete(guildId);
    console.log(`⏹️ 停止播放靜音音頻 (Guild: ${guildId})`);
  }

  const timer = silenceTimers.get(guildId);
  if (timer) {
    clearTimeout(timer);
    silenceTimers.delete(guildId);
  }
}

module.exports = {
  setupVoiceCommands,
  startSilenceAudio,
  stopSilenceAudio
};