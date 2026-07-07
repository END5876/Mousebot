'use strict';

/**
 * 將金額四捨五入到小數第 2 位（避免浮點數誤差）
 */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * 將某幣別金額換算成基準幣別金額
 */
function toBase(amount, currency, rates) {
  const rate = rates[currency];
  if (typeof rate !== 'number' || rate <= 0) {
    throw new Error(`找不到幣別 ${currency} 的匯率，請先用 /currency setrate 設定`);
  }
  return round2(amount * rate);
}

/**
 * 平均分攤計算（💡 新需求：無條件進位到整數）
 * 例：100 元由 3 人平分 -> 每人 34 元
 */
function equalSplit(amount, participantIds) {
  if (!participantIds.length) throw new Error('參與分攤的成員不可為空');
  const n = participantIds.length;
  
  // 💡 無條件進位到整數
  const share = Math.ceil(amount / n);
  
  return participantIds.map(userId => ({ userId, share }));
}

function validateCustomSplit(amount, shares) {
  const sum = round2(shares.reduce((s, x) => s + x.share, 0));
  const diff = round2(Math.abs(sum - amount));
  if (diff > 0.01) {
    throw new Error(`自訂金額總和 (${sum}) 與總花費 (${amount}) 不相符，差額 ${diff}`);
  }
}

function validatePayers(amount, payers) {
  const sum = round2(payers.reduce((s, x) => s + x.amount, 0));
  const diff = round2(Math.abs(sum - amount));
  if (diff > 0.01) {
    throw new Error(`代墊金額總和 (${sum}) 與總花費 (${amount}) 不相符，差額 ${diff}`);
  }
}

/**
 * 計算行程內所有成員的淨額 (已修復 Rounding Leak 版本)
 */
function calcNetBalances(trip) {
  const net = {};
  for (const m of trip.members) net[m.id] = 0;

  for (const exp of trip.expenses) {
    let payerBaseSum = 0;
    for (let i = 0; i < exp.payers.length; i++) {
      const p = exp.payers[i];
      let baseAmount;
      if (i === exp.payers.length - 1) {
        baseAmount = round2(exp.amountInBase - payerBaseSum);
      } else {
        baseAmount = convertPayerOrShareToBase(p.amount, exp);
        payerBaseSum += baseAmount;
      }
      net[p.userId] = round2((net[p.userId] || 0) + baseAmount);
    }

    let shareBaseSum = 0;
    for (let i = 0; i < exp.participants.length; i++) {
      const s = exp.participants[i];
      const originalAmount = s.amount ?? s.share ?? 0;
      let baseAmount;
      if (i === exp.participants.length - 1) {
        baseAmount = round2(exp.amountInBase - shareBaseSum);
      } else {
        baseAmount = convertPayerOrShareToBase(originalAmount, exp);
        shareBaseSum += baseAmount;
      }
      net[s.userId] = round2((net[s.userId] || 0) - baseAmount);
    }
  }
  return net;
}

function convertPayerOrShareToBase(amount, exp) {
  if (!exp.amount || exp.amount === 0) return 0;
  const ratio = exp.amountInBase / exp.amount;
  return round2(amount * ratio);
}

async function fetchRealTimeRate(fromCurrency, toCurrency) {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  if (from === to) return 1;
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://open.er-api.com/v6/latest/${from}`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`API 狀態碼異常: ${res.status}`);
    const data = await res.json();
    if (data?.rates?.[to]) {
      return Math.round((data.rates[to] + Number.EPSILON) * 10000) / 10000;
    }
  } catch (error) {
    console.error(`⚠️ 即時匯率抓取失敗 (${from} -> ${to}):`, error.message);
  }
  return null;
}

module.exports = {
  round2, toBase, equalSplit, validateCustomSplit, validatePayers,
  calcNetBalances, convertPayerOrShareToBase, fetchRealTimeRate
};
