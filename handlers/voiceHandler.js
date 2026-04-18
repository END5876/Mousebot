const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');

const {
  EmbedBuilder,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,       // ✅ 新增
  StringSelectMenuOptionBuilder, // ✅ 新增
} = require('discord.js');

// STT 相關
const {
  startSTTListening,
  stopSTTListening,
  ensureManualSession,
  manualRecordOnce,
} = require('./voice/sttHandler');

const { getGeminiResponseVoice } = require('./ai/aiHandler');
const { playTTS } = require('./ttsHandler');

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

// heyjqn 防狂點
const manualGuildLocks   = new Map(); // guildId -> boolean
const manualUserCooldown = new Map(); // `${guildId}:${userId}` -> timestamp

const HEYJQN_USER_COOLDOWN_MS = parseInt(process.env.HEYJQN_USER_COOLDOWN_MS || '4000', 10);
const HEYJQN_BTN_TTL_MS       = parseInt(process.env.HEYJQN_BTN_TTL_MS || String(15 * 60 * 1000), 10);

// interactionCreate 防重複註冊
let heyjqnBound   = false;
let silenceMenuBound = false; // ✅ 新增

// ── heyjqn 按鈕工具 ───────────────────────────────────────
function buildHeyJqnButton(guildId, disabled = false) {
  const ts = Date.now();
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`heyjqn_record:${guildId}:${ts}`)
      .setLabel('🎙️ 開始手動錄音')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled)
  );
}

function parseHeyJqnCustomId(customId) {
  // heyjqn_record:guildId:timestamp
  const [prefix, gid, ts] = customId.split(':');
  return { prefix, gid, ts: Number(ts || 0) };
}

// ── /silence 選單工具 ─────────────────────────────────────
function buildSilenceMenu(guildId) {
  const isSilence = getActiveLayer(guildId) === 'silence';
  const hasPending = silenceTimers.has(guildId);

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`silence_menu:${guildId}`)
      .setPlaceholder('請選擇靜音防踢操作...')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel('開始靜音防踢')
          .setDescription('立即播放靜音音頻，防止 Bot 被踢出頻道')
          .setValue('start')
          .setEmoji('🔇')
          .setDefault(isSilence),
        new StringSelectMenuOptionBuilder()
          .setLabel('停止靜音防踢')
          .setDescription('停止播放靜音音頻')
          .setValue('stop')
          .setEmoji('⏹️'),
        new StringSelectMenuOptionBuilder()
          .setLabel('自動靜音（5 分鐘後）')
          .setDescription(hasPending ? '⏳ 計時器已設置中，點此重設' : '設置計時器，5 分鐘後自動開始靜音防踢')
          .setValue('auto')
          .setEmoji('⏰')
          .setDefault(hasPending),
      )
  );
}

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
            cleanupGuild(interaction.guildId);

            if (sttActiveGuilds.has(interaction.guildId)) {
              stopSTTListening(interaction.guildId);
              sttActiveGuilds.delete(interaction.guildId);
            }

            manualGuildLocks.delete(interaction.guildId);
          }
        });

        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        console.log(`✅ 已加入語音頻道：${voiceChannel.name} (${voiceChannel.guild.name})`);

        await interaction.reply(
          `✅ 已加入語音頻道：**${voiceChannel.name}**\n💡 可用 \`/stt start\`（喚醒詞）或 \`/heyjqn\`（按鈕手動錄音）`
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

      cleanupGuild(guildId);

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

      manualGuildLocks.delete(guildId);

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

      const channel     = interaction.guild.channels.cache.get(connection.joinConfig.channelId);
      const activeLayer = getActiveLayer(guildId);
      const isSttActive = sttActiveGuilds.has(guildId);

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
            { name: '頻道名稱', value: channel?.name || '未知', inline: true },
            { name: '連接狀態', value: connection.state.status, inline: true },
            { name: '頻道成員', value: `${channel?.members.size || 0} 人`, inline: true },
            { name: '音頻層', value: layerText, inline: true },
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
        sub.setName('start').setDescription('啟動 STT 語音辨識監聽（喚醒詞）')
      )
      .addSubcommand(sub =>
        sub.setName('stop').setDescription('停止 STT 語音辨識監聽')
      ),

    async execute(interaction) {
      const sub     = interaction.options.getSubcommand();
      const guildId = interaction.guildId;

      if (sub === 'start') {
        const connection = getVoiceConnection(guildId);

        if (!connection) {
          return interaction.reply({ content: '❌ Bot 尚未加入語音頻道，請先使用 `/join`', ephemeral: true });
        }

        if (sttActiveGuilds.has(guildId)) {
          return interaction.reply({ content: '🎙️ STT 語音辨識已經在運行中', ephemeral: true });
        }

        const sttTextChannel = interaction.guild.channels.cache.find(
          ch => ch.name === '語音轉錄' && ch.isTextBased()
        ) || interaction.channel;

        startSTTListening(
          connection,
          interaction.guild,
          sttTextChannel,
          async (userId, member, text, channel) => {
            try {
              const aiReply = await getGeminiResponseVoice(userId, text);
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

        await interaction.reply(
          `🎙️ STT 語音辨識已啟動！\n📝 轉錄結果將發送至 ${targetChannelName}\n🗣️ 說 **hey機器鳥** 來呼叫我`
        );
      } else if (sub === 'stop') {
        if (!sttActiveGuilds.has(guildId)) {
          return interaction.reply({ content: '❌ STT 語音辨識目前未在運行', ephemeral: true });
        }

        stopSTTListening(guildId);
        sttActiveGuilds.delete(guildId);

        await interaction.reply('⏹️ STT 語音辨識已停止');
      }
    }
  });

  // ── /heyjqn ───────────────────────────────────────────
  client.commands.set('heyjqn', {
    data: new SlashCommandBuilder()
      .setName('heyjqn')
      .setDescription('發送手動錄音按鈕'),

    async execute(interaction) {
      const guildId    = interaction.guildId;
      const connection = getVoiceConnection(guildId);

      if (!connection) {
        return interaction.reply({ content: '❌ Bot 尚未加入語音頻道，請先使用 `/join`', ephemeral: true });
      }

      ensureManualSession(connection, interaction.guild, interaction.channel, async (userId, member, text, channel) => {
        const aiReply = await getGeminiResponseVoice(userId, text);
        await channel.send(`🤖 **機器鳥**：${aiReply}`);
        const ttsResult = await playTTS(guildId, aiReply);
        if (!ttsResult.success) {
          await channel.send(`⚠️ TTS 失敗：${ttsResult.reason}`);
        }
      });

      await interaction.reply({
        content: '✅ 已送出手動錄音按鈕',
        components: [buildHeyJqnButton(guildId, false)],
      });
    }
  });

  // ── /silence（選單式）────────────────────────────────
  client.commands.set('silence', {
    data: new SlashCommandBuilder()
      .setName('silence')
      .setDescription('管理靜音防踢功能'),

    async execute(interaction) {
      const guildId    = interaction.guildId;
      const connection = getVoiceConnection(guildId);

      if (!connection) {
        return interaction.reply({
          content: '❌ Bot 必須先加入語音頻道才能使用靜音功能，請先使用 `/join`',
          ephemeral: true,
        });
      }

      const activeLayer = getActiveLayer(guildId);
      const layerText = {
        silence: '🔇 靜音防踢中',
        music:   '🎵 音樂播放中',
        tts:     '🔊 TTS 播放中',
      }[activeLayer] ?? '⏸️ 未啟用';

      await interaction.reply({
        content: `🔇 **靜音防踢管理**\n目前音頻層：**${layerText}**\n\n請從下方選單選擇操作：`,
        components: [buildSilenceMenu(guildId)],
        ephemeral: true,
      });
    }
  });

  // ── interactionCreate: silence 選單（防重複註冊）──────
  if (!silenceMenuBound) {
    silenceMenuBound = true;

    client.on('interactionCreate', async (interaction) => {
      if (!interaction.isStringSelectMenu()) return;
      if (!interaction.customId.startsWith('silence_menu:')) return;

      const guildId  = interaction.customId.split(':')[1];
      const selected = interaction.values[0];

      // ── start ───────────────────────────────────────
      if (selected === 'start') {
        const connection = getVoiceConnection(guildId);
        if (!connection) {
          return interaction.update({ content: '❌ Bot 不在語音頻道，請先使用 `/join`', components: [] });
        }
        if (getActiveLayer(guildId) === 'silence') {
          return interaction.update({
            content: '🔇 靜音音頻已經在播放中',
            components: [buildSilenceMenu(guildId)],
          });
        }

        startSilenceLayer(guildId);
        await interaction.update({
          content: '🔇 **已開始播放靜音音頻**，防止被踢出頻道',
          components: [buildSilenceMenu(guildId)],
        });
      }

      // ── stop ────────────────────────────────────────
      else if (selected === 'stop') {
        if (getActiveLayer(guildId) !== 'silence') {
          return interaction.update({
            content: '❌ 目前沒有播放靜音音頻',
            components: [buildSilenceMenu(guildId)],
          });
        }

        stopSilenceLayer(guildId);
        await interaction.update({
          content: '⏹️ **已停止播放靜音音頻**',
          components: [buildSilenceMenu(guildId)],
        });
      }

      // ── auto ────────────────────────────────────────
      else if (selected === 'auto') {
        const connection = getVoiceConnection(guildId);
        if (!connection) {
          return interaction.update({ content: '❌ Bot 不在語音頻道，請先使用 `/join`', components: [] });
        }

        // 重設計時器（若已存在則覆蓋）
        if (silenceTimers.has(guildId)) {
          clearTimeout(silenceTimers.get(guildId));
        }

        const timer = setTimeout(() => {
          const conn = getVoiceConnection(guildId);
          if (conn && getActiveLayer(guildId) !== 'silence') {
            startSilenceLayer(guildId);
            console.log(`🔇 自動開始播放靜音音頻 (guildId: ${guildId})`);
          }
          silenceTimers.delete(guildId);
        }, 5 * 60 * 1000);

        silenceTimers.set(guildId, timer);
        await interaction.update({
          content: '⏰ **已設置自動靜音模式**，5 分鐘後將自動開始播放靜音音頻',
          components: [buildSilenceMenu(guildId)],
        });
      }
    });
  }

  // ── interactionCreate: heyjqn 按鈕（防重複註冊）──────
  if (!heyjqnBound) {
    heyjqnBound = true;

    client.on('interactionCreate', async (interaction) => {
      if (!interaction.isButton()) return;
      if (!interaction.customId.startsWith('heyjqn_record:')) return;

      const guildId    = interaction.guildId;
      const userId     = interaction.user.id;
      const connection = getVoiceConnection(guildId);

      if (!connection) {
        return interaction.reply({ content: '❌ Bot 不在語音頻道，請先 `/join`', ephemeral: true });
      }

      if (!interaction.member?.voice?.channel) {
        return interaction.reply({ content: '❌ 你必須先在語音頻道內', ephemeral: true });
      }

      // TTL 檢查
      const { ts } = parseHeyJqnCustomId(interaction.customId);
      if (ts > 0 && Date.now() - ts > HEYJQN_BTN_TTL_MS) {
        return interaction.reply({ content: '⌛ 這顆按鈕已過期，請重新使用 `/heyjqn`', ephemeral: true });
      }

      // user cooldown
      const cdKey      = `${guildId}:${userId}`;
      const now        = Date.now();
      const availableAt = manualUserCooldown.get(cdKey) || 0;
      if (now < availableAt) {
        const left = ((availableAt - now) / 1000).toFixed(1);
        return interaction.reply({ content: `⏳ 請 ${left}s 後再試`, ephemeral: true });
      }

      // guild lock
      if (manualGuildLocks.get(guildId)) {
        return interaction.reply({ content: '🎙️ 目前有人在錄音，請稍候', ephemeral: true });
      }

      manualGuildLocks.set(guildId, true);
      manualUserCooldown.set(cdKey, now + HEYJQN_USER_COOLDOWN_MS);

      const disabledRow = new ActionRowBuilder().addComponents(
        ButtonBuilder.from(interaction.component).setDisabled(true)
      );

      let updatedMainMessage = false;

      try {
        // 1) 先 disable（避免視覺連點）
        await interaction.update({
          content: '🎙️ 錄音中...（按鈕暫時鎖定）',
          components: [disabledRow],
        });
        updatedMainMessage = true;

        await interaction.followUp({ content: '🎤 已開始錄音，請說話', ephemeral: true });

        // 2) 確保手動 Session
        ensureManualSession(connection, interaction.guild, interaction.channel, async (uid, member, text, channel) => {
          const aiReply = await getGeminiResponseVoice(uid, text);
          await channel.send(`🤖 **機器鳥**：${aiReply}`);
          const ttsResult = await playTTS(guildId, aiReply);
          if (!ttsResult.success) {
            await channel.send(`⚠️ TTS 失敗：${ttsResult.reason}`);
          }
        });

        // 3) 執行錄音流程
        await manualRecordOnce(guildId, userId, interaction.member, interaction.channel);

      } catch (err) {
        console.error('[heyjqn] 按鈕流程錯誤:', err);
        await interaction.followUp({ content: `❌ 手動錄音失敗：${err.message}`, ephemeral: true }).catch(() => {});
      } finally {
        manualGuildLocks.delete(guildId);

        // 4) 自動恢復按鈕可按 + 刷新 customId（延長有效期）
        if (updatedMainMessage) {
          try {
            await interaction.message.edit({
              content: '✅ 可再次點擊開始手動錄音',
              components: [buildHeyJqnButton(guildId, false)],
            });
          } catch (e) {
            console.warn('[heyjqn] 恢復按鈕失敗:', e.message);
          }
        }
      }
    });
  }

  console.log('✅ 語音指令已載入（/join /leave /voice /stt /heyjqn /silence）');
}

module.exports = {
  setupVoiceCommands,
  startSilenceAudio: startSilenceLayer,
  stopSilenceAudio:  stopSilenceLayer,
};