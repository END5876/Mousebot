'use strict';

// ════════════════════════════════════════════════════════
//  TTS 模型（GPT-SoVITS）設定與狀態
// ════════════════════════════════════════════════════════
const activeModels = new Map();

// ════════════════════════════════════════════════════════
//  模型載入
// ════════════════════════════════════════════════════════
const TTS_MODELS = {};

function loadModelsFromEnv() {
  const prefix = 'SOVITS_MODEL_';
  const fields = ['NAME', 'GPT', 'SOVITS', 'REF_AUDIO', 'PROMPT_TEXT', 'PROMPT_LANG', 'TEXT_LANG'];
  const found  = new Set();

  for (const envKey of Object.keys(process.env)) {
    if (!envKey.startsWith(prefix)) continue;
    const rest = envKey.slice(prefix.length);
    for (const f of fields) {
      if (rest.endsWith(`_${f}`)) {
        const modelKey = rest.slice(0, rest.length - f.length - 1).toLowerCase();
        found.add(modelKey);
        break;
      }
    }
  }

  for (const key of found) {
    const getVal = (field) => {
      const match = Object.keys(process.env).find(
        e => e.toLowerCase() === `${prefix}${key}_${field}`.toLowerCase()
      );
      return match ? process.env[match] : '';
    };

    TTS_MODELS[key] = {
      name:           getVal('NAME') || key,
      gpt_weights:    getVal('GPT'),
      sovits_weights: getVal('SOVITS'),
      ref_audio:      getVal('REF_AUDIO'),
      prompt_text:    getVal('PROMPT_TEXT'),
      prompt_lang:    getVal('PROMPT_LANG') || 'zh',
      text_lang:      getVal('TEXT_LANG')   || 'zh',
    };
  }

  return Object.keys(TTS_MODELS).length;
}

const DEFAULT_MODEL = (process.env.SOVITS_DEFAULT_MODEL || '').toLowerCase();

// ════════════════════════════════════════════════════════
//  模型工具
// ════════════════════════════════════════════════════════
function getActiveModel(guildId) {
  const key = activeModels.get(guildId) || DEFAULT_MODEL || Object.keys(TTS_MODELS)[0];
  return { key, ...(TTS_MODELS[key] || {}) };
}

// ════════════════════════════════════════════════════════
//  buildModelChoices
// ════════════════════════════════════════════════════════
function buildModelChoices() {
  return Object.entries(TTS_MODELS)
    .slice(0, 25)
    .map(([key, m]) => ({
      name:  m.name.slice(0, 100),
      value: key,
    }));
}

module.exports = {
  TTS_MODELS,
  DEFAULT_MODEL,
  activeModels,
  loadModelsFromEnv,
  getActiveModel,
  buildModelChoices
};
