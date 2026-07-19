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
 * 計算行程內所有成員的「基準幣別」淨額 (包含一般花費與轉帳抵銷)。
 * ⚠️ 此函式未修改，維持原邏輯，因為它是主要結算依據的權威數字，
 *    跟明細顯示方式無關。
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
 * 🆕【收支帳模式】計算行程內所有成員「依原始幣別 + 收支類別」分開的明細，不做任何換算。
 * 回傳結構：
 *   { [userId]: { [currency]: { paid, paidBase, share, shareBase, transferOut, transferOutBase, transferIn, transferInBase } } }
 *
 *   paid        ➕ 代墊花費（實際付出的花費金額）
 *   share       ➖ 應分攤花費（自己該負擔的份額）
 *   transferOut ➕ 直接轉帳給他人（不預設用途，可能是還款、預收團費等）
 *   transferIn  ➖ 收到他人直接轉帳
 *   *Base       對應欄位換算成行程基準幣別後的金額（供明細顯示，讓使用者不用自己查匯率就能驗算標題淨額）
 *
 * 修改重點（相較舊版）：
 * 舊版把「付的 − 該分攤的」直接混算成一個淨值（expense），導致明細只能
 * 顯示殘值，且正負號會跟標題（應收回/要補交）互相矛盾，使用者無法驗算。
 * 現在拆成四個獨立累加的欄位，顯示層可以完整重建「淨額 = ΣΣ ➕ − ΣΣ ➖」
 * 的收支帳，每一行都對應真實發生過的金流，方便對帳。
 * 🆕 這次再補上每個欄位的基準幣別等值（*Base），因為原始幣別金額（例如 JPY）
 * 使用者無法自行心算換成 TWD，導致明細看起來跟標題兜不起來、無法驗算。
 */
function calcNetBalancesByCurrency(trip) {
  const net = {};
  const ensure = (userId) => {
    if (!net[userId]) net[userId] = {};
    return net[userId];
  };
  const add = (userId, currency, field, delta, baseDelta) => {
    if (!currency) return;
    const bucket = ensure(userId);
    if (!bucket[currency]) {
      bucket[currency] = {
        paid: 0, paidBase: 0,
        share: 0, shareBase: 0,
        transferOut: 0, transferOutBase: 0,
        transferIn: 0, transferInBase: 0,
      };
    }
    bucket[currency][field] = round2(bucket[currency][field] + delta);
    bucket[currency][`${field}Base`] = round2(bucket[currency][`${field}Base`] + baseDelta);
  };

  for (const m of (trip.members || [])) ensure(m.id);

  // 一般花費 → 拆成 paid（代墊）與 share（應分攤），並同步累加基準幣別等值
  for (const exp of (trip.expenses || [])) {
    const currency = exp.currency;
    for (const p of (exp.payers || [])) {
      add(p.userId, currency, 'paid', p.amount, convertPayerOrShareToBase(p.amount, exp));
    }
    for (const s of (exp.participants || [])) {
      const shareAmount = s.amount ?? s.share ?? 0;
      add(s.userId, currency, 'share', shareAmount, convertPayerOrShareToBase(shareAmount, exp));
    }
  }

  // 直接轉帳（deposits）→ 拆成 transferOut（轉出）與 transferIn（收到）
  // deposit 本身已存有精確的 amountInBase，直接沿用即可（不必再用比例換算）
  if (Array.isArray(trip.deposits)) {
    for (const d of trip.deposits) {
      const currency = d.currency || trip.baseCurrency;
      add(d.payerId, currency, 'transferOut', d.amount, d.amountInBase);
      add(d.collectorId, currency, 'transferIn', d.amount, d.amountInBase);
    }
  }

  // 清除四個欄位都幾乎為 0 的幣別紀錄
  for (const userId of Object.keys(net)) {
    for (const currency of Object.keys(net[userId])) {
      const b = net[userId][currency];
      const allZero = ['paid', 'share', 'transferOut', 'transferIn'].every(k => Math.abs(b[k]) < 0.01);
      if (allZero) delete net[userId][currency];
    }
  }

  return net;
}

/**
 * 🆕 逐筆列出每位成員的「直接轉帳」紀錄，保留轉帳對象，不做加總彙整。
 * 用途：calcNetBalancesByCurrency 為了計算淨額，會把同一人所有轉帳依幣別加總成
 * 一個數字，一旦出現交叉轉帳（A轉給B、C又轉給A…）就會失去「轉給了誰」這個
 * 對使用者來說最關鍵的資訊，甚至可能讓一來一回的兩筆互相抵銷、被誤讀成沒事發生。
 * 這裡改成保留每一筆的對象，交給顯示層逐行列出。
 *
 * 回傳結構：
 *   { [userId]: [{ direction: 'out'|'in', counterpartId, amount, currency, amountInBase, note }] }
 */
function listTransfersByMember(trip) {
  const result = {};
  const push = (userId, entry) => {
    if (!result[userId]) result[userId] = [];
    result[userId].push(entry);
  };

  for (const d of (trip.deposits || [])) {
    const currency = d.currency || trip.baseCurrency;
    push(d.payerId, {
      direction: 'out',
      counterpartId: d.collectorId,
      amount: d.amount,
      currency,
      amountInBase: d.amountInBase,
      note: d.note || '',
    });
    push(d.collectorId, {
      direction: 'in',
      counterpartId: d.payerId,
      amount: d.amount,
      currency,
      amountInBase: d.amountInBase,
      note: d.note || '',
    });
  }

  return result;
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
 * 🆕 適配「收支帳」結構：{ currency: { paid, share, transferOut, transferIn } }
 * 換算時先算出該幣別的淨額（paid − share + transferOut − transferIn），
 * 再乘上匯率加總，因為換算成單一幣別結算時，來源類別已經不重要
 * （只是為了明細顯示才拆開）。
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
    for (const [currency, b] of Object.entries(netByCurrency[userId])) {
      const rate = rates[currency];
      if (typeof rate === 'number') {
        const netAmount = (b.paid || 0) - (b.share || 0) + (b.transferOut || 0) - (b.transferIn || 0);
        sum += netAmount * rate;
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
  getUsedCurrencies, convertNetToSingleCurrency, fetchRealTimeRate,
  listTransfersByMember,
};
