'use strict';
// admin/api/overview.js — 總覽：Bot 狀態、外部服務、模組開機摘要、今日 AI 用量、語音連線

const bootSummary = require('../../utils/bootSummary');
const logger = require('../../utils/logger');
const { collectHealth } = require('../../utils/health');
const tokenTracker = require('../../handlers/ai/tokenTracker');
const aiQuota = require('../../handlers/ai/aiQuota');
const { listGuilds } = require('../discordInfo');
const { voiceInfo, musicState } = require('../voiceState');
const { getLastCrash } = require('../../utils/crashLog');

function botSummary(client) {
  if (!client.user) return null;
  return {
    id: client.user.id,
    name: client.user.globalName || client.user.username,
    tag: client.user.tag,
    avatarUrl: client.user.displayAvatarURL({ size: 128 }),
  };
}

module.exports = function registerOverview(router, client) {
  // 側邊欄的 Bot 資訊，也用來確認是否已登入（很輕量，不做外部服務探測）
  router.get('/api/me', () => ({
    ready: client.isReady(),
    ping: client.ws.ping,
    bot: botSummary(client),
  }));

  router.get('/api/overview', async () => {
    const { body: health } = await collectHealth(client);
    const [today] = tokenTracker.getUsageHistory(1);

    const voice = [];
    for (const guild of client.guilds.cache.values()) {
      const info = voiceInfo(guild);
      if (!info) continue;
      const music = musicState(guild.id);
      voice.push({
        guildId: guild.id,
        guildName: guild.name,
        ...info,
        nowPlaying: music?.current?.title ?? null,
        queueLength: music?.queueLength ?? 0,
      });
    }

    return {
      bot: botSummary(client),
      health,
      runtime: { node: process.version, logLevel: logger.getLevel() },
      modules: bootSummary.getItems(),
      guilds: listGuilds(client),
      usage: {
        date: today.date,
        total: today.total,
        billable: tokenTracker.billableTotal(today.total),
        limits: aiQuota.getLimits(),
      },
      voice,
      lastCrash: getLastCrash(),
    };
  });
};
