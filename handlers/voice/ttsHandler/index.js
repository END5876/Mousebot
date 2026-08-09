'use strict';

const { setupTTSCommands } = require('./commands');
const { playTTS, stopTTS } = require('./queue');

module.exports = { setupTTSCommands, playTTS, stopTTS };
