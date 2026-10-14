// utils/logger.js
// 統一的 log 格式工具（整個專案唯一的輸出入口，請不要直接用 console.*）：
//   - error / warn：異常狀況，輸出到 stderr
//   - success / info：正常運作路徑上值得留下紀錄的事件
//   - debug：診斷細節（每則訊息、每個快取命中這種高頻事件），預設隱藏
//   - section：印一個分隔標題，讓長長的開機 log 有段落感
//
// 等級由環境變數 LOG_LEVEL 控制：debug | info（預設）| warn | error。
// 舊的 DEBUG_STARTUP=true 仍然有效，等同 LOG_LEVEL=debug。
//
// 除了模組名稱之外的參數會原樣交給 console，所以可以直接把 Error 物件傳進來（會印出 stack）：
//   logger.success('TTS', 'edge-tts 已就緒（作為 fallback）');
//   logger.warn('YouTube', '未設定 Cookies，使用無帳號模式');
//   logger.error('AutoJoin', '自動加入失敗:', err);
//   logger.debug('Cache', `快取資料夾: ${cacheDir}`);

const SUPPORTS_COLOR = process.stdout.isTTY;

const C = SUPPORTS_COLOR
  ? { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', gray: '\x1b[90m' }
  : { reset: '', dim: '', green: '', yellow: '', red: '', cyan: '', gray: '' };

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveLevel() {
  if (process.env.DEBUG_STARTUP === 'true') return LEVELS.debug;
  return LEVELS[String(process.env.LOG_LEVEL || '').toLowerCase()] ?? LEVELS.info;
}

const threshold = resolveLevel();
const enabled = level => LEVELS[level] >= threshold;

function tag(mod) {
  return `${C.cyan}[${mod}]${C.reset}`;
}

function success(mod, ...args) {
  if (enabled('info')) console.log(`${C.green}✅${C.reset} ${tag(mod)}`, ...args);
}

function info(mod, ...args) {
  if (enabled('info')) console.log(`${C.gray}·${C.reset}  ${tag(mod)}`, ...args);
}

function warn(mod, ...args) {
  if (enabled('warn')) console.error(`${C.yellow}⚠️${C.reset}  ${tag(mod)}`, ...args);
}

function error(mod, ...args) {
  if (enabled('error')) console.error(`${C.red}❌${C.reset} ${tag(mod)}`, ...args);
}

function debug(mod, ...args) {
  if (enabled('debug')) console.log(`${C.gray}   · [${mod}]${C.reset}`, ...args);
}

function section(title) {
  if (enabled('info')) console.log(`\n${C.dim}── ${title} ${'─'.repeat(Math.max(0, 40 - title.length))}${C.reset}`);
}

function isDebugEnabled() {
  return enabled('debug');
}

module.exports = { success, warn, error, info, debug, section, isDebugEnabled };
