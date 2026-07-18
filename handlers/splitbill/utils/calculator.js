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
    throw new Error(`找不到幣別 ${currency} 的匯率，請先到「行程設定」確認匯率`);
  }
  return round2(amount * rate);
}

/**
 * 平均分攤計算（無條件進位到整數）
 * 例：100 元由 3 人平分 -> 每人 34 元
 */
function equalSplit(amount, participantIds) {
  if (!participantIds.length) throw new Error('參與分攤的成員不可為空');
  const n = participantIds.length;

  // 無條件進位到整數
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

function convertPayerOrShareToBase(amount, exp) {
  if (!exp.amount || exp.amount === 0) return 0;
  const ratio = exp.amountInBase / exp.amount;
  return round2(amount * ratio);
}

/**
 * 計算行程內所有成員的「基準幣別」淨額 (包含一般花費與預收款抵銷)。
 * 每筆花費 / 訂金在記錄當下就已經換算並存好 amountInBase，這裡直接加總即可，
 * 是主要結算畫面（每人淨額、最佳化轉帳）使用的權威數字。
 */
function calcNetBalances(trip) {
  const net = {};
  for (const m of (trip.members || [])) net[m.id] = 0;

  // 1. 計算一般花費 (expenses)
  for (const exp of (trip.expenses || [])) {
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
      if (net[p.userId] !== undefined) {
        net[p.userId] = round2(net[p.userId] + baseAmount);
      }
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
      if (net[s.userId] !== undefined) {
        net[s.userId] = round2(net[s.userId] - baseAmount);
      }
    }
  }

  // 2. 計算預收款/訂金 (deposits) 抵銷
  if (Array.isArray(trip.deposits)) {
    for (const d of trip.deposits) {
      if (net[d.payerId] !== undefined) {
        net[d.payerId] = round2(net[d.payerId] + d.amountInBase);
      }
      if (net[d.collectorId] !== undefined) {
        net[d.collectorId] = round2(net[d.collectorId] - d.amountInBase);
      }
    }
  }

  return net;
}

/**
 * 計算行程內所有成員「依原始幣別分開」的淨額，不做任何換算。
 * 回傳結構：{ [userId]: { [currency]: rawAmount } }
 * 用途：
 *  1. 在「每人淨額 / 最佳化轉帳」畫面中，附加顯示這筆基準幣金額
 *     實際是由哪些原始幣別構成（例如 "1236 TWD + 639937 JPY"）。
 *  2. 提供「換算成單一幣別結算」功能，用當下即時匯率重新統一換算。
 */
function calcNetBalancesByCurrency(trip) {
  const net = {};
  const ensure = (userId) => {
    if (!net[userId]) net[userId] = {};
    return net[userId];
  };
  const add = (userId, currency, delta) => {
    if (!currency) return;
    const bucket = ensure(userId);
    bucket[currency] = round2((bucket[currency] || 0) + delta);
  };

  for (const m of (trip.members || [])) ensure(m.id);

  for (const exp of (trip.expenses || [])) {
    const currency = exp.currency;
    for (const p of (exp.payers || [])) add(p.userId, currency, p.amount);
    for (const s of (exp.participants || [])) {
      const shareAmount = s.amount ?? s.share ?? 0;
      add(s.userId, currency, -shareAmount);
    }
  }

  if (Array.isArray(trip.deposits)) {
    for (const d of trip.deposits) {
      const currency = d.currency || trip.baseCurrency;
      add(d.payerId, currency, d.amount);
      add(d.collectorId, currency, -d.amount);
    }
  }

  for (const userId of Object.keys(net)) {
    for (const currency of Object.keys(net[userId])) {
      if (Math.abs(net[userId][currency]) < 0.01) delete net[userId][currency];
    }
  }

  return net;
}

/**
 * 取得此行程「實際出現過」的幣別清單（依花費 + 訂金紀錄），
 * 用於「換算成單一幣別結算」時的目標幣別選項 —
 * 例如行程內只用過 TWD、JPY，結算時就只能選這兩種幣別。
 */
function getUsedCurrencies(trip) {
  const set = new Set();
  for (const exp of (trip.expenses || [])) {
    if (exp.currency) set.add(exp.currency);
  }
  for (const d of (trip.deposits || [])) {
    if (d.currency) set.add(d.currency);
  }
  return Array.from(set);
}

/**
 * 將依幣別分開的原始淨額 (calcNetBalancesByCurrency 的回傳值)，
 * 用「當下即時匯率」統一換算成單一目標幣別。
 * 只有在使用者按下「換算成單一幣別結算」按鈕時才會呼叫。
 */
async function convertNetToSingleCurrency(netByCurrency, targetCurrency, trip) {
  const currencies = new Set();
  for (const userId of Object.keys(netByCurrency)) {
    for (const currency of Object.keys(netByCurrency[userId])) {
      currencies.add(currency);
    }
  }

  const rates = {};
  const failedCurrencies = [];

  for (const currency of currencies) {
    if (currency === targetCurrency) {
      rates[currency] = 1;
      continue;
    }

    const liveRate = await fetchRealTimeRate(currency, targetCurrency);
    if (typeof liveRate === 'number') {
      rates[currency] = liveRate;
      continue;
    }

    const toBaseFrom = trip.rates?.[currency];
    const toBaseTarget = trip.rates?.[targetCurrency];
    if (toBaseFrom && toBaseTarget) {
      rates[currency] = round2(toBaseFrom / toBaseTarget);
    } else {
      rates[currency] = null;
      failedCurrencies.push(currency);
    }
  }

  const converted = {};
  for (const userId of Object.keys(netByCurrency)) {
    let sum = 0;
    for (const [currency, amount] of Object.entries(netByCurrency[userId])) {
      const rate = rates[currency];
      if (typeof rate === 'number') sum += amount * rate;
    }
    converted[userId] = round2(sum);
  }

  return { converted, rates, failedCurrencies };
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
  calcNetBalances, calcNetBalancesByCurrency, convertPayerOrShareToBase,
  getUsedCurrencies, convertNetToSingleCurrency, fetchRealTimeRate
};
