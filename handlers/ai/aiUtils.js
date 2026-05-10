const { playTTS } = require('../ttsHandler');

// ════════════════════════════════════════════════════════
//  設定常數
// ════════════════════════════════════════════════════════
const MAX_IMAGE_SIZE_MB = 7;
const TTS_MAX_LENGTH = 1000;
const IMAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_MODE_CACHE_SIZE = 1000;
const HISTORY_CACHE_TTL_MS = 30 * 1000;

// ════════════════════════════════════════════════════════
//  快取
// ════════════════════════════════════════════════════════
const aiTTSEnabled = new Map();
const memoryClearedAt = new Map();
const imageCache = new Map();
const botMessageCache = new Map();
const historyCache = new Map();

// ════════════════════════════════════════════════════════
//  記憶 / TTS 開關
// ════════════════════════════════════════════════════════
function isAITTSEnabled(guildId) {
    return aiTTSEnabled.get(guildId) ?? true;
}

function setAITTSEnabled(guildId, value) {
    aiTTSEnabled.set(guildId, value);
}

function clearUserMemory(userId) {
    memoryClearedAt.set(userId, Date.now());
    console.log(`[Memory] 已清除使用者 ${userId} 的對話記憶`);
}

function getMemoryClearTime(userId) {
    return memoryClearedAt.get(userId) ?? 0;
}

// ════════════════════════════════════════════════════════
//  Bot 訊息上下文快取
// ════════════════════════════════════════════════════════
function recordBotMessageContext(messageId, mode, userId, userName) {
    if (!messageId || !mode) return;
    if (botMessageCache.size >= MAX_MODE_CACHE_SIZE) {
        const firstKey = botMessageCache.keys().next().value;
        botMessageCache.delete(firstKey);
    }
    botMessageCache.set(messageId, { mode, userId, userName });
}

function getBotMessageContext(messageId) {
    return botMessageCache.get(messageId);
}

// ════════════════════════════════════════════════════════
//  圖片處理
// ════════════════════════════════════════════════════════
async function fetchImageAsBase64(attachment) {
    const sizeLimit = MAX_IMAGE_SIZE_MB * 1024 * 1024;
    if (attachment.size > sizeLimit) return null;

    const supportedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'image/gif'];
    const mimeType = attachment.contentType?.split(';')[0] || 'image/jpeg';
    if (!supportedTypes.includes(mimeType)) return null;

    const cached = imageCache.get(attachment.url);
    if (cached && (Date.now() - cached.cachedAt) < IMAGE_CACHE_TTL_MS) {
        console.log(`[Image] 快取命中：${attachment.url.slice(0, 60)}...`);
        return { base64: cached.base64, mimeType: cached.mimeType };
    }

    try {
        const response = await fetch(attachment.url);
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        imageCache.set(attachment.url, { base64, mimeType, cachedAt: Date.now() });
        console.log(`[Image] 已下載並快取：${attachment.url.slice(0, 60)}...`);
        return { base64, mimeType };
    } catch (err) {
        console.error(`[Image] 下載圖片失敗：`, err.message);
        return null;
    }
}

async function processAttachments(attachments) {
    const imageParts = [];
    if (!attachments || attachments.size === 0) return imageParts;
    for (const [, attachment] of attachments) {
        const imgData = await fetchImageAsBase64(attachment);
        if (imgData) imageParts.push({ mimeType: imgData.mimeType, data: imgData.base64 });
    }
    return imageParts;
}

// ════════════════════════════════════════════════════════
//  自訂 Emoji 處理
// ════════════════════════════════════════════════════════

/**
 * 從訊息內容中提取所有自訂 Emoji，下載為 base64 圖片
 * 同時將 <:name:id> / <a:name:id> 替換為 [name表情] 方便 Gemini 理解
 * @param {string} content - 訊息內容
 * @returns {{ cleanedText: string, emojiParts: Array<{ mimeType: string, data: string }> }}
 */
async function processCustomEmojis(content) {
    if (!content) return { cleanedText: content ?? '', emojiParts: [] };

    const emojiParts = [];
    const emojiRegex = /<(a?):(\w+):(\d+)>/g;
    let match;
    const seen = new Set();

    while ((match = emojiRegex.exec(content)) !== null) {
        const [, animated, name, id] = match;
        if (seen.has(id)) continue;
        seen.add(id);

        const ext = animated ? 'gif' : 'png';
        const url = `https://cdn.discordapp.com/emojis/${id}.${ext}`;
        const mimeType = animated ? 'image/gif' : 'image/png';

        try {
            const cached = imageCache.get(url);
            if (cached && (Date.now() - cached.cachedAt) < IMAGE_CACHE_TTL_MS) {
                console.log(`[Emoji] 快取命中：${name}`);
                emojiParts.push({ mimeType: cached.mimeType, data: cached.base64 });
            } else {
                const response = await fetch(url);
                const buffer = await response.arrayBuffer();
                const base64 = Buffer.from(buffer).toString('base64');
                imageCache.set(url, { base64, mimeType, cachedAt: Date.now() });
                console.log(`[Emoji] 已下載：${name} (${id})`);
                emojiParts.push({ mimeType, data: base64 });
            }
        } catch (err) {
            console.warn(`[Emoji] 下載失敗 ${name}:`, err.message);
        }
    }

    // 把 <:name:id> / <a:name:id> 替換成 [name表情]，讓文字部分也有語意提示
    const cleanedText = content.replace(/<a?:(\w+):\d+>/g, '[$1表情]');

    return { cleanedText, emojiParts };
}

// ════════════════════════════════════════════════════════
//  定期清除過期快取
// ════════════════════════════════════════════════════════
setInterval(() => {
    const now = Date.now();
    let cleared = 0;
    for (const [url, entry] of imageCache.entries()) {
        if (now - entry.cachedAt >= IMAGE_CACHE_TTL_MS) { imageCache.delete(url); cleared++; }
    }
    if (cleared > 0) console.log(`[Image Cache] 已清除 ${cleared} 筆過期快取`);
}, IMAGE_CACHE_TTL_MS);

setInterval(() => {
    const now = Date.now();
    let cleared = 0;
    for (const [channelId, entry] of historyCache.entries()) {
        if (now - entry.cachedAt >= HISTORY_CACHE_TTL_MS) { historyCache.delete(channelId); cleared++; }
    }
    if (cleared > 0) console.log(`[History Cache] 已清除 ${cleared} 個過期頻道快取`);
}, HISTORY_CACHE_TTL_MS);

// ════════════════════════════════════════════════════════
//  withTyping：持續顯示「正在輸入中」直到 asyncFn 結束
//  asyncFn 完成後立即中斷 sleep
// ════════════════════════════════════════════════════════
async function withTyping(channel, asyncFn) {
    let stop = false;
    let wakeUp = null;

    const typingLoop = async () => {
        while (!stop) {
            await channel.sendTyping().catch(() => {});
            // 可被提前喚醒的 sleep
            await new Promise(res => {
                wakeUp = res;
                setTimeout(res, 8000);
            });
        }
    };

    const loopPromise = typingLoop();

    try {
        return await asyncFn();
    } finally {
        stop = true;
        wakeUp?.();          // 立刻喚醒 sleep，不再等剩餘的 8 秒
        await loopPromise.catch(() => {});
    }
}

// ════════════════════════════════════════════════════════
//  TTS 播放
// ════════════════════════════════════════════════════════
async function speakWithTTS(source, text, guildId) {
    if (!guildId || !isAITTSEnabled(guildId)) return;
    const voiceChannel = source.member?.voice?.channel;
    if (!voiceChannel) {
        console.log(`\U0001F507 [TTS] 使用者不在語音頻道，跳過朗讀`);
        return;
    }
    const ttsText = text.length > TTS_MAX_LENGTH ? text.slice(0, TTS_MAX_LENGTH) : text;
    try {
        const result = await playTTS(guildId, ttsText);
        if (!result.success) {
            console.warn(`⚠️ [TTS] 朗讀失敗 (reason: ${result.reason})`);
        } else {
            console.log(`\U0001F50A [TTS] 朗讀中 (engine: ${result.engine}, queued: ${result.queued})`);
        }
    } catch (err) {
        console.error('❌ [TTS] 呼叫 playTTS 發生錯誤:', err.message);
    }
}

// ════════════════════════════════════════════════════════
//  訊息分割
// ════════════════════════════════════════════════════════
function splitMessage(text, maxLength = 1900) {
    if (text.length <= maxLength) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        let chunk = remaining.slice(0, maxLength);
        const lastNewLine = chunk.lastIndexOf('\n');
        if (lastNewLine > maxLength * 0.8) {
            chunk = remaining.slice(0, lastNewLine);
            remaining = remaining.slice(lastNewLine + 1);
        } else {
            remaining = remaining.slice(maxLength);
        }
        chunks.push(chunk);
    }
    return chunks;
}

module.exports = {
    // 快取存取
    historyCache, HISTORY_CACHE_TTL_MS,
    // 記憶
    clearUserMemory, getMemoryClearTime,
    // TTS 開關
    isAITTSEnabled, setAITTSEnabled,
    // Bot 訊息上下文
    recordBotMessageContext, getBotMessageContext,
    // 圖片
    processAttachments,
    // 自訂 Emoji
    processCustomEmojis,
    // 工具
    withTyping, speakWithTTS, splitMessage,
};
