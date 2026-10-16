'use strict';
// admin/api/ai.js — AI 設定（使用者人格、隨機插話）與用量統計

const aiChance = require('../../handlers/ai/aiChance');
const modeSelector = require('../../handlers/ai/modeSelector');
const promptStore = require('../../handlers/ai/promptStore');
const tokenTracker = require('../../handlers/ai/tokenTracker');
const aiQuota = require('../../handlers/ai/aiQuota');
const { LOVER_MODE_USER_IDS, DEVELOPER_MODE_USER_IDS } = require('../../handlers/ai/aiSettings');
const { MODEL_NAME, VISION_MODEL_NAME } = require('../../handlers/ai/geminiClient');
const { ENABLED_GUILD_IDS } = require('../../handlers/ai/searchGrounding');
const {
  TEXT_TYPES, VOICE_TYPES, guildSummary, guildChannels, describeChannel, resolveUsers, searchMembers,
} = require('../discordInfo');
const { HttpError, str, bool, snowflake, requireReady } = require('../http');

const MAX_USAGE_DAYS = 90;

function modeName(key) {
  return promptStore.getMode(key)?.name ?? null;
}

// 每個統計桶補上「計費 token」（total 扣掉搜尋取回的內容，見 tokenTracker）
function withBillable(group) {
  return Object.fromEntries(Object.entries(group).map(([k, b]) => [k, { ...b, billable: tokenTracker.billableTotal(b) }]));
}

module.exports = function registerAi(router, client) {
  router.get('/api/ai/settings', async () => {
    requireReady(client);
    const overrides = modeSelector.listUserModes();
    const users = await resolveUsers(client, [...Object.keys(overrides), ...LOVER_MODE_USER_IDS, ...DEVELOPER_MODE_USER_IDS]);
    const chances = aiChance.listReplyChances();
    const disabled = new Set(aiChance.listDisabledChannels());

    const guilds = [...client.guilds.cache.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
      .map((guild) => {
        const channels = guildChannels(guild, [...TEXT_TYPES, ...VOICE_TYPES]);
        const listed = new Set(channels.map((c) => c.id));
        // 討論串等不在清單裡、但被停用過的頻道也要列出來，才能重新開啟
        const extra = [...disabled]
          .map((id) => describeChannel(client, id))
          .filter((c) => c.guildId === guild.id && !listed.has(c.id))
          .map((c) => ({ id: c.id, name: c.name, kind: 'thread', category: null }));
        return {
          ...guildSummary(guild),
          chance: chances[guild.id] ?? null,
          channels: [...channels, ...extra].map((c) => ({ ...c, disabled: disabled.has(c.id) })),
        };
      });

    return {
      model: MODEL_NAME,
      visionModel: VISION_MODEL_NAME,
      limits: aiQuota.getLimits(),
      searchGuilds: [...ENABLED_GUILD_IDS].map((id) => ({ id, name: client.guilds.cache.get(id)?.name ?? null })),
      modes: promptStore.listModes().sort().map((key) => ({ key, name: modeName(key) })),
      defaultMode: 'loss',
      userModes: Object.entries(overrides).map(([userId, mode]) => ({
        user: users[userId],
        mode,
        modeName: modeName(mode),
      })),
      specialUsers: {
        lover: LOVER_MODE_USER_IDS.map((id) => users[id]),
        developer: DEVELOPER_MODE_USER_IDS.map((id) => users[id]),
      },
      replyChance: { default: aiChance.DEFAULT_CHANCE, guilds },
    };
  });

  // ── 隨機插話機率 ─────────────────────────────────────────
  router.put('/api/ai/chance/:guildId', ({ params, body }) => {
    const guildId = snowflake(params.guildId, '伺服器');
    const result = aiChance.setReplyChance(guildId, body.chance);
    if (!result.success) throw new HttpError(400, result.error);
    return { chance: result.chance };
  });

  router.delete('/api/ai/chance/:guildId', ({ params }) => {
    return { chance: aiChance.resetReplyChance(snowflake(params.guildId, '伺服器')) };
  });

  router.put('/api/ai/channels/:channelId', ({ params, body }) => {
    return aiChance.setChannelDisabled(snowflake(params.channelId, '頻道'), bool(body.disabled, '插話開關'));
  });

  // ── 使用者人格模式 ───────────────────────────────────────
  router.put('/api/ai/user-modes/:userId', ({ params, body }) => {
    const userId = snowflake(params.userId, '使用者');
    const mode = str(body.mode, '模式', { max: 32 });
    if (!promptStore.getMode(mode)) throw new HttpError(400, `找不到「${mode}」這個模式`);
    modeSelector.setUserMode(userId, mode);
    return { mode, modeName: modeName(mode) };
  });

  router.delete('/api/ai/user-modes/:userId', ({ params }) => {
    modeSelector.setUserMode(snowflake(params.userId, '使用者'), null);
  });

  router.get('/api/members/search', async ({ query }) => {
    requireReady(client);
    const q = str(query.get('q'), '搜尋文字', { max: 100 });
    return { members: await searchMembers(client, q) };
  });

  // ── 用量統計 ─────────────────────────────────────────────
  router.get('/api/ai/usage', async ({ query }) => {
    const days = Math.min(MAX_USAGE_DAYS, Math.max(1, Number.parseInt(query.get('days') ?? '30', 10) || 30));
    const history = tokenTracker.getUsageHistory(days).map((day) => ({
      date: day.date,
      total: { ...day.total, billable: tokenTracker.billableTotal(day.total) },
      bySource: withBillable(day.bySource),
      byMode: withBillable(day.byMode),
      byUser: withBillable(day.byUser),
    }));

    const userIds = new Set(history.flatMap((d) => Object.keys(d.byUser)));
    const modeKeys = new Set(history.flatMap((d) => Object.keys(d.byMode)));
    return {
      days: history,
      users: client.isReady() ? await resolveUsers(client, [...userIds]) : {},
      modeNames: Object.fromEntries([...modeKeys].map((k) => [k, modeName(k)])),
      limits: aiQuota.getLimits(),
    };
  });
};
