'use strict';

// 從文字中擷取所有 <@id> 或 <@!id> 格式的 Discord 提及，回傳去重後的 userId 陣列
function extractMentionIds(text) {
  const ids = [];
  const regex = /<@!?(\d+)>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

/**
 * 解析 "<@id1>=100,<@id2>=200" 這種金額配對字串
 * 也支援用空白分隔： "<@id1>=100 <@id2>=200"
 * @returns {Array<{userId:string, amount:number}>}
 */
function parseAmountPairs(text) {
  const pairs = [];
  const regex = /<@!?(\d+)>\s*=\s*(-?\d+(?:\.\d+)?)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    pairs.push({ userId: match[1], amount: parseFloat(match[2]) });
  }
  return pairs;
}

/**
 * 解析 payer 欄位：
 *  - 單一 payer："<@id>"（視為全額代墊）
 *  - 多人 payer："<@id1>=600,<@id2>=400"
 * @returns {Array<{userId:string, amount:number}> | {single:string}}
 */
function parsePayerField(text, totalAmount) {
  const trimmed = text.trim();
  if (trimmed.includes('=')) {
    const pairs = parseAmountPairs(trimmed);
    if (!pairs.length) throw new Error('付款人格式錯誤，範例：<@id1>=600,<@id2>=400');
    return pairs;
  }
  const ids = extractMentionIds(trimmed);
  if (ids.length !== 1) {
    throw new Error('單一代墊者請直接 @提及一位成員；多人代墊請用 <@id1>=金額,<@id2>=金額 格式');
  }
  return [{ userId: ids[0], amount: totalAmount }];
}

/**
 * 解析 split 欄位：
 *  - "equal"：全體成員平分
 *  - "equal:<@id1>,<@id2>"：指定成員平分
 *  - "<@id1>=300,<@id2>=700"：自訂金額
 * @returns {{ mode: 'equal'|'custom', ids: string[], customShares?: Array<{userId, amount}> }}
 */
function parseSplitField(text, allMemberIds) {
  const trimmed = (text || 'equal').trim();

  if (/^equal$/i.test(trimmed)) {
    return { mode: 'equal', ids: allMemberIds };
  }
  if (/^equal\s*:/i.test(trimmed)) {
    const ids = extractMentionIds(trimmed);
    if (!ids.length) throw new Error('equal: 後面請至少 @提及一位成員');
    return { mode: 'equal', ids };
  }
  if (trimmed.includes('=')) {
    const pairs = parseAmountPairs(trimmed);
    if (!pairs.length) throw new Error('自訂分攤格式錯誤，範例：<@id1>=300,<@id2>=700');
    return { mode: 'custom', ids: pairs.map((p) => p.userId), customShares: pairs };
  }
  throw new Error('split 欄位格式錯誤，可用："equal"、"equal:<@id1>,<@id2>"、或 "<@id1>=300,<@id2>=700"');
}

module.exports = { extractMentionIds, parseAmountPairs, parsePayerField, parseSplitField };
