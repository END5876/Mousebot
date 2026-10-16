// utils/logger.js
// 統一的 log 格式工具（整個專案唯一的輸出入口，請不要直接用 console.*）：
//   - error / warn：異常狀況，輸出到 stderr
//   - success / info：正常運作路徑上值得留下紀錄的事件
//   - debug：診斷細節（每則訊息、每個快取命中這種高頻事件），預設隱藏
//   - section：印一個分隔標題，讓長長的開機 log 有段落感
//   - 實際印出的訊息另外在記憶體保留最近 500 則（getRecent），給管理面板的「日誌」頁讀取
//
// 等級由環境變數 LOG_LEVEL 控制：debug | info（預設）| warn | error。
// 舊的 DEBUG_STARTUP=true 仍然有效，等同 LOG_LEVEL=debug。
//
// 除了模組名稱之外的參數會原樣交給 console，所以可以直接把 Error 物件傳進來（會印出 stack）：
//   logger.success('TTS', 'edge-tts 已就緒（作為 fallback）');
//   logger.warn('YouTube', '未設定 Cookies，使用無帳號模式');
//   logger.error('AutoJoin', '自動加入失敗:', err);
//   logger.debug('Cache', `快取資料夾: ${cacheDir}`);

const util = require('util');

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

// ── 最近的 log（管理面板「日誌」頁讀取）────────────────────
// 只保留通過等級門檻、實際印出的訊息；超過上限就丟掉最舊的。
// seq 從 1 開始連續遞增，讀取端用它增量拉取新訊息。
const RECENT_MAX = 500;
const RECENT_MSG_MAX = 8000; // 單則上限：堆疊或大物件傾印不要讓這份紀錄吃掉太多記憶體
const recent = [];
let seq = 0;

function remember(level, mod, args) {
  let msg;
  try {
    msg = util.format(...args);
  } catch {
    msg = args.map(String).join(' ');
  }
  if (msg.length > RECENT_MSG_MAX) msg = `${msg.slice(0, RECENT_MSG_MAX)}…（已截斷）`;
  recent.push({ seq: ++seq, ts: Date.now(), level, mod: String(mod), msg });
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
}

/**
 * 取得序號大於 since 的 log（由舊到新）
 * @param {number} [since]
 * @returns {Array<{ seq: number, ts: number, level: string, mod: string, msg: string }>}
 */
function getRecent(since = 0) {
  const first = recent.length ? recent[0].seq : seq + 1;
  return recent.slice(Math.max(0, since - first + 1));
}

/** 最新一則 log 的序號（讀取端比對它，就知道程序是否重新啟動過、序號重新起算） */
function getLatestSeq() {
  return seq;
}

function tag(mod) {
  return `${C.cyan}[${mod}]${C.reset}`;
}

function success(mod, ...args) {
  if (!enabled('info')) return;
  console.log(`${C.green}✅${C.reset} ${tag(mod)}`, ...args);
  remember('success', mod, args);
}

function info(mod, ...args) {
  if (!enabled('info')) return;
  console.log(`${C.gray}·${C.reset}  ${tag(mod)}`, ...args);
  remember('info', mod, args);
}

function warn(mod, ...args) {
  if (!enabled('warn')) return;
  console.error(`${C.yellow}⚠️${C.reset}  ${tag(mod)}`, ...args);
  remember('warn', mod, args);
}

function error(mod, ...args) {
  if (!enabled('error')) return;
  console.error(`${C.red}❌${C.reset} ${tag(mod)}`, ...args);
  remember('error', mod, args);
}

function debug(mod, ...args) {
  if (!enabled('debug')) return;
  console.log(`${C.gray}   · [${mod}]${C.reset}`, ...args);
  remember('debug', mod, args);
}

function section(title) {
  if (enabled('info')) console.log(`\n${C.dim}── ${title} ${'─'.repeat(Math.max(0, 40 - title.length))}${C.reset}`);
}

function isDebugEnabled() {
  return enabled('debug');
}

/** 目前的等級門檻名稱（debug / info / warn / error） */
function getLevel() {
  return Object.keys(LEVELS).find(k => LEVELS[k] === threshold) ?? 'info';
}

module.exports = { success, warn, error, info, debug, section, isDebugEnabled, getRecent, getLatestSeq, getLevel };
