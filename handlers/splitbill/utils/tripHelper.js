'use strict';

const storage = require('./storage');

/**
 * 依名稱（可省略）取得行程物件；若未指定名稱，改用「該使用者」自己的作用中行程。
 *
 * 🔒 [修正：切換行程影響全體 / race condition]
 * 舊版永遠讀取 guild.activeTripId（全伺服器共用一個指標），A 操作到一半時 B 切換
 * 行程，會讓 A 後續的動作套用到 B 選的行程上。現在每個使用者有自己的
 * activeTripByUser 指標，彼此獨立，只有在使用者「從未選過」時才退回伺服器預設行程。
 *
 * @param {string} guildId
 * @param {string|null|undefined} tripName 明確指定行程名稱/ID 時優先使用（現有語意不變）
 * @param {string|null|undefined} userId 發起操作的使用者 ID，用來查詢其個人作用行程
 * @returns {{ guild: object, trip: object|null, error: string|null }}
 */
function resolveTrip(guildId, tripName, userId) {
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

  const personalTripId = userId ? guild.activeTripByUser[userId] : null;
  if (personalTripId && guild.trips[personalTripId]) {
    return { guild, trip: guild.trips[personalTripId], error: null };
  }

  // 使用者尚未自己選過行程 → 退回伺服器預設行程（例如剛建立的第一個行程）
  if (!guild.defaultTripId || !guild.trips[guild.defaultTripId]) {
    return {
      guild,
      trip: null,
      error: '尚未指定行程。請先到「🧳 行程設定」建立或選擇你要使用的行程。',
    };
  }
  return { guild, trip: guild.trips[guild.defaultTripId], error: null };
}

/**
 * 依 ID 直接取得行程（不做個人化/預設值回退），用於多步驟流程中途要「鎖定」
 * 使用開始當下那個行程、避免使用者中途切換自己的作用行程造成資料寫錯地方。
 * @returns {object|null}
 */
function resolveTripById(guildId, tripId) {
  if (!tripId) return null;
  const guild = storage.getGuild(guildId);
  return guild.trips[tripId] || null;
}

/**
 * 設定某使用者自己的作用中行程（僅影響該使用者，不影響其他人）。
 */
function setUserActiveTrip(guildId, userId, tripId) {
  const guild = storage.getGuild(guildId);
  guild.activeTripByUser[userId] = tripId;
  return guild;
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

/**
 * 判斷某使用者是否為指定行程的成員。
 * 用於權限管控：非行程內成員一律禁止操作該行程（記帳／成員／結算／行程設定等）。
 */
function isTripMember(trip, userId) {
  return !!trip && Array.isArray(trip.members) && trip.members.some((m) => m.id === userId);
}

/**
 * 🔒 [修正：孤兒行程] 檢查「移除掉 removeUserIds 這些人之後」行程是否仍至少保留 1 位成員。
 * 一旦行程 0 成員，之後任何人（包含原成員）都無法再通過 isTripMember 檢查，
 * 該行程就會變成沒有人能操作、也沒有人能刪除的「孤兒行程」。
 * @returns {boolean} true 代表移除後仍安全（至少剩 1 人）
 */
function wouldLeaveTripNonEmpty(trip, removeUserIds) {
  if (!trip || !Array.isArray(trip.members)) return false;
  const removeSet = new Set(removeUserIds);
  return trip.members.some((m) => !removeSet.has(m.id));
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

module.exports = {
  resolveTrip,
  resolveTripById,
  setUserActiveTrip,
  listTripChoices,
  memberDisplay,
  ensureMembersExist,
  isTripMember,
  wouldLeaveTripNonEmpty,
};
