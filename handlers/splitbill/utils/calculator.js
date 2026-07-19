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
 */
function equalSplit(amount, participantIds) {
  if (!participantIds.length) throw new Error('參與分攤的成員不可為空');
  const n = participantIds.length;
  const baseShare = round2(amount / n);

  let accumulated = 0;
  return participantIds.map((userId, i) => {
    let share;
    if (i === n - 1) {
      share = round2(amount - accumulated);
    } else {
      share = baseShare;
      accumulated = round2(accumulated + share);
    }
    return { userId, share };
  });
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
 * ⚠️ 此函式未修改，維持原邏輯，因為它是主要結算依據的權威數字，
 *    跟「代墊 vs 訂金」的標籤語意問題無關。
 */
function calcNetBalances(trip) {
  const net = {};
  for (const m of (trip.members || [])) net[m.id] = 0;

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
 * 🆕 計算行程內所有成員「依原始幣別 + 來源」分開的淨額，不做任何換算。
 * 回傳結構：{ [userId]: { [currency]: { expense: number, deposit: number } } }
 *
 * 修改重點：
 * 原本 expense 和 deposit 會被丟進同一個數字累加，導致「訂金」被誤貼上
 * 「幫大家代墊」的標籤。現在改成分開記錄兩個來源，交給顯示層自行決定
 * 怎麼組合文字說明。
 */
function calcNetBalancesByCurrency(trip) {
  const net = {};
  const ensure = (userId) => {
    if (!net[userId]) net[userId] = {};
    return net[userId];
  };
  const add = (userId, currency, source, delta) => {
    if (!currency) return;
    const bucket = ensure(userId);
    if (!bucket[currency]) bucket[currency] = { expense: 0, deposit: 0 };
    bucket[currency][source] = round2((bucket[currency][source] || 0) + delta);
  };

  for (const m of (trip.members || [])) ensure(m.id);

  // 一般花費 → 標記為 'expense'
  for (const exp of (trip.expenses || [])) {
    const currency = exp.currency;
    for (const p of (exp.payers || [])) add(p.userId, currency, 'expense', p.amount);
    for (const s of (exp.participants || [])) {
      const shareAmount = s.amount ?? s.share ?? 0;
      add(s.userId, currency, 'expense', -shareAmount);
    }
  }

  // 訂金 → 標記為 'deposit'
  if (Array.isArray(trip.deposits)) {
    for (const d of trip.deposits) {
      const currency = d.currency || trip.baseCurrency;
      add(d.payerId, currency, 'deposit', d.amount);
      add(d.collectorId, currency, 'deposit', -d.amount);
    }
  }

  // 清除 expense 和 deposit 都幾乎為 0 的幣別紀錄
  for (const userId of Object.keys(net)) {
    for (const currency of Object.keys(net[userId])) {
      const { expense = 0, deposit = 0 } = net[userId][currency];
      if (Math.abs(expense) < 0.01 && Math.abs(deposit) < 0.01) {
        delete net[userId][currency];
      }
    }
  }

  return net;
}

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
 * 🆕 適配新的 netByCurrency 結構：{ currency: { expense, deposit } }
 * 換算時把 expense + deposit 加總後再乘匯率即可，因為換算成單一幣別
 * 結算時，來源已經不重要（只是為了明細顯示才拆開）。
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
    for (const [currency, sources] of Object.entries(netByCurrency[userId])) {
      const rate = rates[currency];
      if (typeof rate === 'number') {
        const total = (sources.expense || 0) + (sources.deposit || 0);
        sum += total * rate;
      }
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
