'use strict';

const { round2 } = require('./calculator');

/**
 * 貪心演算法：將淨額轉換成最少筆數的轉帳清單
 * （此函式無需修改，維持原樣）
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
 *   3400 TWD (20000 JPY - 1000 TWD)
 *
 * 【修正說明】
 * 舊版做法：只挑選「該幣別淨額為負」的成分當作權重來源，再依比例分攤
 * debtor.amount。這在該成員「所有幣別都同方向虧欠」時沒問題，但只要
 * 出現「某幣別多墊（正）、某幣別超支（負）」的混合情況，就會：
 *   1. 完全忽略正值幣別成分，導致該筆墊款資訊在畫面上消失
 *   2. 把本該由被忽略幣別承擔的金額，錯誤地灌到其他幣別上，
 *      顯示出跟使用者實際超支金額不符的「灌水數字」
 *
 * 新版做法：直接對「每一個」原始幣別成分取 -rawAmount * rate，
 * 不做任何比例分攤或篩選。因為 debtor.amount 本身的定義就是
 * -net = -Σ(rawAmount_currency * rate_currency)，所以這樣取出來的
 * 每一項，加總後必定精確等於 debtor.amount，且每一項都是真實存在
 * 的原始幣別數字，不會有资訊消失或被扭曲的問題。
 *
 * 注意：breakdown 裡的 amount 可能為負值（代表該幣別上是「倒扣」的
 * 墊款，會減少債務人的欠款總額），畫面顯示時需要正確處理正負號
 * （例如：正數項目在前不加符號，負數項目在後以 " - " 連接）。
 *
 * @param {Object} net { userId: number } 基準幣別淨額（權威數字，來自 calcNetBalances）
 * @param {Object} netByCurrency { userId: { currency: rawAmount } } 原始幣別淨額（未換算）
 * @param {Object} rates { currency: rateToBase } 用來將原始幣別換算成基準幣別的匯率
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

  // 為每位欠款人建立「這筆欠款的幣別組成」(單位：基準幣別)。
  // 直接取每個原始幣別成分的 -rawAmount * rate，不做比例分攤，
  // 確保加總後精確等於 debtor.amount，且每一項都是真實數字。
  const composition = {};
  for (const debtor of debtors) {
    const raw = netByCurrency[debtor.id] || {};
    const comp = {};
    for (const [currency, rawAmount] of Object.entries(raw)) {
      const rate = rates[currency] ?? 1;
      const baseVal = round2(-rawAmount * rate);
      if (Math.abs(baseVal) >= 0.005) {
        comp[currency] = baseVal;
      }
    }
    // 理論上不會發生（因為 debtor 存在代表 raw 裡至少有淨負值成分），
    // 但保留防呆：完全沒有幣別資料時，全部歸給基準幣別
    if (Object.keys(comp).length === 0) {
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
        const ratio = amount / remainingBefore;
        for (const currency of Object.keys(comp)) {
          const portionBase = round2(comp[currency] * ratio);
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
