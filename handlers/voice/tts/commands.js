// handlers/voice/tts/commands.js
// 職責：註冊 /tts say / stop / model / edgevoice Slash Commands

const { getVoiceConnection } = require('@discordjs/voice');
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const logger = require('../../../utils/logger');
const bootSummary = require('../../../utils/bootSummary');

const {
  state,
  TTS_MAX_LENGTH,
  SOVITS_HOST, SOVITS_PORT,
  TTS_MODELS, loadModelsFromEnv,
  resolveSoVITSHost,
  EDGE_VOICE_CHOICES,
  checkEdgeTTS,
  buildModelChoices,
  activeModels, activeEdgeVoices,
} = require('./config');
const { ttsCache } = require('./cache');
const { switchSoVITSWeights, checkSoVITSHealth } = require('./generate');
const { playTTS, stopTTS } = require('./queue');

function setupTTSCommands(client) {
  const count = loadModelsFromEnv();
  logger.debug('TTS', `從 .env 載入了 ${count} 個 TTS 模型: ${Object.keys(TTS_MODELS).join(', ')}`);
  if (count === 0) logger.debug('TTS', '未找到任何 SOVITS_MODEL_* 設定');

  state.hasEdgeTTS = checkEdgeTTS();
  logger.debug('TTS', state.hasEdgeTTS ? 'edge-tts 已就緒（作為 fallback）' : 'edge-tts 未安裝，fallback 不可用');
  logger.debug('TTS', `GPT-SoVITS 目標: http://${SOVITS_HOST}:${SOVITS_PORT}`);

  // SoVITS 連線狀態需要非同步的 DNS + 健康檢查才會知道結果，
  // 完成後才回報摘要（clientReady 通常會晚於這個檢查完成，時序上沒問題）
  resolveSoVITSHost().then(ip => {
    checkSoVITSHealth().then(ok => {
      const modelNote = count > 0 ? `${count} 個模型` : '無自訂模型';
      if (ok) {
        bootSummary.report('文字轉語音 (/tts)', 'ok', `GPT-SoVITS 連線正常（${ip}）｜${modelNote}`);
      } else if (state.hasEdgeTTS) {
        bootSummary.report('文字轉語音 (/tts)', 'warn', `SoVITS 離線，已 fallback 至 edge-tts｜${modelNote}`);
      } else {
        bootSummary.report('文字轉語音 (/tts)', 'off', 'SoVITS 離線且未安裝 edge-tts，TTS 無法運作');
      }
    });
  });

  const modelChoices = buildModelChoices();
  const hasModels    = modelChoices.length > 0;

  const builder = new SlashCommandBuilder()
    .setName('tts')
    .setDescription('GPT-SoVITS 語音合成功能')

    // /tts say
    .addSubcommand(sub =>
      sub.setName('say')
        .setDescription('朗讀文字')
        .addStringOption(opt =>
          opt.setName('text')
            .setDescription(`要朗讀的文字（上限 ${TTS_MAX_LENGTH} 字）`)
            .setRequired(true)
        )
    )

    // /tts stop
    .addSubcommand(sub =>
      sub.setName('stop')
        .setDescription('停止 TTS 並清空排隊')
    )

    // /tts model
    .addSubcommand(sub => {
      sub.setName('model').setDescription('切換 SoVITS TTS 模型');
      sub.addStringOption(o => {
        o.setName('key')
          .setDescription('選擇要切換的模型')
          .setRequired(true);
        if (hasModels) o.addChoices(...modelChoices);
        return o;
      });
      return sub;
    })

    // /tts edgevoice
    .addSubcommand(sub =>
      sub.setName('edgevoice')
        .setDescription('切換 edge-tts fallback 聲音（SoVITS 離線時使用）')
        .addStringOption(opt =>
          opt.setName('voice')
            .setDescription('選擇聲音')
            .setRequired(true)
            .addChoices(...EDGE_VOICE_CHOICES)
        )
    );

  client.commands.set('tts', {
    data: builder,

    async execute(interaction) {
      const sub     = interaction.options.getSubcommand();
      const guildId = interaction.guildId;

      if (!guildId) {
        return interaction.reply({
          content: '❌ 此指令只能在伺服器中使用',
          flags: MessageFlags.Ephemeral,
        });
      }

      // ── /tts say ───────────────────────────────────────
      if (sub === 'say') {
        const text = interaction.options.getString('text');

        if (text.length > TTS_MAX_LENGTH) {
          return interaction.reply({
            content: `❌ 太長！上限 ${TTS_MAX_LENGTH} 字（目前 ${text.length} 字）`,
            flags: MessageFlags.Ephemeral,
          });
        }

        const connection = getVoiceConnection(guildId);
        if (!connection) {
          return interaction.reply({
            content: '❌ Bot 不在語音頻道！請先使用 `/voice join`',
            flags: MessageFlags.Ephemeral,
          });
        }

        await interaction.deferReply();
        const result = await playTTS(guildId, text);

        if (!result.success) {
          const reason = result.reason === 'tts_failed'
            ? '❌ TTS 生成失敗（SoVITS 離線且 edge-tts 不可用）'
            : '❌ Bot 不在語音頻道';
          return interaction.editReply({ content: reason });
        }

        const quotedText = text.split('\n').map(line => `> ${line}`).join('\n');
        await interaction.editReply({
          content: `🔊 **朗讀中**\n${quotedText}`
        });

      }

      // ── /tts stop ──────────────────────────────────────
      else if (sub === 'stop') {
        const stopped = stopTTS(guildId);
        await interaction.reply({
          content: stopped ? '⏹️ 已停止 TTS 並清空排隊' : '❌ 目前沒有 TTS 在播放',
          flags: stopped ? undefined : MessageFlags.Ephemeral,
        });
      }

      // ── /tts model ─────────────────────────────────────
      else if (sub === 'model') {
        const key = interaction.options.getString('key').trim().toLowerCase();

        if (!TTS_MODELS[key]) {
          const available = Object.keys(TTS_MODELS).map(k => `\`${k}\``).join(', ');
          return interaction.reply({
            content: `❌ 找不到模型 \`${key}\`\n可用：${available}`,
            flags: MessageFlags.Ephemeral,
          });
        }

        const model = TTS_MODELS[key];
        await interaction.deferReply();

        try {
          await switchSoVITSWeights(model.gpt_weights, model.sovits_weights);
          activeModels.set(guildId, key);
          // 切換模型時清空快取，避免舊模型的合成結果被誤用
          for (const [k] of ttsCache) {
            if (k.startsWith(`${key}::`)) ttsCache.delete(k);
          }
          await interaction.editReply({ content: `✅ 已切換至 **${model.name}**！` });
        } catch (err) {
          console.error('❌ 切換模型失敗:', err.message);
          await interaction.editReply({ content: `❌ 切換失敗：${err.message}` });
        }
      }

      // ── /tts edgevoice ─────────────────────────────────
      else if (sub === 'edgevoice') {
        if (!state.hasEdgeTTS) {
          return interaction.reply({
            content: '❌ edge-tts 未安裝，無法設定聲音',
            flags: MessageFlags.Ephemeral,
          });
        }

        const voice      = interaction.options.getString('voice');
        const voiceLabel = EDGE_VOICE_CHOICES.find(v => v.value === voice)?.name ?? voice;

        activeEdgeVoices.set(guildId, voice);
        console.log(`🎙️ [edge-tts][${guildId}] 切換聲音 → ${voice}`);

        await interaction.reply({
          content:
            `✅ edge-tts 聲音已切換為 **${voiceLabel}**\n` +
            `> \`${voice}\`\n` +
            `> ⚠️ 此設定僅在 SoVITS 離線時的 fallback 生效`,
        });
      }
    }
  });

  logger.debug('TTS', 'Slash Commands 已載入（/tts say / stop / model / edgevoice）');
}

module.exports = { setupTTSCommands };
