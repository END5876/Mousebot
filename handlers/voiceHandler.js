const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

// STT 相關
const { startSTTListening, stopSTTListening } = require('./voice/sttHandler');
const { getGeminiResponse }                   = require('./ai/aiHandler');
const { playTTS }                             = require('./ttsHandler');

// ✅ 改用 audioManager 統一管理靜音層
const {
  startSilenceLayer,
  stopSilenceLayer,
  cleanupGuild,
  getActiveLayer,
} = require('./audioManager');

// ── 全域 Map ─────────────────────────────────────────────
const silenceTimers   = new Map();
const sttActiveGuilds = new Map();

// ════════════════════════════════════════════════════════
//  setupVoiceCommands
// ════════════════════════════════════════════════════════
function setupVoiceCommands(client) {

  // ── /join ─────────────────────────────────────────────
  client.commands.set('join', {
    data: new SlashCommandBuilder()
      .setName('join')
      .setDescription('讓 Bot 加入你目前所在的語音頻道'),

    async execute(interaction) {
      const voiceChannel = interaction.member?.voice?.channel;

      if (!voiceChannel) {
        return interaction.reply({ content: '你要我去哪？', ephemeral: true });
      }

      try {
        const connection = joinVoiceChannel({
          channelId:      voiceChannel.id,
          guildId:        voiceChannel.guild.id,
          adapterCreator: voiceChannel.guild.voiceAdapterCreator,
          selfDeaf:       false,
          selfMute:       false,
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
            // ✅ 改用 audioManager 清理
            cleanupGuild(interaction.guildId);
            if (sttActiveGuilds.has(interaction.guildId)) {
              stopSTTListening(interaction.guildId);
              sttActiveGuilds.delete(interaction.guildId);
            }
          }
        });

        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        console.log(`✅ 已加入語音頻道：${voiceChannel.name} (${voiceChannel.guild.name})`);

        await interaction.reply(
          `✅ 已加入語音頻道：**${voiceChannel.name}**\n💡 使用 \`/stt start\` 來啟動語音辨識`
        );

      } catch (error) {
        console.error('加入語音頻道時發生錯誤：', error);
        await interaction.reply({ content: '❌ 加入語音頻道時發生錯誤', ephemeral: true });
      }
    }
  });

  // ── /leave ────────────────────────────────────────────
  client.commands.set('leave', {
    data: new SlashCommandBuilder()
      .setName('leave')
      .setDescription('讓 Bot 離開語音頻道'),

    async execute(interaction) {
      const guildId    = interaction.guildId;
      const connection = getVoiceConnection(guildId);

      if (!connection) {
        return interaction.reply({ content: '你要我離開哪？Bot 目前不在語音頻道中', ephemeral: true });
      }

      // ✅ 清理所有音頻層（靜音 + 音樂）
      cleanupGuild(guildId);

      // 清除自動靜音計時器
      if (silenceTimers.has(guildId)) {
        clearTimeout(silenceTimers.get(guildId));
        silenceTimers.delete(guildId);
      }

      const { stopBilibiliAudio } = require('./bilibiliHandler');
      stopBilibiliAudio(guildId);

      if (sttActiveGuilds.has(guildId)) {
        stopSTTListening(guildId);
        sttActiveGuilds.delete(guildId);
      }

      connection.destroy();

      console.log(`👋 已離開語音頻道 (${interaction.guild.name})`);
      await interaction.reply('👋 已離開語音頻道');
    }
  });

  // ── /voice ────────────────────────────────────────────
  client.commands.set('voice', {
    data: new SlashCommandBuilder()
      .setName('voice')
      .setDescription('查看 Bot 目前的語音頻道狀態'),

    async execute(interaction) {
      const guildId    = interaction.guildId;
      const connection = getVoiceConnection(guildId);

      if (!connection) {
        return interaction.reply({ content: '📢 Bot 目前不在任何語音頻道中', ephemeral: true });
      }

      const channel       = interaction.guild.channels.cache.get(connection.joinConfig.channelId);
      const activeLayer   = getActiveLayer(guildId);
      const isSttActive   = sttActiveGuilds.has(guildId);

      // 顯示當前音頻層狀態
      const layerText = {
        silence: '🔇 靜音防踢中',
        music:   '🎵 音樂播放中',
        tts:     '🔊 TTS 播放中',
      }[activeLayer] ?? '⏸️ 未啟用';

      await interaction.reply({ embeds: [
        new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle('🎤 語音頻道狀態')
          .addFields(
            { name: '頻道名稱', value: channel?.name           || '未知',    inline: true },
            { name: '連接狀態', value: connection.state.status,              inline: true },
            { name: '頻道成員', value: `${channel?.members.size || 0} 人`,   inline: true },
            { name: '音頻層',   value: layerText,                            inline: true },
            { name: 'STT 狀態', value: isSttActive ? '🎙️ 監聽中' : '⏸️ 未啟用', inline: true }
          )
          .setTimestamp()
      ]});
    }
  });

  // ── /stt ──────────────────────────────────────────────
  client.commands.set('stt', {
    data: new SlashCommandBuilder()
      .setName('stt')
      .setDescription('管理 STT 語音辨識功能')
      .addSubcommand(sub =>
        sub.setName('start')
          .setDescription('啟動 STT 語音辨識監聽')
      )
      .addSubcommand(sub =>
        sub.setName('stop')
          .setDescription('停止 STT 語音辨識監聽')
      ),

    async execute(interaction) {
      const sub     = interaction.options.getSubcommand();
      const guildId = interaction.guildId;

      // ── /stt start ──────────────────────────────────
      if (sub === 'start') {
        const connection = getVoiceConnection(guildId);

        if (!connection) {
          return interaction.reply({ content: '❌ Bot 尚未加入語音頻道，請先使用 `/join`', ephemeral: true });
        }

        if (sttActiveGuilds.has(guildId)) {
          return interaction.reply({ content: '🎙️ STT 語音辨識已經在運行中', ephemeral: true });
        }

        // 找「語音轉錄」頻道，找不到就用當前頻道
        const sttTextChannel = interaction.guild.channels.cache.find(
          ch => ch.name === '語音轉錄' && ch.isTextBased()
        ) || interaction.channel;

        startSTTListening(
          connection,
          interaction.guild,
          sttTextChannel,
          async (userId, member, text, channel) => {
            try {
              const aiReply = await getGeminiResponse(userId, text);
              await channel.send(`🤖 **機器鳥**：${aiReply}`);

              const result = await playTTS(guildId, aiReply);
              if (!result.success) console.warn(`[STT] TTS 失敗：${result.reason}`);
            } catch (err) {
              console.error('[STT Callback] 錯誤：', err.message);
              await channel.send('❌ 處理語音指令時發生錯誤');
            }
          }
        );

        sttActiveGuilds.set(guildId, true);

        const targetChannelName = sttTextChannel.id === interaction.channel.id
          ? '此頻道'
          : `**#${sttTextChannel.name}**`;

        console.log(`[STT] 手動啟動 Guild: ${interaction.guild.name}`);
        await interaction.reply(
          `🎙️ STT 語音辨識已啟動！\n📝 轉錄結果將發送至 ${targetChannelName}\n🗣️ 說 **hey機器鳥** 來呼叫我`
        );
      }

      // ── /stt stop ───────────────────────────────────
      else if (sub === 'stop') {
        if (!sttActiveGuilds.has(guildId)) {
          return interaction.reply({ content: '❌ STT 語音辨識目前未在運行', ephemeral: true });
        }

        stopSTTListening(guildId);
        sttActiveGuilds.delete(guildId);

        console.log(`[STT] 手動停止 Guild: ${interaction.guild.name}`);
        await interaction.reply('⏹️ STT 語音辨識已停止');
      }
    }
  });

  // ── /silence ──────────────────────────────────────────
  client.commands.set('silence', {
    data: new SlashCommandBuilder()
      .setName('silence')
      .setDescription('管理靜音防踢功能')
      .addSubcommand(sub =>
        sub.setName('start')
          .setDescription('開始播放靜音音頻，防止 Bot 被踢出頻道')
      )
      .addSubcommand(sub =>
        sub.setName('stop')
          .setDescription('停止播放靜音音頻')
      )
      .addSubcommand(sub =>
        sub.setName('auto')
          .setDescription('設置自動靜音模式（5 分鐘後自動啟動）')
      ),

    async execute(interaction) {
      const sub     = interaction.options.getSubcommand();
      const guildId = interaction.guildId;

      // ── /silence start ──────────────────────────────
      if (sub === 'start') {
        const connection = getVoiceConnection(guildId);

        if (!connection) {
          return interaction.reply({ content: '❌ Bot 必須先加入語音頻道才能播放靜音音頻', ephemeral: true });
        }
        if (getActiveLayer(guildId) === 'silence') {
          return interaction.reply({ content: '🔇 靜音音頻已經在播放中', ephemeral: true });
        }

        // ✅ 改用 audioManager 啟動靜音層
        startSilenceLayer(guildId);
        await interaction.reply('🔇 已開始播放靜音音頻，防止被踢出頻道');
      }

      // ── /silence stop ───────────────────────────────
      else if (sub === 'stop') {
        if (getActiveLayer(guildId) !== 'silence') {
          return interaction.reply({ content: '❌ 目前沒有播放靜音音頻', ephemeral: true });
        }

        // ✅ 改用 audioManager 停止靜音層
        stopSilenceLayer(guildId);
        await interaction.reply('⏹️ 已停止播放靜音音頻');
      }

      // ── /silence auto ───────────────────────────────
      else if (sub === 'auto') {
        const connection = getVoiceConnection(guildId);

        if (!connection) {
          return interaction.reply({ content: '❌ Bot 必須先加入語音頻道', ephemeral: true });
        }

        // 重置舊計時器
        if (silenceTimers.has(guildId)) {
          clearTimeout(silenceTimers.get(guildId));
        }

        const timer = setTimeout(() => {
          const conn = getVoiceConnection(guildId);
          if (conn && getActiveLayer(guildId) !== 'silence') {
            // ✅ 改用 audioManager 啟動靜音層
            startSilenceLayer(guildId);
            console.log(`🔇 自動開始播放靜音音頻 (${interaction.guild.name})`);
          }
          silenceTimers.delete(guildId);
        }, 5 * 60 * 1000);

        silenceTimers.set(guildId, timer);
        await interaction.reply('⏰ 已設置自動靜音模式，5 分鐘後將自動開始播放靜音音頻');
      }
    }
  });

  console.log('✅ 語音指令已載入（/join / /leave / /voice / /stt / /silence）');
}

module.exports = {
  setupVoiceCommands,
  // ✅ 保持向後相容，讓其他地方 require 這兩個函式時不會報錯
  startSilenceAudio: startSilenceLayer,
  stopSilenceAudio:  stopSilenceLayer,
};