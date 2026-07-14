'use strict';

/**
 * 預收款（訂金）功能
 * -------------------------------------------------
 * 適用情境：多人出國由一人（收款人）先代收訂金，等機票/住宿等
 * 實際花費金額確定後，系統自動把「已收訂金」與「應分攤的實際花費」
 * 互相抵銷，算出每個人最終「多退」或「少補」的金額。
 */

const crypto = require('crypto');
const { round2, toBase } = require('./calculator');

/**
 * 新增一筆預收款紀錄
 * @param {object} trip
 * @param {{collectorId:string, payerId:string, amount:number, currency?:string, note?:string}} input
 * @returns {object} 新建立的 deposit 物件
 */
function addDeposit(trip, { collectorId, payerId, amount, currency, note }) {
  if (!collectorId || !payerId) throw new Error('必須指定收款人與付款人');
  if (collectorId === payerId) throw new Error('收款人與付款人不能是同一人');
  if (!(amount > 0)) throw new Error('金額必須大於 0');

  const cur = currency || trip.baseCurrency;
  const amountInBase = round2(toBase(amount, cur, trip.rates));

  const deposit = {
    id: `dep_${crypto.randomBytes(4).toString('hex')}`,
    collectorId,
    payerId,
    amount: round2(amount),
    currency: cur,
    amountInBase,
    note: note || '',
    createdAt: Date.now(),
  };

  if (!Array.isArray(trip.deposits)) trip.deposits = [];
  trip.deposits.push(deposit);
  return deposit;
}

/** 刪除一筆預收款紀錄 */
function removeDeposit(trip, depositId) {
  if (!Array.isArray(trip.deposits)) return false;
  const idx = trip.deposits.findIndex((d) => d.id === depositId);
  if (idx === -1) return false;
  trip.deposits.splice(idx, 1);
  return true;
}

/** 查看某位收款人目前手上「尚未被實際花費消耗」的預收款總額（供 UI 顯示） */
function summarizeDeposits(trip, collectorId) {
  const list = (trip.deposits || []).filter((d) => d.collectorId === collectorId);
  const total = round2(list.reduce((s, d) => s + d.amountInBase, 0));
  return { list, total };
}

module.exports = { addDeposit, removeDeposit, summarizeDeposits };
