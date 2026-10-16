'use strict';
// admin/api/logs.js — 最近的 log（utils/logger.js 在記憶體保留最近 500 則）

const logger = require('../../utils/logger');

module.exports = function registerLogs(router) {
  // ?since=<seq>：只回傳序號更新的訊息，網頁每隔幾秒增量拉取。
  // latest 比網頁記得的序號還小，代表 Bot 重新啟動過（序號重新起算），網頁要從頭重新讀取。
  router.get('/api/logs', ({ query }) => {
    const since = Math.max(0, Number.parseInt(query.get('since') ?? '0', 10) || 0);
    return { entries: logger.getRecent(since), latest: logger.getLatestSeq(), level: logger.getLevel() };
  });
};
