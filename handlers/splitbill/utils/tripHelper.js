'use strict';

const { isOwner } = require('../../../utils/config');

// 🌐 [service 拆分] 行程資料的讀取／寫入已搬到 ./splitbillClient.js。這個檔案只保留
// 「拿到 trip 物件之後」的純函式判斷，不碰任何 I/O。
//
// 🆕 [行程獨立化] 成員的 id 不再等於 Discord ID：
//   - member.id：行程內部的成員 ID，帳目（payers/participants/deposits）一律引用它。
//     舊資料的 id 碰巧就是 Discord ID，新成員是 mem_xxxx。
//   - member.discordId：已連結的 Discord 帳號；沒有＝未連結（網頁上建立、尚未認領）。
// 所以：
//   - 從 Discord 拿到的使用者 ID（按鈕的操作者、使用者選單、@提及）→ 用
//     findMemberByDiscordId()／toMemberIds() 換成成員 ID 再寫進帳目
//   - 要顯示某位成員 → 用 memberMention()（已連結才 @，未連結顯示純文字名字）
//     或 memberDisplay()（一律顯示名字，給選單標籤、清單這類不該 @ 人的地方）

const SNOWFLAKE_RE = /^\d{17,20}$/;

function findMember(trip, memberId) {
  return (trip && Array.isArray(trip.members)) ? trip.members.find((m) => m.id === memberId) || null : null;
}

/** 依 Discord 使用者 ID 找出他在這個行程連結的成員；沒有則 null。 */
function findMemberByDiscordId(trip, discordUserId) {
  if (!trip || !Array.isArray(trip.members) || !discordUserId) return null;
  return trip.members.find((m) => m.discordId === discordUserId) || null;
}

/** 成員名字（純文字）。找不到的成員（已被移除）顯示提示文字。 */
function memberDisplay(trip, memberId) {
  const m = findMember(trip, memberId);
  if (m) return m.name;
  // 舊資料裡已被移除的成員 id 就是 Discord ID，至少還能 @ 到人
  return SNOWFLAKE_RE.test(String(memberId)) ? `<@${memberId}>` : '（已移除的成員）';
}

/** 已連結的成員用 Discord 提及；未連結的成員只顯示純文字名字（不能被提及）。 */
function memberMention(trip, memberId) {
  const m = findMember(trip, memberId);
  if (m && m.discordId) return `<@${m.discordId}>`;
  if (m) return m.name;
  return memberDisplay(trip, memberId);
}

/**
 * 判斷某位 Discord 使用者是否為指定行程的（已連結）成員。
 * 用於權限管控：非行程內成員一律禁止操作該行程（記帳／成員／結算／行程設定等）。
 * 未連結的成員不屬於任何 Discord 帳號，因此無法操作面板。
 */
function isTripMember(trip, discordUserId) {
  return !!findMemberByDiscordId(trip, discordUserId);
}

/**
 * 🔒 [修正：孤兒行程] 檢查「移除掉 removeMemberIds 這些成員之後」行程是否仍至少
 * 保留 1 位「已連結」的成員——只剩未連結成員的行程，Discord 這邊就沒有人能操作了
 * （建立者仍可從網頁管理，但 Discord 面板不該讓人親手把自己鎖在外面）。
 * @returns {boolean} true 代表移除後仍安全
 */
function wouldLeaveTripNonEmpty(trip, removeMemberIds) {
  if (!trip || !Array.isArray(trip.members)) return false;
  const removeSet = new Set(removeMemberIds);
  return trip.members.some((m) => !removeSet.has(m.id) && m.discordId);
}

/**
 * 判斷某使用者是否可以刪除指定行程。
 *  - 行程有 ownerId（建立者）：只有建立者本人，或 Bot 擁有者（OWNER_USER_ID）
 *  - 舊版行程沒有 ownerId：只開放 Bot 擁有者
 * 這只是 Bot 端的提示用檢查；真正的防線在 splitbill-service 的 DELETE 端點。
 */
function canDeleteTrip(trip, userId) {
  if (!trip || !userId) return false;
  if (isOwner(userId)) return true;
  return !!trip.ownerId && trip.ownerId === userId;
}

/**
 * 把一批 Discord 使用者 ID（來自 @提及、使用者選單）換成行程內的成員 ID。
 * 任何一位沒有連結到這個行程的成員就整批拋錯，訊息裡列出是哪些人。
 * @returns {string[]} 依原順序對應的成員 ID
 */
function toMemberIds(trip, discordUserIds) {
  const missing = [];
  const ids = discordUserIds.map((uid) => {
    const m = findMemberByDiscordId(trip, uid);
    if (!m) missing.push(uid);
    return m ? m.id : null;
  });
  if (missing.length) {
    throw new Error(
      `以下使用者不是這個行程的成員（或尚未連結 Discord 帳號），請先到面板「👥 成員管理」新增或連結：${missing.map((id) => `<@${id}>`).join(', ')}`
    );
  }
  return ids;
}

/** 確認一批「成員 ID」都存在於行程中。 */
function ensureMembersExist(trip, memberIds) {
  const existing = new Set(trip.members.map((m) => m.id));
  const missing = memberIds.filter((id) => !existing.has(id));
  if (missing.length) {
    throw new Error(`以下成員已不在此行程中：${missing.map((id) => memberDisplay(trip, id)).join(', ')}`);
  }
}

module.exports = {
  canDeleteTrip,
  memberDisplay,
  memberMention,
  findMemberByDiscordId,
  toMemberIds,
  ensureMembersExist,
  isTripMember,
  wouldLeaveTripNonEmpty,
};
