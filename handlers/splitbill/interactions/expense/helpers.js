'use strict';

// handlers/splitbill/interactions/expense/helpers.js
// 職責：小型純函式工具，供 buttons.js / ledger.js / modals.js / selects.js 共用

const { memberDisplay } = require('../../utils/tripHelper');
const { round2 } = require('../../utils/calculator');

function parseLedgerSuffix(suffix) {
  const [pagePart, sourcePart] = suffix.split('__');
  const source = sourcePart === 'set' ? 'set' : 'exp';
  const page = pagePart === 'last' ? Infinity : (parseInt(pagePart, 10) || 0);
  return { page, source };
}

function getBackNavConfig(source) {
  if (source === 'set') {
    return { customId: 'set_nav', label: '⬅️ 返回結算與淨額中心' };
  }
  return { customId: 'exp_nav', label: '🔙 返回記帳管理' };
}

function formatAmountConversion(amount, currency, amountInBase, baseCurrency) {
  const amountText = `${round2(amount)} ${currency}`;
  if (currency === baseCurrency) return amountText;
  return `${amountText} ➔ ${round2(amountInBase)} ${baseCurrency}`;
}

function formatParticipantsList(trip, participants, currency) {
  if (!participants || !participants.length) return '無';

  const amounts = participants.map(p => round2(p.amount));
  const isEqualSplit = amounts.every(a => Math.abs(a - amounts[0]) < 0.01);

  if (isEqualSplit) {
    const names = participants.map(p => memberDisplay(trip, p.userId)).join('、');
    return `${participants.length}人平分，每人 ${amounts[0]} ${currency}\n> 　${names}`;
  }

  return participants
    .map(p => `　• ${memberDisplay(trip, p.userId)}：${round2(p.amount)} ${currency}`)
    .join('\n> ');
}

module.exports = {
  parseLedgerSuffix,
  getBackNavConfig,
  formatAmountConversion,
  formatParticipantsList,
};
