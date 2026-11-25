// handlers/ai/aiMessages.js（MouseBot 與 mousebot-lite 共用，兩邊內容相同）
// 訊息處理：@ 提及、隨機插話。

const { getUserMode, getGeminiResponse, getShortResponse, isEmptyResponseError } = require('./aiCore');
const {
  processAttachments, processCustomEmojis, processImageUrls, processEmbeds, withTyping, replaceMentions,
} = require('./aiUtils');
const { getReplyChance, shouldRandomReply, isChannelDisabled } = require('./aiChance');
const features = require('../../utils/features');
const profile = require('../../profile');
const { isQuotaError } = require('./aiQuota');
const logger = require('../../utils/logger');
const { MISSING_SIGNATURE_HINT, replyQuotaNotice, replyEmptyNotice, sendChunks } = require('./aiReply');

// AI 回覆朗讀（handlers/ai/aiTTS）；TTS 模組停用時是 null
const aiTts = () => features.get('aiTts');
// AI 工具的 context；aiTools 停用時是 null（不帶工具）
const toolContextFrom = (...a) => features.get('aiTools')?.contextFrom(...a) ?? null;

// 這些前綴開頭的訊息不觸發隨機回覆（profile.randomReplySkipPrefixes；空陣列＝不過濾）
const SKIP_PREFIX_RE = profile.randomReplySkipPrefixes.length
    ? new RegExp(`^!(${profile.randomReplySkipPrefixes.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`)
    : null;

// ════════════════════════════════════════════════════════
//  訊息處理：@ 提及、隨機插話
// ════════════════════════════════════════════════════════
async function handleMention(message, client, { rawQuestion, hasAttachment, hasLikelyImageLink, scope }) {
    const userId = message.author.id;
    const botId  = client.user.id;
    const mode   = getUserMode(userId, scope);
    const base   = { userId, channel: message.channel, messageId: message.id, botId, message, mode, scope };
    const isEmptyContent = !rawQuestion && !hasAttachment && !hasLikelyImageLink;

    try {
        let result;
        if (isEmptyContent) {
            // 只 @ 沒打字：一律把 message 傳進去。有引用時由 buildMessagePartsWithReference 補上引用內容與提示
            // （使用者真正的意圖是要 Bot 對被引用的內容做反應，不能當成打招呼，否則引用的文字或圖片會整個消失）；
            // 沒引用就是純打招呼，buildMessagePartsWithReference 會標成「只 @ 了你，沒有說任何話」
            result = await withTyping(message.channel, () => getGeminiResponse({ ...base, prompt: '' }));
        } else {
            // 「正在輸入中」涵蓋圖片下載/壓縮階段，使用者不用乾等
            result = await withTyping(message.channel, async () => {
                // emoji → 網址圖片、embed、附件三者彼此獨立，並行處理
                const [{ question, emojiParts, urlImagePartsRaw }, embedParts, attachmentParts] = await Promise.all([
                    processCustomEmojis(rawQuestion).then(async ({ cleanedText, emojiParts }) => ({
                        question: cleanedText,
                        emojiParts,
                        // 傳入 client，讓 processImageUrls 內部可嘗試修復缺簽名網址
                        urlImagePartsRaw: await processImageUrls(cleanedText, client, { guildId: message.guildId, userId }),
                    })),
                    processEmbeds(message.embeds),
                    processAttachments(message.attachments),
                ]);

                // 缺簽名的網址：embed 預覽讀得到就不用提示
                const urlImageParts = urlImagePartsRaw.flatMap(part => {
                    if (part.type !== 'missing_signature') return [part];
                    return embedParts.length > 0 ? [] : [{ type: 'text', text: MISSING_SIGNATURE_HINT }];
                });

                const toolCtx = toolContextFrom('text', {
                    guild: message.guild, member: message.member, channel: message.channel, userId,
                });
                return getGeminiResponse({
                    ...base, prompt: question,
                    imageParts: [...emojiParts, ...urlImageParts, ...embedParts, ...attachmentParts],
                    toolCtx,
                });
            });
        }
        await sendChunks(message, result, { mode, scope });
        if (!result.skipTTS) await aiTts()?.speakWithTTS(message, result.text, message.guild?.id);
    } catch (error) {
        if (isQuotaError(error)) await replyQuotaNotice(message, error);
        else if (isEmptyResponseError(error)) await replyEmptyNotice(message);
        else logger.error('AI', `@ 回覆錯誤：${error.message}`);
    }
}

async function handleRandomReply(message, client, { hasAttachment, hasReference, scope }) {
    const botId = client.user.id;

    // 回覆別人的訊息不插話
    if (hasReference) {
        let isReplyingToOther = false;
        if (message.mentions.repliedUser) {
            isReplyingToOther = message.mentions.repliedUser.id !== botId;
        } else {
            const refMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
            if (refMsg && refMsg.author.id !== botId) isReplyingToOther = true;
        }
        if (isReplyingToOther) return;
    }

    if (isChannelDisabled(message.channel.id)) return;

    // 已觸發自訂匹配回應（/response）的訊息，不再隨機回覆（/response 模組停用或不存在時沒有自訂回應）
    if (features.get('responses')?.hasCustomResponse(message.content) ?? false) return;

    // 將提及轉換為名字
    const rawCleaned = replaceMentions(message, botId);
    if (!rawCleaned && !hasAttachment) return;

    // 只要訊息含有任何連結（包含圖片連結），隨機回覆一律不回應
    if (/(https?:\/\/[^\s)\]>]+)|(www\.[^\s)\]>]+)/i.test(rawCleaned)) return;

    if (SKIP_PREFIX_RE?.test(rawCleaned)) return;

    if (!shouldRandomReply(message.id, getReplyChance(message.guild?.id))) return;

    try {
        let mode;
        const shortReply = await withTyping(message.channel, async () => {
            const [{ cleanedText, emojiParts }, attachmentParts] = await Promise.all([
                processCustomEmojis(rawCleaned),
                processAttachments(message.attachments),
            ]);
            mode = getUserMode(message.author.id, scope);
            return getShortResponse({
                userId: message.author.id, prompt: cleanedText, imageParts: [...emojiParts, ...attachmentParts],
                channel: message.channel, messageId: message.id, botId, message, mode, scope,
            });
        });
        if (shortReply) {
            await sendChunks(message, shortReply, { mode, scope });
            await aiTts()?.speakWithTTS(message, shortReply.text, message.guild?.id);
        }
    } catch (error) {
        logger.error('AI', `隨機回覆錯誤：${error.message}`);
    }
}

module.exports = {
  handleMention,
  handleRandomReply,
};
