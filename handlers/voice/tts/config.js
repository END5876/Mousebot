// handlers/voice/tts/config.js
// 職責：環境變數設定、SoVITS 模型載入、DNS 快取、edge-tts 聲音設定、語言偵測
// 從原本 ttsHandler.js 拆出的「設定與靜態資料」區塊

const dns  = require('dns').promises;

// ── 每個 Guild 目前選用的模型 / edge-tts 聲音（跨模組共享的可變狀態）──
const activeModels     = new Map();
const activeEdgeVoices = new Map();

const TTS_MAX_LENGTH = 1000;

// ── SoVITS 連線設定 ──────────────────────────────────────
const SOVITS_HOST = process.env.SOVITS_HOST || 'localhost';
const SOVITS_PORT = parseInt(process.env.SOVITS_PORT) || 9880;

// ── SoVITS 連線逾時設定（供 generate.js 使用）───────────
const SOVITS_CONNECT_TIMEOUT_MS = 3_000;
const SOVITS_RECEIVE_TIMEOUT_MS = 30_000;
const SOVITS_HEALTH_INTERVAL_MS = 30_000;

// LRU 文字快取設定（供 cache.js 使用）
const TTS_CACHE_MAX    = parseInt(process.env.TTS_CACHE_MAX  || '30');
const TTS_CACHE_TTL_MS = parseInt(process.env.TTS_CACHE_TTL_MS || String(10 * 60 * 1000));

// ── 跨模組共享的可變旗標（例如 edge-tts 是否已安裝）──────
// 用物件包裹，讓其他模組可以拿到參照後讀取到最新的值
const state = {
  hasEdgeTTS: false,
};

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
//  DNS 快取
// ════════════════════════════════════════════════════════
let cachedSoVITSIP = null;
let cacheExpireAt  = 0;
const DNS_CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveSoVITSHost() {
  const now = Date.now();
  if (cachedSoVITSIP && now < cacheExpireAt) return cachedSoVITSIP;
  try {
    const resolver = new dns.Resolver();
    resolver.setServers(['8.8.8.8', '1.1.1.1']);
    const addresses = await resolver.resolve4(SOVITS_HOST);
    cachedSoVITSIP = addresses[0];
    cacheExpireAt  = now + DNS_CACHE_TTL_MS;
    require('../../../utils/logger').debug('SoVITS-DNS', `${SOVITS_HOST} → ${cachedSoVITSIP}`);
    return cachedSoVITSIP;
  } catch (err) {
    require('../../../utils/logger').debug('SoVITS-DNS', `解析失敗: ${err.message}，使用原始 hostname`);
    return SOVITS_HOST;
  }
}

// ════════════════════════════════════════════════════════
//  edge-tts 聲音設定
// ════════════════════════════════════════════════════════
const EDGE_VOICE_CHOICES = [
  { name: '🇹🇼 中文 - 雲哲 (男)',   value: 'zh-TW-YunJheNeural'    },
  { name: '🇹🇼 中文 - 曉臻 (女)',   value: 'zh-TW-HsiaoChenNeural' },
  { name: '🇹🇼 中文 - 曉雨 (女)',   value: 'zh-TW-HsiaoYuNeural'   },
  { name: '🇨🇳 中文 - 雲希 (男)',   value: 'zh-CN-YunxiNeural'     },
  { name: '🇨🇳 中文 - 曉小 (女)',   value: 'zh-CN-XiaoxiaoNeural'  },
  { name: '🇨🇳 中文 - 曉伊 (女)',   value: 'zh-CN-XiaoyiNeural'    },
  { name: '🇯🇵 日文 - Keita (男)',  value: 'ja-JP-KeitaNeural'     },
  { name: '🇯🇵 日文 - Nanami (女)', value: 'ja-JP-NanamiNeural'    },
  { name: '🇺🇸 英文 - Guy (男)',    value: 'en-US-GuyNeural'       },
  { name: '🇺🇸 英文 - Jenny (女)',  value: 'en-US-JennyNeural'     },
  { name: '🇺🇸 英文 - Aria (女)',   value: 'en-US-AriaNeural'      },
  { name: '🇬🇧 英文 - Ryan (男)',   value: 'en-GB-RyanNeural'      },
  { name: '🇬🇧 英文 - Sonia (女)',  value: 'en-GB-SoniaNeural'     },
  { name: '🇰🇷 韓文 - InJoon (男)', value: 'ko-KR-InJoonNeural'    },
  { name: '🇰🇷 韓文 - SunHi (女)',  value: 'ko-KR-SunHiNeural'     },
];

const VOICE_MAP     = {
  zh: 'zh-TW-YunJheNeural',
  en: 'en-US-GuyNeural',
  ja: 'ja-JP-KeitaNeural',
};
const DEFAULT_VOICE = 'zh-TW-YunJheNeural';

function detectLanguage(text) {
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'ja';
  if (/[\u4E00-\u9FFF]/.test(text)) return 'zh';
  if (/^[A-Za-z0-9\s.,!?'"()\-:;@#$%&*+=/\\\[\]{}|<>~`^_]+$/.test(text.trim())) return 'en';
  return 'zh';
}

function resolveVoice(text, guildId = null) {
  if (guildId && activeEdgeVoices.has(guildId)) {
    return activeEdgeVoices.get(guildId);
  }
  return VOICE_MAP[detectLanguage(text)] ?? DEFAULT_VOICE;
}

function checkEdgeTTS() {
  const { execSync } = require('child_process');
  try { execSync('edge-tts --version', { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function getActiveModel(guildId) {
  const key = activeModels.get(guildId) || DEFAULT_MODEL || Object.keys(TTS_MODELS)[0];
  return { key, ...(TTS_MODELS[key] || {}) };
}

function buildModelChoices() {
  return Object.entries(TTS_MODELS)
    .slice(0, 25)
    .map(([key, m]) => ({
      name:  m.name.slice(0, 100),
      value: key,
    }));
}

module.exports = {
  state,
  activeModels,
  activeEdgeVoices,
  TTS_MAX_LENGTH,
  SOVITS_HOST,
  SOVITS_PORT,
  SOVITS_CONNECT_TIMEOUT_MS,
  SOVITS_RECEIVE_TIMEOUT_MS,
  SOVITS_HEALTH_INTERVAL_MS,
  TTS_CACHE_MAX,
  TTS_CACHE_TTL_MS,
  TTS_MODELS,
  loadModelsFromEnv,
  DEFAULT_MODEL,
  resolveSoVITSHost,
  EDGE_VOICE_CHOICES,
  VOICE_MAP,
  DEFAULT_VOICE,
  detectLanguage,
  resolveVoice,
  checkEdgeTTS,
  getActiveModel,
  buildModelChoices,
};
