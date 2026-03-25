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

// ── TTS 播放器 Map（每個 Guild 一個）────────────────────
const ttsPlayers = new Map();

// ── TTS 排隊 Map（每個 Guild 一個 Queue）────────────────
const ttsQueues = new Map();

// ── 字數上限常數 ─────────────────────────────────────────
const TTS_MAX_LENGTH = 200;

// ── GPT-SoVITS 設定（從 .env 讀取）─────────────────────
const SOVITS_HOST        = process.env.SOVITS_HOST        || 'localhost';
const SOVITS_PORT        = parseInt(process.env.SOVITS_PORT) || 9880;
const SOVITS_TIMEOUT_MS  = 10000;
const SOVITS_REF_AUDIO   = process.env.SOVITS_REF_AUDIO   || '';
const SOVITS_PROMPT_TEXT = process.env.SOVITS_PROMPT_TEXT || '';
const SOVITS_PROMPT_LANG = process.env.SOVITS_PROMPT_LANG || 'zh';
const SOVITS_TEXT_LANG   = process.env.SOVITS_TEXT_LANG   || 'zh';

// ── DNS 快取（避免每次都查）─────────────────────────────
let cachedSoVITSIP = null;
let cacheExpireAt  = 0;
const DNS_CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveSoVITSHost() {
  const now = Date.now();
  if (cachedSoVITSIP && now < cacheExpireAt) {
    return cachedSoVITSIP;
  }

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

// ── 語音設定（edge-tts fallback 用）─────────────────────
const VOICE_MAP = {
  zh: 'zh-TW-YunJheNeural',
  en: 'zh-TW-YunJheNeural',
  ja: 'ja-JP-KeitaNeural',
};
const DEFAULT_VOICE = 'zh-TW-YunJheNeural';

// ── 語言自動偵測 ─────────────────────────────────────────
function detectLanguage(text) {
  const hasHiragana  = /[\u3040-\u309F]/.test(text);
  const hasKatakana  = /[\u30A0-\u30FF]/.test(text);
  const hasCJK       = /[\u4E00-\u9FFF]/.test(text);
  const hasLatinOnly = /^[A-Za-z0-9\s.,!?'"()\-:;@#$%&*+=/\\[\]{}|<>~`^_]+$/.test(text.trim());

  if (hasHiragana || hasKatakana) return 'ja';
  if (hasCJK)                     return 'zh';
  if (hasLatinOnly)               return 'en';
  return 'zh';
}

function resolveVoice(text) {
  const lang = detectLanguage(text);
  return VOICE_MAP[lang] ?? DEFAULT_VOICE;
}

// ── 檢查 edge-tts 是否安裝 ──────────────────────────────
let hasEdgeTTS = false;

function checkEdgeTTS() {
  try {
    execSync('edge-tts --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ── GPT-SoVITS 生成 TTS ──────────────────────────────────
async function generateSoVITS(text, filename) {
  const resolvedIP = await resolveSoVITSHost();

  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      text:           text,
      text_lang:      SOVITS_TEXT_LANG,
      ref_audio_path: SOVITS_REF_AUDIO,
      prompt_lang:    SOVITS_PROMPT_LANG,
      prompt_text:    SOVITS_PROMPT_TEXT,
      media_type:     'wav',
    });

    const options = {
      hostname: resolvedIP,
      port:     SOVITS_PORT,
      path:     `/tts?${params.toString()}`,
      method:   'GET',
      timeout:  SOVITS_TIMEOUT_MS,
      headers: {
        Host: SOVITS_HOST,
      },
    };

    const req = http.request(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SoVITS HTTP ${res.statusCode}`));
        res.resume();
        return;
      }

      const fileStream = fs.createWriteStream(filename);
      res.pipe(fileStream);

      fileStream.on('finish', () => resolve());
      fileStream.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('SoVITS 連線逾時'));
    });

    req.on('error', reject);
    req.end();
  });
}

// ── edge-tts 生成 TTS ────────────────────────────────────
function generateEdgeTTS(text, filename, voice) {
  return new Promise((resolve, reject) => {
    const proc = spawn('edge-tts', [
      '--voice', voice,
      '--text',  text,
      '--write-media', filename
    ]);

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`edge-tts 退出碼: ${code}`));
    });

    proc.on('error', reject);
  });
}

// ── 統一 TTS 生成（SoVITS 優先，失敗 fallback edge-tts）─
async function generateTTS(text, filename) {
  try {
    const sovitsFile = filename.replace(/\.\w+$/, '_sovits.wav');
    await generateSoVITS(text, sovitsFile);
    console.log(`✅ [SoVITS] 生成成功: ${text.slice(0, 20)}...`);
    return { file: sovitsFile, engine: 'sovits' };
  } catch (err) {
    console.warn(`⚠️ [SoVITS] 失敗 (${err.message})，切換至 edge-tts`);
  }

  if (!hasEdgeTTS) {
    throw new Error('SoVITS 不可用且 edge-tts 未安裝');
  }

  const voice = resolveVoice(text);
  const edgeFile = filename.replace(/\.\w+$/, '_edge.mp3');
  await generateEdgeTTS(text, edgeFile, voice);
  console.log(`✅ [edge-tts] 生成成功: ${text.slice(0, 20)}...`);
  return { file: edgeFile, engine: 'edge', voice };
}

// ── 安全刪除暫存檔 ───────────────────────────────────────
function safeUnlink(filename) {
  try { fs.unlinkSync(filename); } catch {}
}

// ── 處理下一個排隊項目 ───────────────────────────────────
async function processQueue(guildId) {
  const queue = ttsQueues.get(guildId);
  if (!queue || queue.length === 0) {
    ttsQueues.delete(guildId);
    return;
  }

  const { filename } = queue[0];
  const connection = getVoiceConnection(guildId);

  if (!connection) {
    console.warn(`⚠️ [${guildId}] 語音連線已斷開，清空 TTS Queue`);
    for (const item of queue) safeUnlink(item.filename);
    ttsQueues.delete(guildId);
    ttsPlayers.delete(guildId);
    return;
  }

  const player = createAudioPlayer();
  const resource = createAudioResource(filename, {
    inputType: StreamType.Arbitrary
  });

  player.play(resource);
  connection.subscribe(player);
  ttsPlayers.set(guildId, player);

  player.on(AudioPlayerStatus.Idle, () => {
    safeUnlink(filename);
    queue.shift();
    ttsPlayers.delete(guildId);
    processQueue(guildId);
  });

  player.on('error', (err) => {
    console.error(`❌ [${guildId}] TTS 播放錯誤:`, err.message);
    safeUnlink(filename);
    queue.shift();
    ttsPlayers.delete(guildId);
    processQueue(guildId);
  });
}

// ── 播放 TTS（加入 Queue）────────────────────────────────
async function playTTS(guildId, text) {
  const connection = getVoiceConnection(guildId);
  if (!connection) return { success: false, reason: 'no_connection' };

  const tempDir = path.join(__dirname, '../temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const baseFile = path.join(tempDir, `tts_${guildId}_${Date.now()}.tmp`);

  let result;
  try {
    result = await generateTTS(text, baseFile);
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
    success:      true,
    queued:       queue.length > 1,
    position:     queue.length,
    engine:       result.engine,
    detectedLang: detectLanguage(text),
    voice:        result.voice ?? null,
  };
}

// ── 停止 TTS 並清空 Queue ─────────────────────────────────
function stopTTS(guildId) {
  if (ttsQueues.has(guildId)) {
    const queue = ttsQueues.get(guildId);
    for (const item of queue) safeUnlink(item.filename);
    ttsQueues.delete(guildId);
  }

  if (ttsPlayers.has(guildId)) {
    try { ttsPlayers.get(guildId).stop(); } catch {}
    ttsPlayers.delete(guildId);
    return true;
  }

  return false;
}

// ── 設定 TTS 指令 ────────────────────────────────────────
function setupTTSCommands(client) {
  hasEdgeTTS = checkEdgeTTS();

  if (!hasEdgeTTS) {
    console.warn('⚠️ edge-tts 未安裝，TTS fallback 將無法使用');
    console.warn('   請執行: pip install edge-tts');
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

    // ── !m <文字> ─────────────────────────────────────── 
    if (content.startsWith(`${PREFIX}m `)) {
      const text = content.slice(`${PREFIX}m `.length).trim();

      if (!text) {
        return message.reply(`❌ 請輸入要說的文字！\n用法：\`${PREFIX}m 你好\``);
      }

      if (text.length > TTS_MAX_LENGTH) {
        return message.reply(`❌ 文字太長了！最多 ${TTS_MAX_LENGTH} 個字（目前 ${text.length} 字）`);
      }

      const connection = getVoiceConnection(guildId);
      if (!connection) {
        return message.reply(`❌ Bot 目前不在語音頻道！請先使用 \`${PREFIX}join\``);
      }

      await message.react('🔊');

      const result = await playTTS(guildId, text);

      if (!result.success) {
        await message.reactions.removeAll().catch(() => {});
        if (result.reason === 'tts_failed') {
          return message.reply('❌ TTS 生成失敗（SoVITS 離線且 edge-tts 不可用）');
        }
        return;
      }
    }

    // ── !mstop ──────────────────────────────────────────
    if (content === `${PREFIX}mstop`) {
      const stopped = stopTTS(guildId);
      if (stopped) {
        return message.reply('⏹️ 已停止 TTS 播放並清空排隊');
      } else {
        return message.reply('❌ 目前沒有 TTS 在播放');
      }
    }
  });
}

module.exports = { setupTTSCommands };