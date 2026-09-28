'use strict';

// 🌐 [service 拆分] 行程資料的讀取／寫入（resolveTrip、resolveTripById、
// setUserActiveTrip、listTripChoices）已搬到 ./splitbillClient.js，透過 API
// 呼叫獨立部署的 splitbill-service。這個檔案只保留「拿到 trip 物件之後」的
// 純函式判斷，不碰任何 I/O。

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
  memberDisplay,
  ensureMembersExist,
  isTripMember,
  wouldLeaveTripNonEmpty,
};
