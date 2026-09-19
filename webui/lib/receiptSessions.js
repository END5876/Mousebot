'use strict';
/**
 * 🆕 [多人協作] 帳單辨識認領進度的共享狀態。
 * -----------------------------------------------------------------
 * 刻意不落地寫進 data/splitbill.json：這只是「掃描到建立成支出之前」那段
 * 過程中，讓同一個行程裡多個擁有可編輯權限的人（擁有者本人、或 write 權限
 * 的分享連結持有者）可以同時看到、同時點選認領對象的暫時性協作狀態。
 * 一個行程同時只會有一份「進行中」的協作狀態（後開始的人會直接覆蓋掉），
 * 這對「大家一起認領同一張帳單」的情境來說已經足夠，不需要處理多張帳單
 * 同時協作的複雜度。
 *
 * 沒有人在看、也沒有人更新超過 TTL 時間，視為過期，GET 端點會回報「沒有
 * 進行中的協作」，之後就會被下一次寫入覆蓋掉，不需要額外的排程清除。
 */

const TTL_MS = 20 * 60 * 1000; // 20 分鐘沒有任何人更新，視為已經沒人在用

const sessionsByTripId = new Map(); // tripId -> { state, updatedAt, writerId }

function isExpired(entry) {
  return !entry || (Date.now() - entry.updatedAt) > TTL_MS;
}

/** 取得某行程目前進行中的協作狀態；已過期或不存在則回傳 null（並順手清掉過期資料）。 */
function getReceiptSession(tripId) {
  const entry = sessionsByTripId.get(tripId);
  if (isExpired(entry)) {
    if (entry) sessionsByTripId.delete(tripId);
    return null;
  }
  return entry;
}

/** 建立或整包覆寫某行程目前的協作狀態。 */
function setReceiptSession(tripId, state, writerId) {
  const entry = { state, updatedAt: Date.now(), writerId: writerId || null };
  sessionsByTripId.set(tripId, entry);
  return entry;
}

/** 結束某行程目前的協作狀態（帳單已建立成支出，或發起人主動取消）。 */
function clearReceiptSession(tripId) {
  sessionsByTripId.delete(tripId);
}

module.exports = { getReceiptSession, setReceiptSession, clearReceiptSession };
