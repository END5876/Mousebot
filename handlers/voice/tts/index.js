// handlers/voice/tts/index.js
// 對外進入點：彙整拆分後的子模組，維持與拆分前完全相同的
// module.exports 介面（setupTTSCommands / playTTS / stopTTS），
// 其他檔案 require('../voice/ttsHandler') 不需要任何修改。

const { setupTTSCommands } = require('./commands');
const { playTTS, stopTTS } = require('./queue');

module.exports = { setupTTSCommands, playTTS, stopTTS };
