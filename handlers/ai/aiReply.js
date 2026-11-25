// handlers/ai/aiReply.js（MouseBot 與 mousebot-lite 共用，兩邊內容相同）
// 送出 AI 回覆的共用工具：表情包、額度與空回覆提示。

const { buildPayloads, memeTagOfContent } = require('./memeStore');
const { EMPTY_RESPONSE_MESSAGE } = require('./aiCore');
const { recordBotMessageContext } = require('./aiUtils');
const { quotaMessage } = require('./aiQuota');
const logger = require('../../utils/logger');

const MISSING_SIGNATURE_HINT = '[系統提示：使用者傳送的 Discord 圖片網址缺少了安全簽名參數(?ex=...&is=...)，導致權限不足無法讀取。請告訴使用者連結後面的參數不見了，請他重新上傳圖片或貼完整的連結。]';

// 被 AI 額度擋下時回覆一則提示，數秒後自動刪除，避免連續觸發時洗版
const QUOTA_NOTICE_TTL_MS = 10 * 1000;
async function replyQuotaNotice(message, error) {
    const sent = await message.reply({ content: quotaMessage(error), allowedMentions: { repliedUser: false } }).catch(() => null);
    if (sent) setTimeout(() => sent.delete().catch(() => {}), QUOTA_NOTICE_TTL_MS).unref?.();
}

// 模型沒有產生文字時至少回一句，不要讓使用者 @ 了卻毫無反應
async function replyEmptyNotice(message) {
    await message.reply({ content: EMPTY_RESPONSE_MESSAGE, allowedMentions: { repliedUser: false } }).catch(() => {});
}

// 「顯示名稱 (@username)」：與群組歷史的發言者標籤一致
function labelOf(member, user) {
    return `${member?.displayName ?? user.globalName ?? user.username} (@${user.username})`;
}

// ════════════════════════════════════════════════════════
//  送出回覆（含表情包）
// ════════════════════════════════════════════════════════
/**
 * 送出一則；帶表情包附件失敗（沒有「附加檔案」權限、檔案太大…）時改送純文字，不讓圖片拖垮整則回覆。
 * 只有圖（附件或表情包網址）、沒有文字的那則失敗就放棄（回傳 null）。
 */
async function sendWithMemeFallback(send, payload) {
    try {
        return await send(payload);
    } catch (err) {
        if (!payload.files && memeTagOfContent(payload.content) === undefined) throw err;
        logger.warn('Meme', `表情包送出失敗（${err.code ?? ''} ${err.message}），改送純文字`);
        if (!payload.files || !payload.content) return null;
        return send({ content: payload.content });
    }
}

/** 把回覆（文字塊＋表情包）送到訊息所在的頻道，每則都記進 AI 回覆紀錄 */
async function sendChunks(message, { chunks, files }, { mode, scope }) {
    const logExtra = { kind: scope.kind, scopeKey: scope.scopeKey };
    for (const payload of buildPayloads(chunks, files)) {
        const sentMsg = await sendWithMemeFallback(p => message.channel.send(p), payload);
        if (sentMsg) recordBotMessageContext(sentMsg.id, mode, message.author.id, message.author.username, logExtra);
    }
}

module.exports = {
  MISSING_SIGNATURE_HINT,
  labelOf,
  sendWithMemeFallback,
  replyQuotaNotice,
  replyEmptyNotice,
  sendChunks,
};
