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

// ── TTS 播放器 Map（每個 Guild 一個）────────────────────
const ttsPlayers = new Map();

// ── TTS 排隊 Map（每個 Guild 一個 Queue）────────────────
const ttsQueues = new Map();

// ── 字數上限常數 ─────────────────────────────────────────
const TTS_MAX_LENGTH = 200;

// ── 語音設定 ─────────────────────────────────────────────
const VOICE_MAP = {
  zh: 'zh-TW-YunJheNeural',   // 中文（含繁體、簡體）
  en: 'zh-TW-YunJheNeural',   // 英文（同樣用中文語音念）
  ja: 'ja-JP-KeitaNeural',    // 日文
};
const DEFAULT_VOICE = 'zh-TW-YunJheNeural'; // fallback

// ── 語言自動偵測 ─────────────────────────────────────────
/**
 * 偵測文字的主要語言
 * 優先順序：日文 > 中文 > 英文 > 預設(中文)
 *
 * 判斷邏輯：
 *  - 含有平假名 / 片假名 → 日文
 *  - 含有 CJK 漢字（但無日文假名）→ 中文
 *  - 只有 ASCII 英數字 → 英文
 *  - 其他 → 預設中文語音
 */
function detectLanguage(text) {
  const hasHiragana  = /[\u3040-\u309F]/.test(text); // 平假名
  const hasKatakana  = /[\u30A0-\u30FF]/.test(text); // 片假名
  const hasCJK       = /[\u4E00-\u9FFF]/.test(text); // 中日韓漢字
  const hasLatinOnly = /^[A-Za-z0-9\s.,!?'"()\-:;@#$%&*+=/\\[\]{}|<>~`^_]+$/.test(text.trim());

  if (hasHiragana || hasKatakana) return 'ja'; // 有假名 → 日文
  if (hasCJK)                     return 'zh'; // 有漢字（無假名）→ 中文
  if (hasLatinOnly)               return 'en'; // 純英數 → 英文
  return 'zh';                                 // 其他 → 預設中文
}

/**
 * 根據文字自動選擇語音
 */
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

// ── 產生 TTS 音訊檔案（使用 edge-tts）───────────────────
function generateTTS(text, filename, voice) {
  return new Promise((resolve, reject) => {
    const proc = spawn('edge-tts', [
      '--voice', voice,
      '--text', text,
      '--write-media', filename
    ]);

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`edge-tts 退出碼: ${code}`));
    });

    proc.on('error', reject);
  });
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
  if (!hasEdgeTTS) return { success: false, reason: 'no_edge_tts' };

  const connection = getVoiceConnection(guildId);
  if (!connection) return { success: false, reason: 'no_connection' };

  // 自動偵測語言並選擇語音
  const voice = resolveVoice(text);
  const detectedLang = detectLanguage(text);

  const filename = path.join(__dirname, `../temp/tts_${guildId}_${Date.now()}.mp3`);

  const tempDir = path.join(__dirname, '../temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  try {
    await generateTTS(text, filename, voice);
  } catch (err) {
    console.error('❌ TTS 生成失敗:', err.message);
    safeUnlink(filename);
    return { success: false, reason: 'tts_failed' };
  }

  if (!ttsQueues.has(guildId)) ttsQueues.set(guildId, []);

  const queue = ttsQueues.get(guildId);
  const isPlaying = ttsPlayers.has(guildId);

  queue.push({ text, voice, filename });

  if (!isPlaying) processQueue(guildId);

  return {
    success: true,
    queued: queue.length > 1,
    position: queue.length,
    detectedLang,
    voice
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
    console.warn('⚠️ edge-tts 未安裝，TTS 功能將無法使用');
    console.warn('   請執行: pip install edge-tts');
  } else {
    console.log('✅ edge-tts 已就緒');
  }

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const content = message.content;
    const guildId = message.guild?.id;
    if (!guildId) return;

    // ── edge-tts 未安裝攔截 ──────────────────────────────
    const isTTSCommand = (
      content.startsWith(`${PREFIX}tts `) ||
      content === `${PREFIX}ttstop`
    );

    if (isTTSCommand && !hasEdgeTTS) {
      return message.reply('❌ TTS 功能未啟用，請聯絡管理員安裝 `edge-tts`\n```\npip install edge-tts\n```');
    }

    // ── !tts <文字> ──────────────────────────────────────
    if (content.startsWith(`${PREFIX}tts `)) {
      const text = content.slice(`${PREFIX}tts `.length).trim();

      if (!text) {
        return message.reply(`❌ 請輸入要說的文字！\n用法：\`${PREFIX}tts 你好\``);
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
          return message.reply('❌ TTS 生成失敗，請確認 edge-tts 已安裝');
        }
        return;
      }

      // 顯示偵測到的語言與使用的語音
      const langLabel = { zh: '中文 🇹🇼', en: '英文 🇺🇸', ja: '日文 🇯🇵' };
      const langInfo = langLabel[result.detectedLang] ?? '未知';

      /*if (result.queued) {
        await message.reply(`📋 已加入排隊（第 ${result.position} 位）｜偵測語言：${langInfo}｜語音：\`${result.voice}\``);
      } else {
        await message.reply(`🔊 播放中｜偵測語言：${langInfo}｜語音：\`${result.voice}\``);
      }*/
    }

    // ── !ttstop ──────────────────────────────────────────
    if (content === `${PREFIX}ttstop`) {
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