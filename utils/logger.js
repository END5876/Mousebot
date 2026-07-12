// utils/logger.js
// 統一的 log 格式工具：
//   - success / warn / error：正常運作路徑上都會顯示，格式統一
//   - debug：預設隱藏，只有設定 DEBUG_STARTUP=true 時才顯示
//            （給診斷用的細節訊息，例如「快取資料夾路徑」這種平常不需要看的東西）
//   - section：印一個分隔標題，讓長長的開機 log 有段落感
//
// 用法：
//   const logger = require('../../utils/logger');
//   logger.success('TTS', 'edge-tts 已就緒（作為 fallback）');
//   logger.warn('YouTube', '未設定 Cookies，使用無帳號模式');
//   logger.debug('Cache', `快取資料夾: ${cacheDir}`);

const SUPPORTS_COLOR = process.stdout.isTTY;

const C = SUPPORTS_COLOR
  ? { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', gray: '\x1b[90m' }
  : { reset: '', dim: '', green: '', yellow: '', red: '', cyan: '', gray: '' };

function tag(mod) {
  return `${C.cyan}[${mod}]${C.reset}`;
}

function success(mod, msg) {
  console.log(`${C.green}✅${C.reset} ${tag(mod)} ${msg}`);
}

function warn(mod, msg) {
  console.log(`${C.yellow}⚠️${C.reset}  ${tag(mod)} ${msg}`);
}

function error(mod, msg) {
  console.log(`${C.red}❌${C.reset} ${tag(mod)} ${msg}`);
}

function info(mod, msg) {
  console.log(`${C.gray}ℹ️${C.reset}  ${tag(mod)} ${msg}`);
}

// 診斷細節：預設隱藏，避免正常開機時洗版。
// 要除錯時在 .env 加一行 DEBUG_STARTUP=true 即可全部顯示。
function debug(mod, msg) {
  if (process.env.DEBUG_STARTUP === 'true') {
    console.log(`${C.gray}   · [${mod}] ${msg}${C.reset}`);
  }
}

function section(title) {
  console.log(`\n${C.dim}── ${title} ${'─'.repeat(Math.max(0, 40 - title.length))}${C.reset}`);
}

module.exports = { success, warn, error, info, debug, section };
