'use strict';
// admin/api/index.js — 這隻 Bot 的管理 API：註冊路由，以及告訴管理面板支援哪些功能（features）
//
// features 是管理面板的頁面代號（overview、voice…）與頁面內的選用功能（voice:join…），
// 面板只顯示 Bot 有回報的部分；協定見 admin/agent.js。
// 選用頁面依 utils/features.js 的模組狀態決定：模組沒開（FEATURES 未包含、缺設定或檔案不存在）就不回報、不註冊路由。
// 選用模組的路由檔一律在 register 時才 require（例如 tts.js、notify.js 最上層會載入對應的模組）。

const features = require('../../utils/features');
const profile = require('../../profile');
const registerOverview = require('./overview');
const registerSystem = require('./system');
const registerLogs = require('./logs');

const on = (name) => features.isEnabled(name);
// 語音頁：音樂控制、自動加入、手動加入／離開任一項有開就顯示
const voicePage = () => on('music') || on('autojoin') || on('voice');

function listFeatures() {
  return [
    'overview', 'status', 'maintenance', 'logs', 'maintenance:backup',
    ...(on('responses') ? ['responses'] : []),
    ...(on('ai') ? ['prompts', 'ai', 'usage'] : []),
    ...(voicePage() ? ['voice'] : []),
    ...(on('voice') ? ['voice:join'] : []),
    ...(on('stt') ? ['voice:wakeWord'] : []),
    ...(on('tts') ? ['tts'] : []),
    ...(on('notice') ? ['notify'] : []),
  ];
}

/**
 * @param {import('../http').Router} router
 * @param {import('discord.js').Client} client
 */
function register(router, client) {
  const fns = [
    registerOverview,
    ...(on('responses') ? [require('./responses')] : []),
    ...(on('ai') ? [require('./prompts'), require('./ai')] : []),
    ...(voicePage() ? [require('./voice')] : []),
    ...(on('notice') ? [require('./notify')] : []),
    ...(on('tts') ? [require('./tts')] : []),
    registerSystem,
    registerLogs,
  ];
  for (const fn of fns) fn(router, client);
}

module.exports = { app: profile.app, register, features: () => listFeatures() };
