'use strict';
// admin/discordInfo.js
// ─────────────────────────────────────────────────────────────
// 把 Discord ID 轉成網頁看得懂的名稱（伺服器、頻道、使用者），以及各種下拉選單用的清單。

const { ChannelType } = require('discord.js');
const { SNOWFLAKE_RE } = require('./http');

const TEXT_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const VOICE_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];

function guildSummary(guild) {
  return {
    id: guild.id,
    name: guild.name,
    iconUrl: guild.iconURL({ size: 64 }) ?? null,
    memberCount: guild.memberCount ?? null,
  };
}

function listGuilds(client) {
  return [...client.guilds.cache.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
    .map(guildSummary);
}

// 與 Discord 側邊欄的順序一致：沒有分類的在最前面，分類依位置排；同一分類裡文字頻道在語音頻道前面
function sortChannels(channels) {
  const isVoice = (c) => VOICE_TYPES.includes(c.type);
  return channels.sort((a, b) =>
    (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1)
    || Number(isVoice(a)) - Number(isVoice(b))
    || a.rawPosition - b.rawPosition);
}

function channelSummary(channel) {
  return {
    id: channel.id,
    name: channel.name,
    kind: VOICE_TYPES.includes(channel.type) ? 'voice' : 'text',
    category: channel.parent?.name ?? null,
  };
}

/** 伺服器內指定類型的頻道，依側邊欄順序排列 */
function guildChannels(guild, types) {
  return sortChannels([...guild.channels.cache.values()].filter((c) => types.includes(c.type))).map(channelSummary);
}

/** 頻道 ID → 名稱與所屬伺服器；Bot 看不到的頻道 missing 為 true */
function describeChannel(client, channelId) {
  const channel = client.channels.cache.get(channelId);
  if (!channel) return { id: channelId, name: null, guildId: null, guildName: null, missing: true };
  return {
    id: channel.id,
    name: channel.name ?? null,
    guildId: channel.guild?.id ?? null,
    guildName: channel.guild?.name ?? null,
    missing: false,
  };
}

function userSummary(user) {
  return {
    id: user.id,
    name: user.globalName || user.username,
    username: user.username,
    avatarUrl: user.displayAvatarURL({ size: 64 }),
    missing: false,
  };
}

const missingUser = (id) => ({ id, name: null, username: null, avatarUrl: null, missing: true });

// 確定不存在的帳號（Unknown User）記住一段時間，避免每次開頁面都重查
const UNKNOWN_USER = 10013;
const unknownUntil = new Map();
const UNKNOWN_TTL_MS = 10 * 60 * 1000;
const FETCH_CONCURRENCY = 4;

/**
 * 一次解析多個使用者 ID（快取裡沒有的才向 Discord 查詢，少量並行）
 * @returns {Promise<Record<string, ReturnType<typeof userSummary>>>}
 */
async function resolveUsers(client, ids) {
  const out = {};
  const pending = [];
  for (const id of new Set(ids)) {
    if (!SNOWFLAKE_RE.test(id)) { out[id] = missingUser(id); continue; }
    const cached = client.users.cache.get(id);
    if (cached) out[id] = userSummary(cached);
    else if ((unknownUntil.get(id) ?? 0) > Date.now()) out[id] = missingUser(id);
    else pending.push(id);
  }

  for (let i = 0; i < pending.length; i += FETCH_CONCURRENCY) {
    await Promise.all(pending.slice(i, i + FETCH_CONCURRENCY).map(async (id) => {
      try {
        out[id] = userSummary(await client.users.fetch(id));
      } catch (err) {
        if (err.code === UNKNOWN_USER) unknownUntil.set(id, Date.now() + UNKNOWN_TTL_MS);
        out[id] = missingUser(id);
      }
    }));
  }
  return out;
}

/**
 * 在 Bot 所在的所有伺服器裡搜尋成員（名稱開頭比對）；也接受直接貼上使用者 ID
 * @returns {Promise<Array<ReturnType<typeof userSummary> & { guildName: string|null, displayName: string }>>}
 */
async function searchMembers(client, query, limit = 10) {
  const results = new Map();
  await Promise.all([...client.guilds.cache.values()].map(async (guild) => {
    try {
      const members = await guild.members.search({ query, limit });
      for (const m of members.values()) {
        if (m.user.bot || results.has(m.id)) continue;
        results.set(m.id, { ...userSummary(m.user), guildName: guild.name, displayName: m.displayName });
      }
    } catch {}
  }));

  if (SNOWFLAKE_RE.test(query) && !results.has(query)) {
    const user = (await resolveUsers(client, [query]))[query];
    if (!user.missing) results.set(query, { ...user, guildName: null, displayName: user.name });
  }
  return [...results.values()].slice(0, 20);
}

module.exports = {
  TEXT_TYPES,
  VOICE_TYPES,
  guildSummary,
  listGuilds,
  guildChannels,
  describeChannel,
  resolveUsers,
  searchMembers,
};
