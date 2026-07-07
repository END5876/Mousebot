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
  // 過濾掉接近 0 的誤差（< 0.01 視為已結清）
  const debtors = []; // 欠錢的人 { id, amount(正值) }
  const creditors = []; // 該收錢的人 { id, amount(正值) }

  for (const [userId, amount] of Object.entries(net)) {
    const a = round2(amount);
    if (a < -0.01) debtors.push({ id: userId, amount: round2(-a) });
    else if (a > 0.01) creditors.push({ id: userId, amount: a });
  }

  // 由大到小排序，讓最大額度優先互相抵銷，減少轉帳筆數
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

module.exports = { simplifyDebts };
