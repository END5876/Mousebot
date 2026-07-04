// handlers/unifiedQueue/state.js
// 統一佇列 — 共用狀態（Maps）與引擎注入
// 此檔案被 playback.js / search.js / commands.js 共同 require，
// 確保三者操作的是同一份 Map 實例（單例狀態）。

// ════════════════════════════════════════════════════════
//  引擎注入（由各 handler 在 setup 時呼叫）
// ════════════════════════════════════════════════════════
const _engines = { bilibili: null, local: null };

function registerEngine(type, engine) {
  _engines[type] = engine;
  console.log(`✅ [UnifiedQueue] 引擎已注入: ${type}`);
}

// ════════════════════════════════════════════════════════
//  Guild 狀態
// ════════════════════════════════════════════════════════
const queues = new Map();
const nowPlaying = new Map();
const loopSettings = new Map();
const controlMsgs = new Map();
const connections = new Map();

// ── 搜尋標記：autocomplete 選了「線上搜尋」時，用這個前綴標記 input ──
const SEARCH_MARKER = '__SEARCH__::';

// ── 目前正在合法等待使用者選擇的搜尋結果訊息（message.id 集合）──
// 用來讓 commands.js 的全域「殭屍搜尋互動」防護判斷：
// 這個訊息的 awaitMessageComponent() 是否仍在合法等待中，
// 若是，全域監聽器就不該搶先 reply()，否則會跟 search.js 內
// 真正要處理選擇結果的 selection.update() 搶著 ACK 同一個 interaction，
// 導致後者出現 DiscordAPIError[10062] Unknown interaction。
const activeSearchMessages = new Set();

module.exports = {
  _engines,
  registerEngine,
  queues,
  nowPlaying,
  loopSettings,
  controlMsgs,
  connections,
  SEARCH_MARKER,
  activeSearchMessages,
};