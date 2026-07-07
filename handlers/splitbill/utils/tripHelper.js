'use strict';

const storage = require('./storage');

/**
 * 依名稱（可省略，改用當前伺服器啟用中的行程）取得行程物件
 * @returns {{ guild: object, trip: object|null, error: string|null }}
 */
function resolveTrip(guildId, tripName) {
  const guild = storage.getGuild(guildId);

  if (tripName) {
    const found = Object.values(guild.trips).find(
      (t) => t.name === tripName || t.id === tripName
    );
    if (!found) {
      return { guild, trip: null, error: `找不到名為「${tripName}」的行程` };
    }
    return { guild, trip: found, error: null };
  }

  if (!guild.activeTripId || !guild.trips[guild.activeTripId]) {
    return {
      guild,
      trip: null,
      error: '尚未指定行程。請先用 `/trip select` 選擇行程，或在指令中指定 trip 名稱。',
    };
  }
  return { guild, trip: guild.trips[guild.activeTripId], error: null };
}

function listTripChoices(guildId, query = '') {
  const guild = storage.getGuild(guildId);
  const q = query.toLowerCase();
  return Object.values(guild.trips)
    .filter((t) => !t.archived)
    .filter((t) => t.name.toLowerCase().includes(q))
    .slice(0, 25)
    .map((t) => ({ name: t.name, value: t.name }));
}

function memberDisplay(trip, userId) {
  const m = trip.members.find((x) => x.id === userId);
  return m ? m.name : `<@${userId}>`;
}

function ensureMembersExist(trip, userIds) {
  const memberIds = new Set(trip.members.map((m) => m.id));
  const missing = userIds.filter((id) => !memberIds.has(id));
  if (missing.length) {
    throw new Error(
      `以下成員尚未加入此行程，請先用 /member add 新增：${missing.map((id) => `<@${id}>`).join(', ')}`
    );
  }
}

module.exports = { resolveTrip, listTripChoices, memberDisplay, ensureMembersExist };
