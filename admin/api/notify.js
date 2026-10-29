'use strict';
// admin/api/notify.js — 限免通知頻道（Steam / Epic）與整點報時

const { PermissionFlagsBits } = require('discord.js');
const { PLATFORMS } = require('../../handlers/notice/noticeHandler');
const timeAnnouncer = require('../../handlers/notice/timeAnnouncer');
const { TEXT_TYPES, guildSummary, guildChannels, describeChannel } = require('../discordInfo');
const { HttpError, bool, oneOf, snowflake, str, requireReady } = require('../http');

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

  router.post('/api/notify/:platform/channels', async ({ params, body, audit }) => {
    requireReady(client);
    const { name, service } = platformOf(params);
    const channelId = snowflake(body.channelId, '頻道');
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !TEXT_TYPES.includes(channel.type)) throw new HttpError(400, '找不到這個文字頻道');

    const me = channel.guild.members.me;
    if (!me || !channel.permissionsFor(me)?.has(SEND_PERMISSIONS)) {
      throw new HttpError(400, 'Bot 在這個頻道沒有「發送訊息」或「嵌入連結」權限');
    }
    if (!service.addChannel(channelId)) throw new HttpError(409, '這個頻道已經在通知清單裡');
    audit(`新增 ${name} 限免通知頻道「${channel.guild.name} › #${channel.name}」`);
    return describeChannel(client, channelId);
  });

  router.delete('/api/notify/:platform/channels/:channelId', ({ params, audit }) => {
    const { name, service } = platformOf(params);
    const channelId = snowflake(params.channelId, '頻道');
    const ch = describeChannel(client, channelId);
    if (!service.removeChannel(channelId)) throw new HttpError(404, '這個頻道不在通知清單裡');
    audit(`移除 ${name} 限免通知頻道「${ch.missing ? channelId : `${ch.guildName} › #${ch.name}`}」`);
  });

  // ── 通知紀錄：已推播過的遊戲（同一款只通知一次，保留 90 天）─────
  router.get('/api/notify/:platform/history', ({ params }) => ({ items: platformOf(params).service.listNotified() }));

  // 移除紀錄後，下次檢查時如果它還在限免，會再推播一次（例如上次推播失敗）
  router.delete('/api/notify/:platform/history/:id', ({ params, audit }) => {
    const { name, service } = platformOf(params);
    const id = str(params.id, '紀錄', { max: 200 });
    const entry = service.listNotified().find((e) => e.id === id);
    if (!service.forgetNotified(id)) throw new HttpError(404, '找不到這筆紀錄');
    audit(`移除 ${name} 通知紀錄「${entry?.name ?? id}」（下次檢查會重新推播）`);
  });

  // 立即檢查：有新的限免遊戲就推播到通知頻道（與每 30 分鐘的定時檢查是同一個流程，不會重複推播）
  router.post('/api/notify/:platform/check', async ({ params, audit }) => {
    requireReady(client);
    const { name, polling } = platformOf(params);
    if (!polling) throw new HttpError(503, '通知排程尚未啟動');
    const result = await polling.checkAndNotify();
    audit(result.skipped
      ? `手動檢查 ${name} 限免（略過：${result.skipped}）`
      : `手動檢查 ${name} 限免：${result.newGames.length ? `推播 ${result.newGames.join('、')}` : '沒有新遊戲'}`);
    return result;
  });

  // 目前的限免遊戲（只查詢，不會推播到任何頻道）
  router.get('/api/notify/:platform/games', async ({ params }) => {
    const { provider } = platformOf(params);
    // 抓取失敗時 getFreeGames 會丟錯（不再假裝成「沒有限免」），轉成看得懂的訊息顯示在網頁上
    let games;
    try { games = await provider.getFreeGames(); } catch (err) { throw new HttpError(502, `查詢失敗：${err.message}`); }
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

  router.put('/api/time-announcer/:guildId', ({ params, body, audit }) => {
    const guildId = snowflake(params.guildId, '伺服器');
    const enabled = bool(body.enabled, '整點報時');
    timeAnnouncer.setAnnouncerEnabled(guildId, enabled);
    audit(`${enabled ? '開啟' : '關閉'}「${client.guilds.cache.get(guildId)?.name ?? guildId}」的整點報時`);
    return { enabled: timeAnnouncer.isAnnouncerEnabled(guildId) };
  });
};
