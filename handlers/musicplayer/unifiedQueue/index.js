// handlers/unifiedQueue/index.js
// 統一佇列核心 — 整合 bilibili / local 兩種來源到同一個播放佇列
// + /play 線上搜尋（YouTube + Bilibili 合併，選單挑選）
//
// 本檔案為對外進入點，僅彙整以下子模組並保留與拆分前完全相同的
// module.exports 介面，其他檔案 require('../handlers/unifiedQueue')
// 不需要任何修改：
//   state.js     — 共用狀態（Maps）與引擎注入
//   playback.js  — 控制面板、播放器生命週期、佇列播放、語音連線管理
//   search.js    — /play 核心邏輯、網址清理、全部本地音樂、線上搜尋、Autocomplete
//   commands.js  — Slash Commands 註冊、控制面板按鈕互動

const { registerEngine } = require('./state');
const {
  updateControlPanel,
  stopAll,
  enqueue,
  ensureConnection,
  isPlaying,
  getNowPlaying,
  playRandomLocal,
} = require('./playback');
const { handleAutocomplete } = require('./search');
const { setupUnifiedCommands } = require('./commands');

module.exports = {
  registerEngine,
  setupUnifiedCommands,
  handleAutocomplete,
  enqueue,
  stopAll,
  isPlaying,
  getNowPlaying,
  updateControlPanel,
  ensureConnection,
  playRandomLocal,
};