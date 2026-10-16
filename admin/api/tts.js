'use strict';
// admin/api/tts.js — TTS 語音：各伺服器的 SoVITS 模型、edge-tts 聲音、AI 回覆朗讀開關、試聽
// 設定與 /tts model、/tts edgevoice、/ai tts 共用（存在 data/ttsSettings.json、data/aiTTS.json）

const { TTS_MODELS, DEFAULT_MODEL, activeModels, getActiveModel } = require('../../handlers/voice/ttsHandler/models');
const { EDGE_VOICE_CHOICES, activeEdgeVoices, getHasEdgeTTS } = require('../../handlers/voice/ttsHandler/edgeTTS');
const { SOVITS_HOST, SOVITS_PORT, checkSoVITSHealth } = require('../../handlers/voice/ttsHandler/sovitsClient');
const { setGuildModel, setGuildEdgeVoice } = require('../../handlers/voice/ttsHandler/settings');
const { playTTS } = require('../../handlers/voice/ttsHandler');
const { isAITTSEnabled, setAITTSEnabled } = require('../../handlers/ai/aiUtils');
const { guildSummary } = require('../discordInfo');
const { voiceInfo } = require('../voiceState');
const { HttpError, bool, snowflake, str, requireReady } = require('../http');

const MAX_SAY = 200;
const SAY_FAIL = {
  no_connection: 'Bot 不在這個伺服器的語音頻道',
  empty_text: '沒有可以朗讀的文字',
  tts_failed: 'TTS 生成失敗（SoVITS 離線且 edge-tts 不可用）',
};

module.exports = function registerTts(router, client) {
  const guildOf = (params) => {
    requireReady(client);
    const guild = client.guilds.cache.get(snowflake(params.guildId, '伺服器'));
    if (!guild) throw new HttpError(404, 'Bot 不在這個伺服器');
    return guild;
  };
  const voiceName = (value) => EDGE_VOICE_CHOICES.find((v) => v.value === value)?.name ?? value;

  router.get('/api/tts', async () => {
    requireReady(client);
    const online = await checkSoVITSHealth(); // 30 秒內有檢查過就直接用結果
    return {
      sovits: {
        host: `${SOVITS_HOST}:${SOVITS_PORT}`,
        online,
        defaultModel: DEFAULT_MODEL || null,
        models: Object.entries(TTS_MODELS).map(([key, m]) => ({ key, name: m.name })),
      },
      edge: { available: getHasEdgeTTS(), voices: EDGE_VOICE_CHOICES },
      guilds: [...client.guilds.cache.values()]
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
        .map((guild) => ({
          ...guildSummary(guild),
          model: activeModels.get(guild.id) ?? null,
          effectiveModel: getActiveModel(guild.id).key ?? null,
          edgeVoice: activeEdgeVoices.get(guild.id) ?? null,
          aiTTS: isAITTSEnabled(guild.id),
          inVoice: !!voiceInfo(guild),
        })),
    };
  });

  // 切換模型會讓 SoVITS 伺服器載入新的權重（一次只能載入一組，影響所有伺服器），可能要十幾秒
  router.put('/api/tts/:guildId/model', async ({ params, body, audit }) => {
    const guild = guildOf(params);
    const key = str(body.key, '模型', { max: 64 }).toLowerCase();
    let model;
    try {
      model = await setGuildModel(guild.id, key);
    } catch (err) {
      if (err.code === 'EINVAL') throw new HttpError(400, err.message);
      throw new HttpError(502, `切換失敗：${err.message}`);
    }
    audit(`把「${guild.name}」的 SoVITS 模型切換為「${model.name}」`);
    return { model: key };
  });

  // body：{ voice: string | null }；null＝依文字語言自動選擇
  router.put('/api/tts/:guildId/edge-voice', ({ params, body, audit }) => {
    const guild = guildOf(params);
    const voice = body.voice === null ? null : str(body.voice, '聲音', { max: 64 });
    try {
      setGuildEdgeVoice(guild.id, voice);
    } catch (err) {
      if (err.code === 'EINVAL') throw new HttpError(400, err.message);
      throw err;
    }
    audit(`把「${guild.name}」的 edge-tts 聲音設為「${voice ? voiceName(voice) : '依語言自動選擇'}」`);
    return { voice };
  });

  router.put('/api/tts/:guildId/ai-tts', ({ params, body, audit }) => {
    const guild = guildOf(params);
    const enabled = bool(body.enabled, 'AI 回覆朗讀');
    setAITTSEnabled(guild.id, enabled);
    audit(`${enabled ? '開啟' : '關閉'}「${guild.name}」的 AI 回覆朗讀`);
    return { enabled };
  });

  // 試聽：讓 Bot 在語音頻道念一句（走正常的 TTS 排隊，會暫停正在播的音樂）
  router.post('/api/tts/:guildId/say', async ({ params, body, audit }) => {
    const guild = guildOf(params);
    const text = str(body.text, '試聽文字', { max: MAX_SAY });
    const result = await playTTS(guild.id, text);
    if (!result.success) throw new HttpError(409, SAY_FAIL[result.reason] ?? `TTS 失敗：${result.reason}`);
    audit(`在「${guild.name}」試聽 TTS：「${text}」`);
    return { engine: result.engine ?? null };
  });
};
