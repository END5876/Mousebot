'use strict';

const { setupTTSCommands } = require('./commands');
const { playTTS, stopTTS } = require('./queue');
const { getHasEdgeTTS } = require('./edgeTTS');
const { isSoVITSConfigured } = require('./sovitsClient');

module.exports = {
  setupTTSCommands, playTTS, stopTTS,
  // 有沒有任何 TTS 引擎可用（edge-tts 已安裝，或有設定 SoVITS）
  isUsable: () => getHasEdgeTTS() || isSoVITSConfigured(),
};
