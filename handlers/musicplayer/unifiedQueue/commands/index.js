// handlers/musicplayer/unifiedQueue/commands/index.js
// 對外進入點：彙整拆分後的子模組（buttonInteractions / playCommand /
// musicCommand），維持與拆分前 commands.js 完全相同的 module.exports
// 介面（setupUnifiedCommands）。

const bootSummary = require('../../../../utils/bootSummary');

const { registerButtonInteractions } = require('./buttonInteractions');
const { playCommand } = require('./playCommand');
const { musicCommand } = require('./musicCommand');

// ════════════════════════════════════════════════════════
//  setupUnifiedCommands
// ════════════════════════════════════════════════════════
function setupUnifiedCommands(client) {
  registerButtonInteractions(client);

  client.commands.set(playCommand.data.name, playCommand);
  client.commands.set(musicCommand.data.name, musicCommand);

  bootSummary.report('音樂播放 (/play, /music)', 'ok', 'YouTube / Bilibili / 本地音樂佇列已就緒');
}

module.exports = {
  setupUnifiedCommands,
};
