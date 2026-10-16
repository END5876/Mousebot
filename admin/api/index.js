'use strict';
// admin/api/index.js — 註冊所有管理面板 API（除了登入 / 登出，全部需要登入才能呼叫）

const registerOverview = require('./overview');
const registerResponses = require('./responses');
const registerPrompts = require('./prompts');
const registerAi = require('./ai');
const registerVoice = require('./voice');
const registerNotify = require('./notify');
const registerLogs = require('./logs');

/**
 * @param {import('../http').Router} router
 * @param {import('discord.js').Client} client
 */
module.exports = function registerApi(router, client) {
  for (const register of [
    registerOverview,
    registerResponses,
    registerPrompts,
    registerAi,
    registerVoice,
    registerNotify,
    registerLogs,
  ]) {
    register(router, client);
  }
};
