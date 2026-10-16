'use strict';

// ════════════════════════════════════════════════════════
//  各伺服器的 TTS 設定：SoVITS 模型、edge-tts 聲音
//  （/tts model、/tts edgevoice 與管理面板共用，存在 data/ttsSettings.json）
//
//  過去只放在記憶體，重新部署後會回到預設模型：SoVITS 伺服器卻還載著之前切換的權重，
//  參考音訊與權重對不上，合成出來的聲音會不對。
//  注意：SoVITS 伺服器一次只載入一組權重，切換模型會影響所有伺服器（「目前模型」仍記在各伺服器上）。
// ════════════════════════════════════════════════════════
const path = require('path');
const logger = require('../../../utils/logger');
const { readJson, writeJsonAtomic } = require('../../../utils/jsonStore');
const { TTS_MODELS, activeModels } = require('./models');
const { EDGE_VOICE_CHOICES, activeEdgeVoices } = require('./edgeTTS');
const { switchSoVITSWeights } = require('./sovitsClient');
const { ttsCache } = require('./cache');

const SETTINGS_PATH = path.join(__dirname, '..', '..', '..', 'data', 'ttsSettings.json');

const invalid = (message) => Object.assign(new Error(message), { code: 'EINVAL' });

function save() {
  try {
    writeJsonAtomic(SETTINGS_PATH, {
      models: Object.fromEntries(activeModels),
      edgeVoices: Object.fromEntries(activeEdgeVoices),
    });
  } catch (err) {
    logger.warn('TTS', `儲存 TTS 設定失敗：${err.message}`);
  }
}

/** 還原各伺服器的設定。須在 loadModelsFromEnv() 之後呼叫；.env 已經沒有的模型、不支援的聲音會略過 */
function loadTtsSettings() {
  const saved = readJson(SETTINGS_PATH, {}) || {};
  const voices = new Set(EDGE_VOICE_CHOICES.map(v => v.value));
  for (const [guildId, key] of Object.entries(saved.models || {})) {
    if (TTS_MODELS[key]) activeModels.set(guildId, key);
  }
  for (const [guildId, voice] of Object.entries(saved.edgeVoices || {})) {
    if (voices.has(voice)) activeEdgeVoices.set(guildId, voice);
  }
  logger.debug('TTS', `已還原 ${activeModels.size} 個伺服器的模型、${activeEdgeVoices.size} 個伺服器的 edge-tts 聲音`);
}

/**
 * 切換伺服器使用的 SoVITS 模型：先讓 SoVITS 載入權重，成功後才記錄並存檔
 * @returns {Promise<object>} 模型設定
 */
async function setGuildModel(guildId, key) {
  const model = TTS_MODELS[key];
  if (!model) throw invalid(`找不到模型 ${key}`);
  await switchSoVITSWeights(model.gpt_weights, model.sovits_weights);
  activeModels.set(guildId, key);
  // 切換模型時清空快取，避免舊權重的合成結果被誤用
  for (const [k] of ttsCache) {
    if (k.startsWith(`${key}::`)) ttsCache.delete(k);
  }
  save();
  return model;
}

/** 設定 edge-tts 聲音（SoVITS 離線時的 fallback）；voice 為 null 時恢復依文字語言自動選擇 */
function setGuildEdgeVoice(guildId, voice) {
  if (voice === null) {
    activeEdgeVoices.delete(guildId);
  } else {
    if (!EDGE_VOICE_CHOICES.some(v => v.value === voice)) throw invalid(`不支援的聲音 ${voice}`);
    activeEdgeVoices.set(guildId, voice);
  }
  save();
  logger.info('edge-tts', `🎙️ [${guildId}] 切換聲音 → ${voice ?? '依語言自動選擇'}`);
}

module.exports = { loadTtsSettings, setGuildModel, setGuildEdgeVoice };
