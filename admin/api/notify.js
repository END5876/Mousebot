'use strict';
// admin/api/notify.js — 限免通知頻道（Steam / Epic）與整點報時

const { PermissionFlagsBits } = require('discord.js');
const { PLATFORMS } = require('../../handlers/notice/noticeHandler');
const timeAnnouncer = require('../../handlers/notice/timeAnnouncer');
const { TEXT_TYPES, guildSummary, guildChannels, describeChannel } = require('../discordInfo');
const { HttpError, bool, oneOf, snowflake, requireReady } = require('../http');

const PLATFORM_KEYS = Object.keys(PLATFORMS);
const SEND_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
];

const platformOf = (params) => PLATFORMS[oneOf(params.platform, PLATFORM_KEYS, '平台')];

module.exports = function registerNotify(router, client) {
  router.get('/api/notify', () => {
    requireReady(client);
    const announcerGuilds = new Set(timeAnnouncer.listEnabledGuilds());
    const guilds = [...client.guilds.cache.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
      .map((guild) => ({
        ...guildSummary(guild),
        textChannels: guildChannels(guild, TEXT_TYPES),
        timeAnnouncer: announcerGuilds.has(guild.id),
      }));

    return {
      platforms: PLATFORM_KEYS.map((key) => ({
        key,
        name: PLATFORMS[key].name,
        channels: PLATFORMS[key].service.listChannels().map((id) => describeChannel(client, id)),
      })),
      guilds,
      timeAnnouncer: {
        timezone: timeAnnouncer.TIMEZONE,
        sounds: timeAnnouncer.getSoundStatus(),
      },
    };
  });

  router.post('/api/notify/:platform/channels', async ({ params, body }) => {
    requireReady(client);
    const { service } = platformOf(params);
    const channelId = snowflake(body.channelId, '頻道');
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !TEXT_TYPES.includes(channel.type)) throw new HttpError(400, '找不到這個文字頻道');

    const me = channel.guild.members.me;
    if (!me || !channel.permissionsFor(me)?.has(SEND_PERMISSIONS)) {
      throw new HttpError(400, 'Bot 在這個頻道沒有「發送訊息」或「嵌入連結」權限');
    }
    if (!service.addChannel(channelId)) throw new HttpError(409, '這個頻道已經在通知清單裡');
    return describeChannel(client, channelId);
  });

  router.delete('/api/notify/:platform/channels/:channelId', ({ params }) => {
    const { service } = platformOf(params);
    if (!service.removeChannel(snowflake(params.channelId, '頻道'))) throw new HttpError(404, '這個頻道不在通知清單裡');
  });

  // 目前的限免遊戲（只查詢，不會推播到任何頻道）
  router.get('/api/notify/:platform/games', async ({ params }) => {
    const { provider } = platformOf(params);
    const games = await provider.getFreeGames();
    return {
      games: games.map((g) => ({
        name: g.name,
        url: g.url,
        image: g.image || null,
        originalPrice: g.originalPrice ?? null,
        endDate: g.endDate ?? null,
        description: g.description ?? '',
      })),
    };
  });

  router.put('/api/time-announcer/:guildId', ({ params, body }) => {
    const guildId = snowflake(params.guildId, '伺服器');
    timeAnnouncer.setAnnouncerEnabled(guildId, bool(body.enabled, '整點報時'));
    return { enabled: timeAnnouncer.isAnnouncerEnabled(guildId) };
  });
};
