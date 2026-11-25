// 每個伺服器最近一次「點歌的頻道」。

// ════════════════════════════════════════════════════════
//  記錄每個 guild「點歌的頻道」
// ════════════════════════════════════════════════════════
const requestChannels = new Map();

function _getNotifyChannel(guildId, fallbackChannel) {
  return requestChannels.get(guildId) || fallbackChannel;
}

// 最近一次點歌的文字頻道（webSync.js 從網頁點歌、更新控制面板時沿用）
function getRequestChannel(guildId) {
  return requestChannels.get(guildId) || null;
}

module.exports = {
  _getNotifyChannel,
  requestChannels,
  getRequestChannel,
};
