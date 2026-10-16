'use strict';
// admin/api/ai.js — AI 設定（使用者人格、隨機插話）與用量統計

const aiChance = require('../../handlers/ai/aiChance');
const aiUtils = require('../../handlers/ai/aiUtils');
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

  const guildName = (id) => client.guilds.cache.get(id)?.name ?? id;
  const userName = async (id) => {
    const user = client.isReady() ? (await resolveUsers(client, [id]))[id] : null;
    return user && !user.missing ? user.name : id;
  };

  // ── 隨機插話機率 ─────────────────────────────────────────
  router.put('/api/ai/chance/:guildId', ({ params, body, audit }) => {
    const guildId = snowflake(params.guildId, '伺服器');
    const result = aiChance.setReplyChance(guildId, body.chance);
    if (!result.success) throw new HttpError(400, result.error);
    audit(`把「${guildName(guildId)}」的隨機插話機率設為 ${Math.round(result.chance * 100)}%`);
    return { chance: result.chance };
  });

  router.delete('/api/ai/chance/:guildId', ({ params, audit }) => {
    const guildId = snowflake(params.guildId, '伺服器');
    const chance = aiChance.resetReplyChance(guildId);
    audit(`把「${guildName(guildId)}」的隨機插話機率恢復預設`);
    return { chance };
  });

  router.put('/api/ai/channels/:channelId', ({ params, body, audit }) => {
    const channelId = snowflake(params.channelId, '頻道');
    const result = aiChance.setChannelDisabled(channelId, bool(body.disabled, '插話開關'));
    const ch = describeChannel(client, channelId);
    audit(`${result.disabled ? '關閉' : '開啟'}「${ch.guildName ?? '?'} › #${ch.name ?? channelId}」的隨機插話`);
    return result;
  });

  // ── 使用者人格模式 ───────────────────────────────────────
  router.put('/api/ai/user-modes/:userId', async ({ params, body, audit }) => {
    const userId = snowflake(params.userId, '使用者');
    const mode = str(body.mode, '模式', { max: 32 });
    if (!promptStore.getMode(mode)) throw new HttpError(400, `找不到「${mode}」這個模式`);
    modeSelector.setUserMode(userId, mode);
    audit(`把 ${await userName(userId)} 的 AI 人格設為「${modeName(mode)}」`);
    return { mode, modeName: modeName(mode) };
  });

  router.delete('/api/ai/user-modes/:userId', async ({ params, audit }) => {
    const userId = snowflake(params.userId, '使用者');
    modeSelector.setUserMode(userId, null);
    audit(`移除 ${await userName(userId)} 的 AI 人格指定`);
  });

  // ── 清除對話記憶（等同對方自己下 /ai clear；只影響最近 10 分鐘內的對話脈絡）─────
  router.post('/api/ai/memory/:userId', async ({ params, audit }) => {
    const userId = snowflake(params.userId, '使用者');
    aiUtils.clearUserMemory(userId);
    audit(`清除 ${await userName(userId)} 的 AI 對話記憶`);
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
