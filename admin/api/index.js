'use strict';
// admin/api/index.js — 這隻 Bot 的管理 API：註冊路由，以及告訴管理面板支援哪些功能（features）
//
// features 是管理面板的頁面代號（overview、voice…）與頁面內的選用功能（voice:join…），
// 面板只顯示 Bot 有回報的部分；協定見 admin/agent.js。

const registerOverview = require('./overview');
const registerResponses = require('./responses');
const registerPrompts = require('./prompts');
const registerAi = require('./ai');
const registerVoice = require('./voice');
const registerNotify = require('./notify');
const registerTts = require('./tts');
const registerSystem = require('./system');
const registerLogs = require('./logs');

const FEATURES = [
  'overview', 'responses', 'prompts', 'ai', 'usage', 'voice', 'tts', 'notify', 'status', 'maintenance', 'logs',
  'voice:join', 'voice:wakeWord', 'maintenance:backup',
];

/**
 * @param {import('../http').Router} router
 * @param {import('discord.js').Client} client
 */
function register(router, client) {
  for (const fn of [
    registerOverview,
    registerResponses,
    registerPrompts,
    registerAi,
    registerVoice,
    registerNotify,
    registerTts,
    registerSystem,
    registerLogs,
  ]) {
    fn(router, client);
  }
}

module.exports = { app: 'mousebot', register, features: () => FEATURES };
