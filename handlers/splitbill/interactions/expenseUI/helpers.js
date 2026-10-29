'use strict';

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

// 🔒 新增花費的每一份草稿各自一格快取（跟帳單掃描每張卡的 scanItemCacheUserId 同一招）。
// 以前整條流程共用 guildId:userId 那一格，同時開著兩張掃描卡時，後送出表單的會蓋掉前一份，
// 回到前一張卡按分攤就會把別張的資料（甚至還沒選代墊人的半成品）存進行程。
// 草稿 ID 帶在流程每一步的 customId 尾端：`<baseId>:<draftId>`。
function expenseDraftCacheUserId(userId, draftId) {
  return `${userId}:expdraft:${draftId}`;
}

function withDraftId(baseId, draftId) {
  return `${baseId}:${draftId}`;
}

function parseDraftCustomId(customId) {
  const idx = customId.indexOf(':');
  if (idx === -1) return { baseId: customId, draftId: '' };
  return { baseId: customId.slice(0, idx), draftId: customId.slice(idx + 1) };
}

module.exports = {
  expenseDraftCacheUserId,
  withDraftId,
  parseDraftCustomId,
  parseLedgerSuffix,
  getBackNavConfig,
  formatAmountConversion,
  formatParticipantsList
};
