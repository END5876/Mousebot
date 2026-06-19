const {
  getVoiceConnection,
} = require('@discordjs/voice');
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const http = require('http');
const dns  = require('dns').promises;

// audioManager 統一管理 TTS 層
const { playTTSLayer } = require('../audioManager');

// ── TTS 排隊 Map ─────────────────────────────────────────
// 佇列項目結構升級：加入 readyPromise / file / status 欄位，
// 讓播放器能在「合成完成」後立即銜接，實現播放與合成真正並行。
const ttsQueues    = new Map();  // guildId → QueueItem[]
const ttsIsPlaying = new Map();  // guildId → boolean
const activeModels     = new Map();
const activeEdgeVoices = new Map();

const TTS_MAX_LENGTH = 1000;

// ── SoVITS 連線設定 ──────────────────────────────────────
const SOVITS_HOST = process.env.SOVITS_HOST || 'localhost';
const SOVITS_PORT = parseInt(process.env.SOVITS_PORT) || 9880;

// SoVITS 健康狀態追蹤
// 記錄 SoVITS 是否可用，避免每次都等 timeout 才 fallback
let sovitsHealthy        = true;   // 樂觀預設可用
let sovitsLastCheckAt    = 0;
const SOVITS_HEALTH_INTERVAL_MS = 30_000;  // 每 30 秒重新探測
const SOVITS_CONNECT_TIMEOUT_MS = 3_000;   // TCP 連線逾時（原本 2000，稍微放寬）
const SOVITS_RECEIVE_TIMEOUT_MS = 30_000;  // 音訊接收逾時

// LRU 文字快取
// 對相同文字+模型的合成結果做記憶體快取，命中時 0 延遲
const TTS_CACHE_MAX  = parseInt(process.env.TTS_CACHE_MAX  || '30');
const TTS_CACHE_TTL_MS = parseInt(process.env.TTS_CACHE_TTL_MS || String(10 * 60 * 1000));
// key: `${modelKey}::${text}` → { file, engine, voice, model, createdAt }
const ttsCache = new Map();

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
    console.log(`🌐 [DNS] ${SOVITS_HOST} → ${cachedSoVITSIP}`);
    return cachedSoVITSIP;
  } catch (err) {
    console.warn(`⚠️ [DNS] 解析失敗: ${err.message}，使用原始 hostname`);
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

let hasEdgeTTS = false;
function checkEdgeTTS() {
  try { execSync('edge-tts --version', { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// ════════════════════════════════════════════════════════
//  句子分段工具
//  將長文字切割為短句，讓第一句能盡快合成並播放，
//  後續句子在播放時並行合成，大幅降低感知延遲。
// ════════════════════════════════════════════════════════

/**
 * 將文字按句子邊界分割，每段不超過 maxLen 字。
 * 分割優先順序：句號/問號/驚嘆號 > 逗號/分號 > 空白
 * @param {string} text
 * @param {number} maxLen 每段最大字數（預設 50）
 * @returns {string[]}
 */
function splitSentences(text, maxLen = 50) {
  if (!text || text.trim().length === 0) return [];

  // 先按主要句子邊界切割
  const primary = text
    .split(/(?<=[。！？!?\n])\s*/)
    .map(s => s.trim())
    .filter(Boolean);

  const result = [];

  for (const seg of primary) {
    if (seg.length <= maxLen) {
      result.push(seg);
      continue;
    }

    // 超長段落再按次要邊界切割
    const secondary = seg
      .split(/(?<=[，,；;、])\s*/)
      .map(s => s.trim())
      .filter(Boolean);

    let buf = '';
    for (const part of secondary) {
      if ((buf + part).length > maxLen && buf.length > 0) {
        result.push(buf);
        buf = part;
      } else {
        buf += part;
      }
    }
    if (buf) result.push(buf);
  }

  return result.filter(s => s.length > 0);
}

// ════════════════════════════════════════════════════════
//  LRU 快取工具
// ════════════════════════════════════════════════════════

function getCacheKey(text, modelKey) {
  return `${modelKey}::${text}`;
}

/**
 * 從快取取得合成結果。命中時複製檔案到新路徑（避免播放完刪除原始快取檔）。
 * @returns {{ file, engine, voice, model } | null}
 */
async function getCached(text, modelKey, destDir) {
  const key   = getCacheKey(text, modelKey);
  const entry = ttsCache.get(key);
  if (!entry) return null;

  // 檢查 TTL
  if (Date.now() - entry.createdAt > TTS_CACHE_TTL_MS) {
    safeUnlink(entry.file);
    ttsCache.delete(key);
    return null;
  }

  // 檢查檔案是否仍存在
  if (!fs.existsSync(entry.file)) {
    ttsCache.delete(key);
    return null;
  }

  // 複製到新路徑供播放使用（播放後會刪除副本，原始快取保留）
  const ext     = path.extname(entry.file);
  const newFile = path.join(destDir, `tts_cache_${Date.now()}${ext}`);
  try {
    await fs.promises.copyFile(entry.file, newFile);
  } catch {
    ttsCache.delete(key);
    return null;
  }

  // LRU：移到最後（最近使用）
  ttsCache.delete(key);
  ttsCache.set(key, entry);

  console.log(`⚡ [TTS Cache] 命中: ${text.slice(0, 20)}...`);
  return { ...entry, file: newFile };
}

/**
 * 將合成結果存入快取（LRU 淘汰最舊的）。
 */
function putCache(text, modelKey, entry) {
  if (TTS_CACHE_MAX <= 0) return;

  const key = getCacheKey(text, modelKey);

  // 淘汰超出上限的最舊項目
  if (ttsCache.size >= TTS_CACHE_MAX) {
    const oldestKey = ttsCache.keys().next().value;
    const oldest    = ttsCache.get(oldestKey);
    if (oldest) safeUnlink(oldest.file);
    ttsCache.delete(oldestKey);
  }

  // 複製一份專用快取檔案（原始檔案播放後會被刪除）
  const ext       = path.extname(entry.file);
  const cacheFile = entry.file.replace(ext, `_cache${ext}`);
  try {
    fs.copyFileSync(entry.file, cacheFile);
    ttsCache.set(key, { ...entry, file: cacheFile, createdAt: Date.now() });
  } catch {
    // 快取寫入失敗不影響主流程
  }
}

// ════════════════════════════════════════════════════════
//  模型工具
// ════════════════════════════════════════════════════════
function getActiveModel(guildId) {
  const key = activeModels.get(guildId) || DEFAULT_MODEL || Object.keys(TTS_MODELS)[0];
  return { key, ...(TTS_MODELS[key] || {}) };
}

async function switchSoVITSWeights(gptWeights, sovitsWeights) {
  const resolvedIP = await resolveSoVITSHost();

  const callAPI = (apiPath) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(new Error('切換模型逾時')); }, 15000);
    const req = http.request({
      hostname: resolvedIP, port: SOVITS_PORT, path: apiPath,
      method: 'GET', headers: { Host: SOVITS_HOST },
    }, (res) => {
      clearTimeout(timer);
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(body);
        else reject(new Error(`HTTP ${res.statusCode}: ${body}`));
      });
    });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.end();
  });

  console.log(`🔄 [SoVITS] 切換 GPT: ${gptWeights}`);
  await callAPI(`/set_gpt_weights?weights_path=${encodeURIComponent(gptWeights)}`);
  console.log(`🔄 [SoVITS] 切換 SoVITS: ${sovitsWeights}`);
  await callAPI(`/set_sovits_weights?weights_path=${encodeURIComponent(sovitsWeights)}`);
}

// ════════════════════════════════════════════════════════
//  SoVITS 健康檢查
//  定期探測 SoVITS 是否可用，避免每次都等 timeout 才 fallback
// ════════════════════════════════════════════════════════
async function checkSoVITSHealth() {
  const now = Date.now();
  if (now - sovitsLastCheckAt < SOVITS_HEALTH_INTERVAL_MS) return sovitsHealthy;

  sovitsLastCheckAt = now;
  const resolvedIP  = await resolveSoVITSHost();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      req.destroy();
      if (sovitsHealthy) console.warn('⚠️ [SoVITS] 健康檢查逾時，標記為不可用');
      sovitsHealthy = false;
      resolve(false);
    }, SOVITS_CONNECT_TIMEOUT_MS);

    const req = http.request(
      { hostname: resolvedIP, port: SOVITS_PORT, path: '/', method: 'GET', headers: { Host: SOVITS_HOST } },
      (res) => {
        clearTimeout(timer);
        res.resume();
        if (!sovitsHealthy) console.log('✅ [SoVITS] 服務已恢復');
        sovitsHealthy = true;
        resolve(true);
      }
    );
    req.on('error', () => {
      clearTimeout(timer);
      if (sovitsHealthy) console.warn('⚠️ [SoVITS] 健康檢查失敗，標記為不可用');
      sovitsHealthy = false;
      resolve(false);
    });
    req.end();
  });
}

// ════════════════════════════════════════════════════════
//  TTS 生成核心
// ════════════════════════════════════════════════════════
async function generateSoVITS(text, filename, guildId) {
  const resolvedIP = await resolveSoVITSHost();
  const model = getActiveModel(guildId);

  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      text, text_lang: model.text_lang, ref_audio_path: model.ref_audio,
      prompt_lang: model.prompt_lang, prompt_text: model.prompt_text, media_type: 'wav',
    });

    let settled = false;
    function done(err) {
      if (settled) return; settled = true;
      clearTimeout(connectTimer); clearTimeout(receiveTimer);
      if (err) reject(err); else resolve();
    }

    const connectTimer = setTimeout(() => {
      req.destroy(new Error('SoVITS 連線逾時（Port 無回應，Server 可能關機）'));
    }, SOVITS_CONNECT_TIMEOUT_MS);
    let receiveTimer = null;

    const req = http.request({
      hostname: resolvedIP, port: SOVITS_PORT,
      path: `/tts?${params.toString()}`, method: 'GET', headers: { Host: SOVITS_HOST },
    }, (res) => {
      if (res.statusCode !== 200) { done(new Error(`SoVITS HTTP ${res.statusCode}`)); res.resume(); return; }
      receiveTimer = setTimeout(() => {
        req.destroy(new Error('SoVITS 音訊接收逾時（處理超過 30 秒）'));
      }, SOVITS_RECEIVE_TIMEOUT_MS);
      const fileStream = fs.createWriteStream(filename);
      res.pipe(fileStream);
      fileStream.on('finish', () => done(null));
      fileStream.on('error',  (err) => done(err));
    });

    req.on('socket', (socket) => {
      if (!socket.connecting) {
        clearTimeout(connectTimer);
      } else {
        socket.on('connect', () => {
          clearTimeout(connectTimer);
          console.log('🔌 [SoVITS] TCP 連線成功，等待推理完成...');
        });
      }
    });
    
    req.on('error', (err) => done(err));
    req.end();
  });
}


function generateEdgeTTS(text, filename, voice) {
  return new Promise((resolve, reject) => {
    const proc = spawn('edge-tts', ['--voice', voice, '--text', text, '--write-media', filename, '--rate', '+10%']);
    proc.on('close', (code) => { if (code === 0) resolve(); else reject(new Error(`edge-tts 退出碼: ${code}`)); });
    proc.on('error', reject);
  });
}

/**
 * 合成單一文字片段。
 * 先查健康狀態，不可用時直接走 edge-tts，不等 SoVITS timeout。
 * 合成前查快取，命中則直接返回。
 */
async function generateTTS(text, filename, guildId) {
  const model    = getActiveModel(guildId);
  const tempDir  = path.dirname(filename);

  // 查詢快取
  const cached = await getCached(text, model.key, tempDir);
  if (cached) return cached;

  // 先做健康檢查，已知不可用時跳過 SoVITS
  const healthy = await checkSoVITSHealth();

  if (healthy) {
    try {
      const sovitsFile = filename.replace(/\.\w+$/, '_sovits.wav');
      await generateSoVITS(text, sovitsFile, guildId);
      // SoVITS 成功：標記健康
      sovitsHealthy = true;
      console.log(`✅ [SoVITS][${model.name}] 生成成功: ${text.slice(0, 20)}...`);
      const result = { file: sovitsFile, engine: 'sovits', model: model.name };
      putCache(text, model.key, result);
      return result;
    } catch (err) {
      // SoVITS 失敗：標記不可用，下次直接走 fallback
      sovitsHealthy     = false;
      sovitsLastCheckAt = Date.now();
      console.warn(`⚠️ [SoVITS] 失敗 (${err.message})，切換至 edge-tts`);
    }
  } else {
    console.log(`⚡ [SoVITS] 已知不可用，直接使用 edge-tts`);
  }

  if (!hasEdgeTTS) throw new Error('SoVITS 不可用且 edge-tts 未安裝');

  const voice    = resolveVoice(text, guildId);
  const edgeFile = filename.replace(/\.\w+$/, '_edge.mp3');
  await generateEdgeTTS(text, edgeFile, voice);
  console.log(`✅ [edge-tts] 生成成功: ${text.slice(0, 20)}...`);
  const result = { file: edgeFile, engine: 'edge', voice };
  putCache(text, model.key, result);
  return result;
}

function safeUnlink(f) { try { fs.unlinkSync(f); } catch {} }

// ════════════════════════════════════════════════════════
//  Pipeline 佇列處理
//
//  核心設計：
//  1. playTTS 將文字分段後，每段立即建立一個「佇列項目」並開始非同步合成
//  2. 佇列項目包含 readyPromise（合成完成的 Promise）
//  3. processQueue 等待隊首項目的 readyPromise，合成完成後立即播放
//  4. 播放下一段時，下一段的合成通常已在並行進行中（或已完成）
// ════════════════════════════════════════════════════════

/**
 * @typedef {Object} QueueItem
 * @property {string}  text
 * @property {string}  engine
 * @property {Promise<{file:string, engine:string, voice?:string, model?:string}>} readyPromise
 * @property {{file:string, engine:string, voice?:string, model?:string} | null} result
 * @property {boolean} failed
 */

async function processQueue(guildId) {
  const queue = ttsQueues.get(guildId);
  if (!queue || queue.length === 0) {
    ttsQueues.delete(guildId);
    ttsIsPlaying.delete(guildId);
    return;
  }

  const connection = getVoiceConnection(guildId);
  if (!connection) {
    // 清理所有待播放項目（合成結果可能尚未完成，等 Promise settle 後刪除）
    const items = [...queue];
    ttsQueues.delete(guildId);
    ttsIsPlaying.delete(guildId);
    for (const item of items) {
      item.readyPromise.then(r => { if (r?.file) safeUnlink(r.file); }).catch(() => {});
    }
    return;
  }

  ttsIsPlaying.set(guildId, true);

  const item = queue[0];

  // 等待隊首項目的合成完成（若已完成則立即繼續）
  let result;
  try {
    result = await item.readyPromise;
  } catch (err) {
    console.error(`❌ [TTS] 合成失敗，跳過此段: ${err.message}`);
    queue.shift();
    ttsIsPlaying.delete(guildId);
    processQueue(guildId);
    return;
  }

  if (!result?.file) {
    queue.shift();
    ttsIsPlaying.delete(guildId);
    processQueue(guildId);
    return;
  }

  const ok = playTTSLayer(guildId, result.file, () => {
    safeUnlink(result.file);
    queue.shift();
    ttsIsPlaying.delete(guildId);
    processQueue(guildId);
  });

  if (!ok) {
    safeUnlink(result.file);
    queue.shift();
    ttsIsPlaying.delete(guildId);
    processQueue(guildId);
  }
}

// ════════════════════════════════════════════════════════
//  公開 API：playTTS
// ════════════════════════════════════════════════════════

/**
 * 主要入口。
 * 將文字分段，每段立即啟動非同步合成並加入佇列，
 * 第一段合成完成後立即開始播放，後續段落並行合成。
 */
async function playTTS(guildId, text) {
  const connection = getVoiceConnection(guildId);
  if (!connection) return { success: false, reason: 'no_connection' };

  const tempDir = path.join(__dirname, '../temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  // 分段
  const segments = splitSentences(text);
  if (segments.length === 0) return { success: false, reason: 'empty_text' };

  if (!ttsQueues.has(guildId)) ttsQueues.set(guildId, []);
  const queue     = ttsQueues.get(guildId);
  const wasEmpty  = queue.length === 0 && !ttsIsPlaying.has(guildId);

  // 記錄第一段的引擎資訊（用於回傳）
  let firstEngine = 'unknown';
  let firstModel  = null;
  let firstVoice  = null;

  // ✨ 新增一個變數來追蹤「上一個合成任務」，避免併發塞爆 SoVITS
  let lastGenerationPromise = Promise.resolve();

  // 將 Promise 串聯起來，確保 SoVITS 是一句接著一句合成
  for (let i = 0; i < segments.length; i++) {
    const seg      = segments[i];
    const baseFile = path.join(tempDir, `tts_${guildId}_${Date.now()}_${i}.tmp`);

    // ✨ 等待上一句「開始合成完畢」後，才啟動這一句的合成
    const readyPromise = lastGenerationPromise.then(() => {
      return generateTTS(seg, baseFile, guildId);
    }).then(result => {
      if (i === 0) {
        firstEngine = result.engine;
        firstModel  = result.model ?? null;
        firstVoice  = result.voice ?? null;
      }
      return result;
    });

    // ✨ 更新追蹤變數，加上 catch 避免某一句失敗導致後續全部卡死
    lastGenerationPromise = readyPromise.catch(() => {});

    queue.push({ text: seg, readyPromise });
  }

  // 如果佇列原本是空的，立即啟動播放（會等第一段的 readyPromise）
  if (wasEmpty) processQueue(guildId);

  // 等第一段合成完成，取得引擎資訊後回傳（讓呼叫端能立即得知結果）
  // 注意：此 await 只等第一段，不阻塞後續段落的並行合成
  try {
    const firstResult = await queue[queue.length - segments.length]?.readyPromise;
    if (firstResult) {
      firstEngine = firstResult.engine;
      firstModel  = firstResult.model ?? null;
      firstVoice  = firstResult.voice ?? null;
    }
  } catch {
    // 第一段合成失敗，processQueue 會自動跳過
  }

  return {
    success:      true,
    queued:       !wasEmpty || segments.length > 1,
    position:     queue.length,
    engine:       firstEngine,
    model:        firstModel,
    detectedLang: detectLanguage(text),
    voice:        firstVoice,
    segments:     segments.length,
  };
}

function stopTTS(guildId) {
  if (ttsQueues.has(guildId)) {
    const items = ttsQueues.get(guildId);
    // 清理時需等 readyPromise settle 後才能刪除檔案
    for (const item of items) {
      item.readyPromise.then(r => { if (r?.file) safeUnlink(r.file); }).catch(() => {});
    }
    ttsQueues.delete(guildId);
  }
  ttsIsPlaying.delete(guildId);
  return true;
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

// ════════════════════════════════════════════════════════
//  setupTTSCommands
// ════════════════════════════════════════════════════════
function setupTTSCommands(client) {
  const count = loadModelsFromEnv();
  console.log(`📦 從 .env 載入了 ${count} 個 TTS 模型: ${Object.keys(TTS_MODELS).join(', ')}`);
  if (count === 0) console.warn('⚠️ 未找到任何 SOVITS_MODEL_* 設定，請檢查 .env');

  hasEdgeTTS = checkEdgeTTS();
  console.log(hasEdgeTTS ? '✅ edge-tts 已就緒（作為 fallback）' : '⚠️ edge-tts 未安裝，fallback 不可用');
  console.log(`🎙️ GPT-SoVITS 目標: http://${SOVITS_HOST}:${SOVITS_PORT}`);

  resolveSoVITSHost().then(ip => {
    console.log(`✅ [DNS] 預解析完成: ${SOVITS_HOST} → ${ip}`);
    // 啟動時立即做一次健康檢查，確認 SoVITS 狀態
    checkSoVITSHealth().then(ok => {
      console.log(ok ? '✅ [SoVITS] 服務正常' : '⚠️ [SoVITS] 服務不可用，將使用 edge-tts fallback');
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
            content: '❌ Bot 不在語音頻道！請先使用 `/join` 加入',
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
        if (!hasEdgeTTS) {
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

  console.log('✅ TTS Slash Commands 已載入（/tts say / stop / model / edgevoice）');
}

module.exports = { setupTTSCommands, playTTS, stopTTS };