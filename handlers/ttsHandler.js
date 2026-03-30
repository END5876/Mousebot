const {
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType
} = require('@discordjs/voice');
const { PREFIX } = require('../config/settings');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const dns = require('dns').promises;

// ── TTS 播放器 / 排隊 Map ────────────────────────────────
const ttsPlayers  = new Map();
const ttsQueues   = new Map();

// ── 目前啟用的模型（每個 Guild 各自獨立）─────────────────
const activeModels = new Map();

// ── 字數上限 ─────────────────────────────────────────────
const TTS_MAX_LENGTH = 1000;

// ── SoVITS 連線設定 ──────────────────────────────────────
const SOVITS_HOST = process.env.SOVITS_HOST || 'localhost';
const SOVITS_PORT = parseInt(process.env.SOVITS_PORT) || 9880;

// ── 從 .env 掃描所有模型 ─────────────────────────────────
//    格式: SOVITS_MODEL_{key}_{FIELD}
//    例如: SOVITS_MODEL_manbo_NAME=Manbo
// ────────────────────────────────────────────────────────
const TTS_MODELS = {};

function loadModelsFromEnv() {
  const prefix = 'SOVITS_MODEL_';
  const fields = ['NAME', 'GPT', 'SOVITS', 'REF_AUDIO', 'PROMPT_TEXT', 'PROMPT_LANG', 'TEXT_LANG'];
  const found  = new Set();

  // 先收集所有 key
  for (const envKey of Object.keys(process.env)) {
    if (!envKey.startsWith(prefix)) continue;
    const rest = envKey.slice(prefix.length);          // e.g. "manbo_NAME"
    const lastUnderscore = rest.lastIndexOf('_');
    if (lastUnderscore === -1) continue;

    const field = rest.slice(lastUnderscore + 1);      // e.g. "NAME"
    // 處理像 PROMPT_TEXT、PROMPT_LANG、TEXT_LANG、REF_AUDIO 這種多底線欄位
    // 策略：從已知 fields 反向比對
    let matchedField = null;
    let modelKey = null;
    for (const f of fields) {
      if (envKey === `${prefix}${rest}` && rest.endsWith(`_${f}`)) {
        matchedField = f;
        modelKey = rest.slice(0, rest.length - f.length - 1).toLowerCase();
        break;
      }
    }
    if (matchedField && modelKey) {
      found.add(modelKey);
    }
  }

  // 再逐一讀取
  for (const key of found) {
    // 找出 .env 中這個 key 用的原始大小寫
    // 因為 key 已經 toLowerCase，需要重新匹配原始 env key 的 casing
    const envPrefix = `SOVITS_MODEL_`;
    
    // 直接用 key 去讀（.env 中 key 部分保持原樣）
    const getVal = (field) => {
      // 嘗試原始 key
      const tryKeys = [
        `${envPrefix}${key}_${field}`,
        // 也嘗試保留原始大小寫的版本
      ];
      for (const k of tryKeys) {
        // process.env 在 Windows 不分大小寫，但 Linux 分
        // 所以我們遍歷所有 env key 做 case-insensitive 比對
        const match = Object.keys(process.env).find(
          e => e.toLowerCase() === k.toLowerCase()
        );
        if (match) return process.env[match];
      }
      return '';
    };

    TTS_MODELS[key] = {
      name:           getVal('NAME') || key,
      gpt_weights:    getVal('GPT'),
      sovits_weights: getVal('SOVITS'),
      ref_audio:      getVal('REF_AUDIO'),
      prompt_text:    getVal('PROMPT_TEXT'),
      prompt_lang:    getVal('PROMPT_LANG') || 'zh',
      text_lang:      getVal('TEXT_LANG') || 'zh',
    };
  }

  return Object.keys(TTS_MODELS).length;
}

const DEFAULT_MODEL = (process.env.SOVITS_DEFAULT_MODEL || '').toLowerCase();

// ── DNS 快取 ─────────────────────────────────────────────
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

// ── edge-tts fallback 語音設定 ────────────────────────────
const VOICE_MAP = {
  zh: 'zh-CN-shaanxi-XiaoniNeural',
  en: 'zh-CN-shaanxi-XiaoniNeural',
  ja: 'ja-JP-KeitaNeural',
};
const DEFAULT_VOICE = 'zh-CN-shaanxi-XiaoniNeural';

function detectLanguage(text) {
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'ja';
  if (/[\u4E00-\u9FFF]/.test(text)) return 'zh';
  if (/^[A-Za-z0-9\s.,!?'"()\-:;@#$%&*+=/\\[\]{}|<>~`^_]+$/.test(text.trim())) return 'en';
  return 'zh';
}

function resolveVoice(text) {
  return VOICE_MAP[detectLanguage(text)] ?? DEFAULT_VOICE;
}

let hasEdgeTTS = false;
function checkEdgeTTS() {
  try { execSync('edge-tts --version', { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// ── 取得 Guild 目前的模型設定 ──────────────────────────────
function getActiveModel(guildId) {
  const key = activeModels.get(guildId) || DEFAULT_MODEL || Object.keys(TTS_MODELS)[0];
  return { key, ...(TTS_MODELS[key] || {}) };
}

// ── 呼叫 SoVITS API 切換權重 ──────────────────────────────
async function switchSoVITSWeights(gptWeights, sovitsWeights) {
  const resolvedIP = await resolveSoVITSHost();

  const callAPI = (apiPath) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy(new Error('切換模型逾時'));
    }, 15000);

    const req = http.request({
      hostname: resolvedIP,
      port:     SOVITS_PORT,
      path:     apiPath,
      method:   'GET',
      headers:  { Host: SOVITS_HOST },
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

// ── GPT-SoVITS 生成 TTS ────────────────────────────────────
async function generateSoVITS(text, filename, guildId) {
  const resolvedIP = await resolveSoVITSHost();
  const model = getActiveModel(guildId);

  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      text,
      text_lang:      model.text_lang,
      ref_audio_path: model.ref_audio,
      prompt_lang:    model.prompt_lang,
      prompt_text:    model.prompt_text,
      media_type:     'wav',
    });

    let settled = false;
    function done(err) {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(receiveTimer);
      if (err) reject(err); else resolve();
    }

    const connectTimer = setTimeout(() => {
      req.destroy(new Error('SoVITS 連線逾時（Port 無回應，Server 可能關機）'));
    }, 2000);
    let receiveTimer = null;

    const req = http.request({
      hostname: resolvedIP,
      port:     SOVITS_PORT,
      path:     `/tts?${params.toString()}`,
      method:   'GET',
      headers:  { Host: SOVITS_HOST },
    }, (res) => {
      if (res.statusCode !== 200) {
        done(new Error(`SoVITS HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      receiveTimer = setTimeout(() => {
        req.destroy(new Error('SoVITS 音訊接收逾時（處理超過 30 秒）'));
      }, 30000);

      const fileStream = fs.createWriteStream(filename);
      res.pipe(fileStream);
      fileStream.on('finish', () => done(null));
      fileStream.on('error',  (err) => done(err));
    });

    req.on('socket', (socket) => {
      socket.on('connect', () => {
        clearTimeout(connectTimer);
        console.log('🔌 [SoVITS] TCP 連線成功，等待推理完成...');
      });
    });

    req.on('error', (err) => done(err));
    req.end();
  });
}

// ── edge-tts 生成 ──────────────────────────────────────────
function generateEdgeTTS(text, filename, voice) {
  return new Promise((resolve, reject) => {
    const proc = spawn('edge-tts', [
      '--voice', voice, '--text', text, '--write-media', filename
    ]);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`edge-tts 退出碼: ${code}`));
    });
    proc.on('error', reject);
  });
}

// ── 統一 TTS 生成 ──────────────────────────────────────────
async function generateTTS(text, filename, guildId) {
  try {
    const sovitsFile = filename.replace(/\.\w+$/, '_sovits.wav');
    await generateSoVITS(text, sovitsFile, guildId);
    const model = getActiveModel(guildId);
    console.log(`✅ [SoVITS][${model.name}] 生成成功: ${text.slice(0, 20)}...`);
    return { file: sovitsFile, engine: 'sovits', model: model.name };
  } catch (err) {
    console.warn(`⚠️ [SoVITS] 失敗 (${err.message})，切換至 edge-tts`);
  }

  if (!hasEdgeTTS) throw new Error('SoVITS 不可用且 edge-tts 未安裝');

  const voice = resolveVoice(text);
  const edgeFile = filename.replace(/\.\w+$/, '_edge.mp3');
  await generateEdgeTTS(text, edgeFile, voice);
  console.log(`✅ [edge-tts] 生成成功: ${text.slice(0, 20)}...`);
  return { file: edgeFile, engine: 'edge', voice };
}

// ── 安全刪除 ──────────────────────────────────────────────
function safeUnlink(f) { try { fs.unlinkSync(f); } catch {} }

// ── Queue 處理 ────────────────────────────────────────────
async function processQueue(guildId) {
  const queue = ttsQueues.get(guildId);
  if (!queue || queue.length === 0) { ttsQueues.delete(guildId); return; }

  const { filename } = queue[0];
  const connection = getVoiceConnection(guildId);

  if (!connection) {
    for (const item of queue) safeUnlink(item.filename);
    ttsQueues.delete(guildId);
    ttsPlayers.delete(guildId);
    return;
  }

  const player   = createAudioPlayer();
  const resource = createAudioResource(filename, { inputType: StreamType.Arbitrary });

  player.play(resource);
  connection.subscribe(player);
  ttsPlayers.set(guildId, player);

  player.on(AudioPlayerStatus.Idle, () => {
    safeUnlink(filename); queue.shift(); ttsPlayers.delete(guildId);
    processQueue(guildId);
  });

  player.on('error', (err) => {
    console.error(`❌ [${guildId}] TTS 播放錯誤:`, err.message);
    safeUnlink(filename); queue.shift(); ttsPlayers.delete(guildId);
    processQueue(guildId);
  });
}

// ── 播放 TTS ──────────────────────────────────────────────
async function playTTS(guildId, text) {
  const connection = getVoiceConnection(guildId);
  if (!connection) return { success: false, reason: 'no_connection' };

  const tempDir = path.join(__dirname, '../temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const baseFile = path.join(tempDir, `tts_${guildId}_${Date.now()}.tmp`);

  let result;
  try {
    result = await generateTTS(text, baseFile, guildId);
  } catch (err) {
    console.error('❌ TTS 全部失敗:', err.message);
    return { success: false, reason: 'tts_failed' };
  }

  if (!ttsQueues.has(guildId)) ttsQueues.set(guildId, []);
  const queue     = ttsQueues.get(guildId);
  const isPlaying = ttsPlayers.has(guildId);

  queue.push({ text, filename: result.file, engine: result.engine });
  if (!isPlaying) processQueue(guildId);

  return {
    success: true, queued: queue.length > 1, position: queue.length,
    engine: result.engine, model: result.model ?? null,
    detectedLang: detectLanguage(text), voice: result.voice ?? null,
  };
}

// ── 停止 TTS ──────────────────────────────────────────────
function stopTTS(guildId) {
  if (ttsQueues.has(guildId)) {
    for (const item of ttsQueues.get(guildId)) safeUnlink(item.filename);
    ttsQueues.delete(guildId);
  }
  if (ttsPlayers.has(guildId)) {
    try { ttsPlayers.get(guildId).stop(); } catch {}
    ttsPlayers.delete(guildId);
    return true;
  }
  return false;
}

// ── 主設定 ────────────────────────────────────────────────
function setupTTSCommands(client) {
  // 載入模型
  const count = loadModelsFromEnv();
  console.log(`📦 從 .env 載入了 ${count} 個 TTS 模型: ${Object.keys(TTS_MODELS).join(', ')}`);

  if (count === 0) {
    console.warn('⚠️ 未找到任何 SOVITS_MODEL_* 設定，請檢查 .env');
  }

  hasEdgeTTS = checkEdgeTTS();
  if (!hasEdgeTTS) {
    console.warn('⚠️ edge-tts 未安裝，fallback 不可用');
  } else {
    console.log('✅ edge-tts 已就緒（作為 fallback）');
  }

  console.log(`🎙️ GPT-SoVITS 目標: http://${SOVITS_HOST}:${SOVITS_PORT}`);

  resolveSoVITSHost().then(ip => {
    console.log(`✅ [DNS] 預解析完成: ${SOVITS_HOST} → ${ip}`);
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const content = message.content;
    const guildId = message.guild?.id;
    if (!guildId) return;

    // ── !mmodels → 列出所有模型 ──────────────────────────
    if (content === `${PREFIX}mmodels`) {
      const modelKeys = Object.keys(TTS_MODELS);
      if (modelKeys.length === 0) {
        return message.reply('❌ 沒有設定任何模型，請檢查 `.env`');
      }

      const current = activeModels.get(guildId) || DEFAULT_MODEL || modelKeys[0];
      const lines = modelKeys.map(key => {
        const m = TTS_MODELS[key];
        const marker = key === current ? ' ◀ 目前' : '';
        return `• \`${key}\` — **${m.name}**${marker}`;
      });

      return message.reply(
        `🎙️ **可用 TTS 模型：**\n${lines.join('\n')}\n\n` +
        `切換：\`${PREFIX}mmodel <名稱>\``
      );
    }

    // ── !mmodel <key> → 切換模型 ─────────────────────────
    if (content.startsWith(`${PREFIX}mmodel `)) {
      const key = content.slice(`${PREFIX}mmodel `.length).trim().toLowerCase();

      if (!TTS_MODELS[key]) {
        const available = Object.keys(TTS_MODELS).map(k => `\`${k}\``).join(', ');
        return message.reply(`❌ 找不到模型 \`${key}\`\n可用：${available}`);
      }

      const model = TTS_MODELS[key];
      const msg = await message.reply(`🔄 正在切換至 **${model.name}**...`);

      try {
        await switchSoVITSWeights(model.gpt_weights, model.sovits_weights);
        activeModels.set(guildId, key);

        await msg.edit(
          `✅ 已切換至 **${model.name}**！\n`
        );
      } catch (err) {
        console.error('❌ 切換模型失敗:', err.message);
        await msg.edit(`❌ 切換失敗：${err.message}`);
      }
      return;
    }

    // ── !m <文字> → TTS ───────────────────────────────────
    if (content.startsWith(`${PREFIX}ms `)) {
      const text = content.slice(`${PREFIX}m `.length).trim();
      if (!text) return message.reply(`❌ 用法：\`${PREFIX}m 你好\``);
      if (text.length > TTS_MAX_LENGTH) {
        return message.reply(`❌ 太長！上限 ${TTS_MAX_LENGTH} 字（目前 ${text.length}）`);
      }

      const connection = getVoiceConnection(guildId);
      if (!connection) {
        return message.reply(`❌ Bot 不在語音頻道！請先 \`${PREFIX}join\``);
      }

      await message.react('🔊');
      const result = await playTTS(guildId, text);

      if (!result.success) {
        await message.reactions.removeAll().catch(() => {});
        if (result.reason === 'tts_failed') {
          return message.reply('❌ TTS 生成失敗（SoVITS 離線且 edge-tts 不可用）');
        }
      }
      return;
    }

    // ── !mstop → 停止 ────────────────────────────────────
    if (content === `${PREFIX}mstop`) {
      const stopped = stopTTS(guildId);
      return message.reply(stopped
        ? '⏹️ 已停止 TTS 並清空排隊'
        : '❌ 目前沒有 TTS 在播放'
      );
    }
  });
}

module.exports = { setupTTSCommands, playTTS, stopTTS };