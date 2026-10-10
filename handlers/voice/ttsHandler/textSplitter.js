'use strict';

// ════════════════════════════════════════════════════════
//  句子分段工具
//  將長文字切割為短句，讓第一句能盡快合成並播放，
//  後續句子在播放時並行合成，大幅降低感知延遲。
// ════════════════════════════════════════════════════════

/**
 * 將文字按句子邊界分割，每段不超過 maxLen 字。
 * 分割優先順序：句號/問號/驚嘆號 > 逗號/分號 > 空白
 * @param {string} text
 * @param {number} maxLen 每段最大字數（預設 50）
 * @returns {string[]}
 */
function splitSentences(text, maxLen = 50) {
  if (!text || text.trim().length === 0) return [];

  // 先按主要句子邊界切割
  const primary = text
    .split(/(?<=[。！？!?\n])\s*/)
    .map(s => s.trim())
    .filter(Boolean);

  const result = [];

  for (const seg of primary) {
    if (seg.length <= maxLen) {
      result.push(seg);
      continue;
    }

    // 超長段落再按次要邊界切割
    const secondary = seg
      .split(/(?<=[，,；;、])\s*/)
      .map(s => s.trim())
      .filter(Boolean);

    let buf = '';
    for (const part of secondary) {
      if ((buf + part).length > maxLen && buf.length > 0) {
        result.push(buf);
        buf = part;
      } else {
        buf += part;
      }
    }
    if (buf) result.push(buf);
  }

  // 純標點段落（如「好耶！！！」切出的「！」）無法發音，edge-tts 會回 NoAudioReceived；
  // 併回前一段，沒有前一段就丟掉
  const merged = [];
  for (const s of result) {
    if (/[\p{L}\p{N}]/u.test(s)) merged.push(s);
    else if (merged.length > 0) merged[merged.length - 1] += s;
  }
  return merged;
}

module.exports = { splitSentences };
