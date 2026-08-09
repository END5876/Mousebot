'use strict';

const { execSync, spawn } = require('child_process');

const activeEdgeVoices = new Map();

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


function generateEdgeTTS(text, filename, voice) {
  return new Promise((resolve, reject) => {
    const proc = spawn('edge-tts', ['--voice', voice, '--text', text, '--write-media', filename, '--rate', '+10%']);
    proc.on('close', (code) => { if (code === 0) resolve(); else reject(new Error(`edge-tts 退出碼: ${code}`)); });
    proc.on('error', reject);
  });
}

// getHasEdgeTTS/setHasEdgeTTS：讓 commands.js 在啟動時偵測一次結果，
// 供 generate.js 判斷 SoVITS 不可用時能不能 fallback（原本是同一支檔案內的模組級變數 hasEdgeTTS）
function getHasEdgeTTS() {
  return hasEdgeTTS;
}

function setHasEdgeTTS(value) {
  hasEdgeTTS = value;
}

module.exports = {
  EDGE_VOICE_CHOICES,
  activeEdgeVoices,
  detectLanguage,
  resolveVoice,
  checkEdgeTTS,
  generateEdgeTTS,
  getHasEdgeTTS,
  setHasEdgeTTS
};
