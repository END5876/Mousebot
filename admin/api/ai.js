'use strict';
// admin/api/ai.js — AI 設定（使用者人格、隨機插話、多人格／單一人格範圍、清除記憶）與用量統計
//
// 範圍鎖定（persona.getLock()，見 handlers/ai/persona.js；register 時讀一次）時只有一個人格：
//   - GET /api/ai/settings 回傳單一人格的格式 {model, limits, searchGuilds, persona, memoryScope:'channel', replyChance}，
//     沒有 visionModel、modes、userModes、fixedUserModes；管理面板依回傳的欄位決定顯示哪些區塊
//   - 不註冊範圍（/ai scope）、使用者人格（/ai mode）、清除個人記憶、成員搜尋的路由
// 不鎖定時才 lazy require aiScope、modeSelector（鎖定時不會讀寫 aiScope.json 與 userModes.json）。
// 插話機率、頻道開關、清除頻道記憶、用量統計兩種情況都有。

const aiChance = require('../../handlers/ai/aiChance');
const aiMemoryState = require('../../handlers/ai/aiMemoryState');
const persona = require('../../handlers/ai/persona');
const promptStore = require('../../handlers/ai/promptStore');
const tokenTracker = require('../../handlers/ai/tokenTracker');
const aiQuota = require('../../handlers/ai/aiQuota');
const { DEFAULT_MODE } = require('../../handlers/ai/aiSettings');
const { MODEL_NAME, VISION_MODEL_NAME } = require('../../handlers/ai/geminiClient');
const { ENABLED_GUILD_IDS } = require('../../handlers/ai/searchGrounding');
const {
  TEXT_TYPES, VOICE_TYPES, guildSummary, guildChannels, describeChannel, resolveUsers, searchMembers,
} = require('../discordInfo');
const { HttpError, str, bool, oneOf, snowflake, requireReady } = require('../http');

const MAX_USAGE_DAYS = 90;

function modeName(key) {
  return promptStore.getMode(key)?.name ?? null;
}

// 範圍設定的一筆（伺服器或頻道）轉成前端用的格式；tombstone（沒有 kind）也回傳，前端當作「未設定」
function scopeEntry(e) {
  if (!e) return null;
  return {
    kind: e.kind ?? null,
    persona: e.persona ?? null,
    personaName: e.persona ? modeName(e.persona) : null,
    changedAt: e.changedAt || null,
  };
}

// PUT body：{ kind: 'multi'|'single', persona? }
function scopeCfg(aiScope, body) {
  const cfg = { kind: oneOf(body.kind, aiScope.KINDS, '範圍類型') };
  if (cfg.kind === 'single') {
    cfg.persona = str(body.persona, '人格', { max: 32 });
    if (!promptStore.getMode(cfg.persona)) throw new HttpError(400, `找不到「${cfg.persona}」這個模式`);
  }
  return cfg;
}

function describeCfg(cfg) {
  return cfg.kind === 'single' ? `單一人格「${modeName(cfg.persona) ?? cfg.persona}」` : '多人格';
}

// 每個統計桶補上「計費 token」（total 扣掉搜尋取回的內容，見 tokenTracker）
function withBillable(group) {
  return Object.fromEntries(Object.entries(group).map(([k, b]) => [k, { ...b, billable: tokenTracker.billableTotal(b) }]));
}

/**
 * 各伺服器的插話設定（機率、頻道開關）；extra(guild) 回傳要附加在每個伺服器上的欄位
 * @param {import('discord.js').Client} client
 * @param {(guild: import('discord.js').Guild) => object} [extra]
 */
function guildRows(client, extra = () => ({})) {
  const chances = aiChance.listReplyChances();
  const disabled = new Set(aiChance.listDisabledChannels());
  return [...client.guilds.cache.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
    .map((guild) => {
      const channels = guildChannels(guild, [...TEXT_TYPES, ...VOICE_TYPES]);
      const listed = new Set(channels.map((c) => c.id));
      // 討論串等不在清單裡、但被停用過的頻道也要列出來，才能重新開啟
      const extraChannels = [...disabled]
        .map((id) => describeChannel(client, id))
        .filter((c) => c.guildId === guild.id && !listed.has(c.id))
        .map((c) => ({ id: c.id, name: c.name, kind: 'thread', category: null }));
      return {
        ...guildSummary(guild),
        chance: chances[guild.id] ?? null,
        channels: [...channels, ...extraChannels].map((c) => ({ ...c, disabled: disabled.has(c.id) })),
        ...extra(guild),
      };
    });
}

const searchGuilds = (client) => [...ENABLED_GUILD_IDS].map((id) => ({ id, name: client.guilds.cache.get(id)?.name ?? null }));

module.exports = function registerAi(router, client) {
  const lock = persona.getLock();
  const guildName = (id) => client.guilds.cache.get(id)?.name ?? id;

  if (lock) {
    // ── 鎖定：單一人格（對話記憶以頻道為單位）─────────────────
    router.get('/api/ai/settings', () => {
      requireReady(client);
      return {
        model: MODEL_NAME,
        limits: aiQuota.getLimits(),
        searchGuilds: searchGuilds(client),
        persona: {
          key: lock.persona,
          name: persona.getPersonaName(lock.persona),
          // false：找不到 data/prompts/modes/<key>.md，用內建的通用人格
          fromFile: persona.hasPersonaFile(lock.persona),
        },
        memoryScope: 'channel',
        replyChance: { default: aiChance.DEFAULT_CHANCE, guilds: guildRows(client) },
      };
    });
  } else {
    registerMulti(router, client, guildName);
  }

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

  // ── 清除頻道的對話記憶（等同 /ai clear all:true）─────────
  router.post('/api/ai/memory/channel/:channelId', ({ params, audit }) => {
    const channelId = snowflake(params.channelId, '頻道');
    const ch = describeChannel(client, channelId);
    if (!ch.guildId) throw new HttpError(404, '找不到這個頻道');
    aiMemoryState.clearChannelMemory(channelId);
    audit(`清除「${ch.guildName ?? '?'} › #${ch.name ?? channelId}」的 AI 對話記憶`);
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

// 不鎖定（多人格）：設定總覽、範圍、使用者人格、清除個人記憶、成員搜尋
function registerMulti(router, client, guildName) {
  const aiScope = require('../../handlers/ai/aiScope');
  const modeSelector = require('../../handlers/ai/modeSelector');

  router.get('/api/ai/settings', async () => {
    requireReady(client);
    const overrides = modeSelector.listUserModes();
    const fixed = modeSelector.listFixedUserModes();
    const users = await resolveUsers(client, [...Object.keys(overrides), ...Object.keys(fixed)]);
    const scopes = aiScope.listScopes();

    const guilds = guildRows(client, (guild) => ({
      scope: scopeEntry(scopes.guilds[guild.id]),
      channelScopes: Object.fromEntries(Object.entries(scopes.channels)
        .filter(([, e]) => e.guildId === guild.id && e.kind)
        .map(([id, e]) => [id, { ...scopeEntry(e), name: describeChannel(client, id).name ?? null }])),
    }));

    return {
      model: MODEL_NAME,
      visionModel: VISION_MODEL_NAME,
      limits: aiQuota.getLimits(),
      searchGuilds: searchGuilds(client),
      modes: promptStore.listModes().sort().map((key) => ({ key, name: modeName(key) })),
      defaultMode: DEFAULT_MODE,
      userModes: Object.entries(overrides).map(([userId, mode]) => ({
        user: users[userId],
        mode,
        modeName: modeName(mode),
      })),
      // AI_USER_MODE_OVERRIDES 指定的固定人格；modeName 為 null 代表模式檔不存在
      fixedUserModes: Object.entries(fixed).map(([userId, mode]) => ({
        user: users[userId],
        mode,
        modeName: modeName(mode),
        overridden: !!overrides[userId],   // 被 /ai mode 蓋過，目前不生效
      })),
      replyChance: { default: aiChance.DEFAULT_CHANCE, guilds },
    };
  });

  const userName = async (id) => {
    const user = client.isReady() ? (await resolveUsers(client, [id]))[id] : null;
    return user && !user.missing ? user.name : id;
  };

  // ── 多人格／單一人格範圍（等同 /ai scope set / reset）────────
  router.put('/api/ai/scope/channel/:channelId', ({ params, body, audit }) => {
    const channelId = snowflake(params.channelId, '頻道');
    const ch = describeChannel(client, channelId);
    if (!ch.guildId) throw new HttpError(404, '找不到這個頻道');
    const cfg = scopeCfg(aiScope, body);
    const result = aiScope.setChannelScope(channelId, ch.guildId, cfg, null);
    if (!result.ok) throw new HttpError(400, result.error);
    audit(`把「${ch.guildName ?? '?'} › #${ch.name ?? channelId}」的 AI 範圍設為${describeCfg(cfg)}`);
    return { scope: result.scope };
  });

  router.delete('/api/ai/scope/channel/:channelId', ({ params, audit }) => {
    const channelId = snowflake(params.channelId, '頻道');
    const ch = describeChannel(client, channelId);
    const guildId = ch.guildId ?? aiScope.getChannelEntry(channelId)?.guildId;
    if (!guildId) throw new HttpError(404, '找不到這個頻道');
    const result = aiScope.setChannelScope(channelId, guildId, null, null);
    if (!result.ok) throw new HttpError(400, result.error);
    audit(`移除「${ch.guildName ?? '?'} › #${ch.name ?? channelId}」的 AI 範圍覆寫`);
    return { scope: result.scope };
  });

  router.put('/api/ai/scope/:guildId', ({ params, body, audit }) => {
    const guildId = snowflake(params.guildId, '伺服器');
    const cfg = scopeCfg(aiScope, body);
    const result = aiScope.setGuildScope(guildId, cfg, null);
    if (!result.ok) throw new HttpError(400, result.error);
    audit(`把「${guildName(guildId)}」的 AI 範圍設為${describeCfg(cfg)}`);
    return { scope: result.scope };
  });

  router.delete('/api/ai/scope/:guildId', ({ params, audit }) => {
    const guildId = snowflake(params.guildId, '伺服器');
    const result = aiScope.setGuildScope(guildId, null, null);
    if (!result.ok) throw new HttpError(400, result.error);
    audit(`把「${guildName(guildId)}」的 AI 範圍恢復預設（多人格）`);
    return { scope: result.scope };
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
    aiMemoryState.clearUserMemory(userId);
    audit(`清除 ${await userName(userId)} 的 AI 對話記憶`);
  });

  router.get('/api/members/search', async ({ query }) => {
    requireReady(client);
    const q = str(query.get('q'), '搜尋文字', { max: 100 });
    return { members: await searchMembers(client, q) };
  });
}
