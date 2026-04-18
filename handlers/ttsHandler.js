const {
  getVoiceConnection,
} = require('@discordjs/voice');
const { SlashCommandBuilder } = require('discord.js');
const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const http = require('http');
const dns  = require('dns').promises;

// ✅ 改用 audioManager 統一管理 TTS 層
const { playTTSLayer } = require('./audioManager');

// ── TTS 排隊 Map ─────────────────────────────────────────
const ttsQueues    = new Map();
const ttsIsPlaying = new Map();
const activeModels = new Map();

const TTS_MAX_LENGTH = 1000;

// ── SoVITS 連線設定 ──────────────────────────────────────
const SOVITS_HOST = process.env.SOVITS_HOST || 'localhost';
const SOVITS_PORT = parseInt(process.env.SOVITS_PORT) || 9880;

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
//  edge-tts fallback
// ════════════════════════════════════════════════════════
const VOICE_MAP    = { zh: 'zh-TW-YunJheNeural', en: 'zh-TW-YunJheNeural', ja: 'ja-JP-KeitaNeural' };
const DEFAULT_VOICE = 'zh-TW-YunJheNeural';

function detectLanguage(text) {
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'ja';
  if (/[\u4E00-\u9FFF]/.test(text)) return 'zh';
  if (/^[A-Za-z0-9\s.,!?'"()\-:;@#$%&*+=/\\[\]{}|<>~`^_]+$/.test(text.trim())) return 'en';
  return 'zh';
}

function resolveVoice(text) { return VOICE_MAP[detectLanguage(text)] ?? DEFAULT_VOICE; }

let hasEdgeTTS = false;
function checkEdgeTTS() {
  try { execSync('edge-tts --version', { stdio: 'ignore' }); return true; }
  catch { return false; }
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
    }, 2000);
    let receiveTimer = null;

    const req = http.request({
      hostname: resolvedIP, port: SOVITS_PORT,
      path: `/tts?${params.toString()}`, method: 'GET', headers: { Host: SOVITS_HOST },
    }, (res) => {
      if (res.statusCode !== 200) { done(new Error(`SoVITS HTTP ${res.statusCode}`)); res.resume(); return; }
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

function generateEdgeTTS(text, filename, voice) {
  return new Promise((resolve, reject) => {
    const proc = spawn('edge-tts', ['--voice', voice, '--text', text, '--write-media', filename, '--rate', '+10%']);
    proc.on('close', (code) => { if (code === 0) resolve(); else reject(new Error(`edge-tts 退出碼: ${code}`)); });
    proc.on('error', reject);
  });
}

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
  const voice    = resolveVoice(text);
  const edgeFile = filename.replace(/\.\w+$/, '_edge.mp3');
  await generateEdgeTTS(text, edgeFile, voice);
  console.log(`✅ [edge-tts] 生成成功: ${text.slice(0, 20)}...`);
  return { file: edgeFile, engine: 'edge', voice };
}

function safeUnlink(f) { try { fs.unlinkSync(f); } catch {} }

// ════════════════════════════════════════════════════════
//  佇列處理（改用 audioManager.playTTSLayer）
// ════════════════════════════════════════════════════════
async function processQueue(guildId) {
  const queue = ttsQueues.get(guildId);
  if (!queue || queue.length === 0) {
    ttsQueues.delete(guildId);
    ttsIsPlaying.delete(guildId);
    return;
  }

  const { filename } = queue[0];
  const connection = getVoiceConnection(guildId);
  if (!connection) {
    for (const item of queue) safeUnlink(item.filename);
    ttsQueues.delete(guildId);
    ttsIsPlaying.delete(guildId);
    return;
  }

  ttsIsPlaying.set(guildId, true);

  const ok = playTTSLayer(guildId, filename, () => {
    safeUnlink(filename);
    queue.shift();
    ttsIsPlaying.delete(guildId);
    processQueue(guildId);
  });

  if (!ok) {
    safeUnlink(filename);
    queue.shift();
    ttsIsPlaying.delete(guildId);
    processQueue(guildId);
  }
}

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
  const isPlaying = ttsIsPlaying.has(guildId);
  queue.push({ text, filename: result.file, engine: result.engine });
  if (!isPlaying) processQueue(guildId);

  return {
    success: true, queued: queue.length > 1, position: queue.length,
    engine: result.engine, model: result.model ?? null,
    detectedLang: detectLanguage(text), voice: result.voice ?? null,
  };
}

function stopTTS(guildId) {
  if (ttsQueues.has(guildId)) {
    for (const item of ttsQueues.get(guildId)) safeUnlink(item.filename);
    ttsQueues.delete(guildId);
  }
  ttsIsPlaying.delete(guildId);
  return true;
}

// ════════════════════════════════════════════════════════
//  buildModelChoices — 從 TTS_MODELS 動態產生 choices 陣列
//  Discord 限制：最多 25 個 choices，name/value 上限 100 字元
// ════════════════════════════════════════════════════════
function buildModelChoices() {
  return Object.entries(TTS_MODELS)
    .slice(0, 25)
    .map(([key, m]) => ({
      name:  `${m.name} (${key})`.slice(0, 100),
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
  });

  // ── 動態產生模型 choices ──────────────────────────────
  const modelChoices = buildModelChoices();
  const hasModels    = modelChoices.length > 0;

  // ── 建構指令 Builder ─────────────────────────────────
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

    // /tts model — key 改為下拉選單
    .addSubcommand(sub => {
      sub.setName('model').setDescription('切換 TTS 模型');

      sub.addStringOption(o => {
        o.setName('key')
          .setDescription('選擇要切換的模型')
          .setRequired(true);

        if (hasModels) {
          o.addChoices(...modelChoices);
        }

        return o;
      });

      return sub;
    });

  // ── 注入 client.commands ─────────────────────────────
  client.commands.set('tts', {
    data: builder,

    async execute(interaction) {
      const sub     = interaction.options.getSubcommand();
      const guildId = interaction.guildId;

      if (!guildId) {
        return interaction.reply({ content: '❌ 此指令只能在伺服器中使用', ephemeral: true });
      }

      // ── /tts say ───────────────────────────────────────
      if (sub === 'say') {
        const text = interaction.options.getString('text');

        if (text.length > TTS_MAX_LENGTH) {
          return interaction.reply({
            content: `❌ 太長！上限 ${TTS_MAX_LENGTH} 字（目前 ${text.length} 字）`,
            ephemeral: true
          });
        }

        const connection = getVoiceConnection(guildId);
        if (!connection) {
          return interaction.reply({ content: '❌ Bot 不在語音頻道！請先使用 `/join` 加入', ephemeral: true });
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
          content:
            `🔊 **朗讀中**\n` +
            `${quotedText}` +
            (result.queued ? `\n\n📋 已加入排隊（第 ${result.position} 位）` : '')
        });
      }

      // ── /tts stop ──────────────────────────────────────
      else if (sub === 'stop') {
        const stopped = stopTTS(guildId);
        await interaction.reply({
          content: stopped ? '⏹️ 已停止 TTS 並清空排隊' : '❌ 目前沒有 TTS 在播放',
          ephemeral: !stopped
        });
      }

      // ── /tts model ─────────────────────────────────────
      else if (sub === 'model') {
        const key = interaction.options.getString('key').trim().toLowerCase();

        if (!TTS_MODELS[key]) {
          const available = Object.keys(TTS_MODELS).map(k => `\`${k}\``).join(', ');
          return interaction.reply({
            content: `❌ 找不到模型 \`${key}\`\n可用：${available}`,
            ephemeral: true
          });
        }

        const model = TTS_MODELS[key];
        await interaction.deferReply();

        try {
          await switchSoVITSWeights(model.gpt_weights, model.sovits_weights);
          activeModels.set(guildId, key);
          await interaction.editReply({ content: `✅ 已切換至 **${model.name}**！` });
        } catch (err) {
          console.error('❌ 切換模型失敗:', err.message);
          await interaction.editReply({ content: `❌ 切換失敗：${err.message}` });
        }
      }
    }
  });

  console.log('✅ TTS Slash Commands 已載入（/tts say / stop / model）');
}

module.exports = { setupTTSCommands, playTTS, stopTTS };