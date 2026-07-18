'use strict';

const { round2 } = require('./calculator');

/**
 * 貪心演算法：將淨額轉換成最少筆數的轉帳清單
 * 每次找出目前「欠最多的人」與「該收最多的人」互相抵銷，
 * 直到所有人的淨額歸零。這能自動抵銷交叉債務
 * （例如 A欠B 100，B欠C 100 -> 直接簡化為 A給C 100）。
 *
 * @param {Object} net { userId: number } 正值=應收, 負值=應付
 * @returns {Array<{from:string, to:string, amount:number}>}
 */
function simplifyDebts(net) {
  const debtors = [];
  const creditors = [];

  for (const [userId, amount] of Object.entries(net)) {
    const a = round2(amount);
    if (a < -0.01) debtors.push({ id: userId, amount: round2(-a) });
    else if (a > 0.01) creditors.push({ id: userId, amount: a });
  }

  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const transactions = [];
  let i = 0;
  let j = 0;

  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];
    const amount = round2(Math.min(debtor.amount, creditor.amount));

    if (amount > 0.01) {
      transactions.push({ from: debtor.id, to: creditor.id, amount });
    }

    debtor.amount = round2(debtor.amount - amount);
    creditor.amount = round2(creditor.amount - amount);

    if (debtor.amount <= 0.01) i++;
    if (creditor.amount <= 0.01) j++;
  }

  return transactions;
}

/**
 * 與 simplifyDebts 相同的貪心簡化演算法，但額外附加每筆轉帳「換算前是由哪些
 * 原始幣別組成」的分解資訊，用於畫面顯示成：
 *   26046 TWD (1236 TWD + 639937 JPY)
 *
 * 做法：先依每位「欠款人」自己的原始幣別淨額（換算成基準幣別的權重），
 * 算出他欠的這筆基準幣總額裡，各幣別各佔多少比例；每次貪心演算法分配
 * 一筆轉帳金額給某位收款人時，就依同樣比例，從欠款人身上按比例扣除、
 * 分配到這筆轉帳的幣別組成中，並換算回原始幣別數字顯示。
 * 這是「比例分攤」的顯示方式，並非追蹤每一筆花費的實際金流，
 * 但可以確保加總後與基準幣總額完全一致。
 *
 * @param {Object} net { userId: number } 基準幣別淨額（權威數字，來自 calcNetBalances）
 * @param {Object} netByCurrency { userId: { currency: rawAmount } } 原始幣別淨額（未換算）
 * @param {Object} rates { currency: rateToBase } 用來將原始幣別換算成基準幣別的匯率（僅用於分攤權重與換算回顯示用途）
 * @param {string} baseCurrency 基準幣別代碼
 * @returns {Array<{from:string, to:string, amount:number, breakdown:Array<{currency:string, amount:number}>}>}
 */
function simplifyDebtsWithBreakdown(net, netByCurrency, rates, baseCurrency) {
  const debtors = [];
  const creditors = [];

  for (const [userId, amount] of Object.entries(net)) {
    const a = round2(amount);
    if (a < -0.01) debtors.push({ id: userId, amount: round2(-a) });
    else if (a > 0.01) creditors.push({ id: userId, amount: a });
  }

  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  // 為每位欠款人建立「這筆欠款的幣別組成」(單位：基準幣別)，
  // 之後每分配一筆轉帳，就依剩餘比例同步扣減。
  const composition = {};
  for (const debtor of debtors) {
    const raw = netByCurrency[debtor.id] || {};
    // 只取「他在這個幣別是負的（等於是欠這個幣別的錢）」的部分當作權重來源，
    // 較符合直覺；如果完全沒有負值成分（例如淨額因跨幣別抵銷而成負），
    // 則退回使用所有幣別成分的絕對值當權重。
    let weights = {};
    let weightSum = 0;
    for (const [currency, rawAmount] of Object.entries(raw)) {
      if (rawAmount < 0) {
        const baseEquivalent = Math.abs(rawAmount) * (rates[currency] ?? 1);
        weights[currency] = baseEquivalent;
        weightSum += baseEquivalent;
      }
    }
    if (weightSum <= 0) {
      weights = {};
      weightSum = 0;
      for (const [currency, rawAmount] of Object.entries(raw)) {
        const baseEquivalent = Math.abs(rawAmount) * (rates[currency] ?? 1);
        if (baseEquivalent > 0) {
          weights[currency] = baseEquivalent;
          weightSum += baseEquivalent;
        }
      }
    }

    const comp = {};
    if (weightSum > 0) {
      for (const [currency, weight] of Object.entries(weights)) {
        comp[currency] = round2((weight / weightSum) * debtor.amount);
      }
    } else {
      // 完全沒有幣別資料時（理論上不會發生），全部歸給基準幣別
      comp[baseCurrency] = debtor.amount;
    }
    composition[debtor.id] = comp;
  }

  const transactions = [];
  let i = 0;
  let j = 0;

  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];
    const amount = round2(Math.min(debtor.amount, creditor.amount));

    if (amount > 0.01) {
      const comp = composition[debtor.id];
      const remainingBefore = debtor.amount;
      const breakdown = [];

      if (remainingBefore > 0.01) {
        for (const currency of Object.keys(comp)) {
          const portionBase = round2(comp[currency] * (amount / remainingBefore));
          if (Math.abs(portionBase) < 0.005) continue;
          comp[currency] = round2(comp[currency] - portionBase);
          const rate = rates[currency] ?? 1;
          const rawAmount = round2(portionBase / rate);
          breakdown.push({ currency, amount: rawAmount });
        }
      }

      transactions.push({ from: debtor.id, to: creditor.id, amount, breakdown });
    }

    debtor.amount = round2(debtor.amount - amount);
    creditor.amount = round2(creditor.amount - amount);

    if (debtor.amount <= 0.01) i++;
    if (creditor.amount <= 0.01) j++;
  }

  return transactions;
}

module.exports = { simplifyDebts, simplifyDebtsWithBreakdown };
