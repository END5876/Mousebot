const { playTTS } = require('../ttsHandler');

// ════════════════════════════════════════════════════════
//  設定常數
// ════════════════════════════════════════════════════════
const MAX_IMAGE_SIZE_MB = 7;
const TTS_MAX_LENGTH = 1000;
const IMAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_MODE_CACHE_SIZE = 1000;
const HISTORY_CACHE_TTL_MS = 30 * 1000;
const RATE_LIMIT_WINDOW_MS = 10 * 1000;
const RATE_LIMIT_MAX_CALLS = 10;

// ════════════════════════════════════════════════════════
//  通用 TTLCache 類別 
// ════════════════════════════════════════════════════════
class TTLCache {
    constructor({ ttlMs, maxSize = Infinity, name = 'Cache' }) {
        this.ttlMs = ttlMs;
        this.maxSize = maxSize;
        this.name = name;
        this.store = new Map();
    }

    get(key) {
        const entry = this.store.get(key);
        if (!entry) return undefined;
        if (Date.now() - entry.cachedAt >= this.ttlMs) {
            this.store.delete(key);
            return undefined;
        }
        return entry.value;
    }

    set(key, value) {
        if (this.store.size >= this.maxSize) {
            this.store.delete(this.store.keys().next().value); // FIFO 淘汰
        }
        this.store.set(key, { value, cachedAt: Date.now() });
    }

    delete(key) { this.store.delete(key); }
    has(key) { return this.get(key) !== undefined; }

    purgeExpired() {
        const now = Date.now();
        let count = 0;
        for (const [key, entry] of this.store) {
            if (now - entry.cachedAt >= this.ttlMs) {
                this.store.delete(key);
                count++;
            }
        }
        if (count > 0) console.log(`[${this.name}] 已清除 ${count} 筆過期快取`);
    }
}

// ════════════════════════════════════════════════════════
//  快取與狀態管理
// ════════════════════════════════════════════════════════
const aiTTSEnabled = new Map();
const memoryClearedAt = new Map();
const userRateLimits = new Map();

const imageCache = new TTLCache({ ttlMs: IMAGE_CACHE_TTL_MS, name: 'ImageCache' });
const historyCache = new TTLCache({ ttlMs: HISTORY_CACHE_TTL_MS, name: 'HistoryCache' });
const botMessageCache = new TTLCache({ ttlMs: Infinity, maxSize: MAX_MODE_CACHE_SIZE, name: 'BotMsgCache' });

// 統一清理排程 
setInterval(() => {
    imageCache.purgeExpired();
    historyCache.purgeExpired();
}, Math.min(IMAGE_CACHE_TTL_MS, HISTORY_CACHE_TTL_MS));

// ════════════════════════════════════════════════════════
//  API 速率限制 
// ════════════════════════════════════════════════════════
function checkRateLimit(userId) {
    const now = Date.now();
    const record = userRateLimits.get(userId) ?? { count: 0, windowStart: now };
    if (now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
        userRateLimits.set(userId, { count: 1, windowStart: now });
        return true;
    }
    if (record.count >= RATE_LIMIT_MAX_CALLS) return false;
    record.count++;
    userRateLimits.set(userId, record);
    return true;
}

// ════════════════════════════════════════════════════════
//  記憶 / TTS 開關
// ════════════════════════════════════════════════════════
function isAITTSEnabled(guildId) { return aiTTSEnabled.get(guildId) ?? true; }
function setAITTSEnabled(guildId, value) { aiTTSEnabled.set(guildId, value); }

function clearUserMemory(userId) {
    memoryClearedAt.set(userId, Date.now());
    console.log(`[Memory] 已清除使用者 ${userId} 的對話記憶`);
}
function getMemoryClearTime(userId) { return memoryClearedAt.get(userId) ?? 0; }

// ════════════════════════════════════════════════════════
//  Bot 訊息上下文快取
// ════════════════════════════════════════════════════════
function recordBotMessageContext(messageId, mode, userId, userName) {
    if (!messageId || !mode) return;
    botMessageCache.set(messageId, { mode, userId, userName });
}
function getBotMessageContext(messageId) {
    return botMessageCache.get(messageId);
}

// ════════════════════════════════════════════════════════
//  共用圖片下載
// ════════════════════════════════════════════════════════
async function fetchAsBase64Cached(url, mimeType) {
    const cached = imageCache.get(url);
    if (cached) return { base64: cached.base64, mimeType: cached.mimeType };

    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    imageCache.set(url, { base64, mimeType });
    return { base64, mimeType };
}

// ════════════════════════════════════════════════════════
//  圖片/附件處理
// ════════════════════════════════════════════════════════
async function fetchImageAsBase64(attachment) {
    const sizeLimit = MAX_IMAGE_SIZE_MB * 1024 * 1024;
    if (attachment.size > sizeLimit) return null;

    const supportedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'image/gif'];
    const mimeType = attachment.contentType?.split(';')[0] || 'image/jpeg';
    if (!supportedTypes.includes(mimeType)) return null;

    try {
        const result = await fetchAsBase64Cached(attachment.url, mimeType);
        console.log(`[Image] 已載入：${attachment.url.slice(0, 60)}...`);
        return result;
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
async function fetchAndCacheEmoji(url, mimeType, name, id) {
    try {
        const result = await fetchAsBase64Cached(url, mimeType);
        console.log(`[Emoji] 已處理：${name} (${id})`);
        return { mimeType: result.mimeType, data: result.base64 };
    } catch (err) {
        console.warn(`[Emoji] 下載失敗 ${name}:`, err.message);
        return null;
    }
}

async function processCustomEmojis(content) {
    if (!content) return { cleanedText: '', emojiParts: [] };
    const emojiParts = [];
    const seen = new Set();
    const promises = [];

    const cleanedText = content.replace(/<(a?):(\w+):(\d+)>/g, (match, animated, name, id) => {
        if (!seen.has(id)) {
            seen.add(id);
            const ext = animated ? 'gif' : 'png';
            const url = `https://cdn.discordapp.com/emojis/${id}.${ext}`;
            const mimeType = animated ? 'image/gif' : 'image/png';
            promises.push(fetchAndCacheEmoji(url, mimeType, name, id));
        }
        return `[${name}表情]`;
    });

    const results = await Promise.all(promises);
    results.forEach(res => { if (res) emojiParts.push(res); });

    return { cleanedText, emojiParts };
}

// ════════════════════════════════════════════════════════
//  文字網址圖片處理
// ════════════════════════════════════════════════════════
async function processImageUrls(content) {
    if (!content) return { cleanedText: content ?? '', urlParts: [] };

    const urlParts = [];
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = content.match(urlRegex) || [];
    let cleanedText = content;

    for (const url of urls) {
        try {
            const cached = imageCache.get(url);
            if (cached) {
                urlParts.push({ mimeType: cached.mimeType, data: cached.base64 });
                cleanedText = cleanedText.replaceAll(url, '[圖片連結]'); 
                continue;
            }

            const response = await fetch(url);
            const contentType = response.headers.get('content-type') || '';
            const supportedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'image/gif'];

            if (supportedTypes.some(type => contentType.includes(type))) {
                const buffer = await response.arrayBuffer();
                // 在 buffer 後確認實際大小，防範 content-length 欺騙
                if (buffer.byteLength > MAX_IMAGE_SIZE_MB * 1024 * 1024) {
                    console.warn(`[Image URL] 圖片過大（實際 ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB），跳過：${url}`);
                    continue;
                }

                const base64 = Buffer.from(buffer).toString('base64');
                const exactMime = supportedTypes.find(t => contentType.includes(t)) || 'image/jpeg';

                imageCache.set(url, { base64, mimeType: exactMime });
                urlParts.push({ mimeType: exactMime, data: base64 });
                
                cleanedText = cleanedText.replaceAll(url, '[圖片連結]'); 
            }
        } catch (err) {
            console.warn(`[Image URL] 讀取網址失敗 ${url.slice(0, 30)}:`, err.message);
        }
    }
    return { cleanedText, urlParts };
}

// ════════════════════════════════════════════════════════
//  統一訊息內容前處理
// ════════════════════════════════════════════════════════
/**
 * 統一處理訊息中的 Emoji、網址圖片與附件
 */
async function processMessageContent(text, attachments = null) {
    const { cleanedText: textWithoutEmoji, emojiParts } = await processCustomEmojis(text);
    const [{ cleanedText, urlParts }, attachmentParts] = await Promise.all([
        processImageUrls(textWithoutEmoji),
        attachments && attachments.size > 0 ? processAttachments(attachments) : Promise.resolve([])
    ]);
    return {
        cleanedText,
        imageParts: [...emojiParts, ...urlParts, ...attachmentParts]
    };
}

// ════════════════════════════════════════════════════════
//  withTyping：持續顯示「正在輸入中」
// ════════════════════════════════════════════════════════
async function withTyping(channel, asyncFn) {
    // 僅觸發一次，Discord 預設會維持 10 秒或直到訊息發送
    channel.sendTyping().catch(() => {});
    
    // 直接執行並回傳 AI 處理結果
    return await asyncFn();
}

// ════════════════════════════════════════════════════════
//  TTS 播放
// ════════════════════════════════════════════════════════
// 改良 TTS 截斷邏輯，避免斷句不自然
function truncateForTTS(text, maxLength = TTS_MAX_LENGTH) {
    if (text.length <= maxLength) return text;
    const truncated = text.slice(0, maxLength);
    const lastBreak = Math.max(
        truncated.lastIndexOf('。'),
        truncated.lastIndexOf('？'),
        truncated.lastIndexOf('！'),
        truncated.lastIndexOf('\n'),
        truncated.lastIndexOf('.')
    );
    return lastBreak > maxLength * 0.7 ? truncated.slice(0, lastBreak + 1) : truncated;
}

async function speakWithTTS(source, text, guildId) {
    if (!guildId || !isAITTSEnabled(guildId)) return;
    const voiceChannel = source.member?.voice?.channel;
    if (!voiceChannel) return;
    
    const ttsText = truncateForTTS(text);
    try {
        const result = await playTTS(guildId, ttsText);
        if (!result.success) console.warn(`⚠️ [TTS] 朗讀失敗 (reason: ${result.reason})`);
    } catch (err) {
        console.error('❌ [TTS] 呼叫 playTTS 發生錯誤:', err.message);
    }
}

// ════════════════════════════════════════════════════════
//  訊息分割
// ════════════════════════════════════════════════════════
// 修正切斷 Markdown 導致渲染破壞的問題
function splitMessage(text, maxLength = 1900) {
    if (text.length <= maxLength) return [text];
    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
        let chunk = remaining.slice(0, maxLength);
        const lastNewLine = chunk.lastIndexOf('\n');
        const cutAt = lastNewLine > maxLength * 0.8 ? lastNewLine : maxLength;
        chunk = remaining.slice(0, cutAt);
        remaining = remaining.slice(cutAt + (lastNewLine > maxLength * 0.8 ? 1 : 0));

        // 計算此 chunk 中是否有未閉合的程式碼區塊
        const codeBlockMatches = chunk.match(/```(\w*)/g) || [];
        if (codeBlockMatches.length % 2 !== 0) {
            chunk += '\n```';          // 強制關閉
            remaining = '```\n' + remaining;  // 下一段補開頭
        }
        chunks.push(chunk);
    }
    return chunks;
}

module.exports = {
    historyCache, checkRateLimit,
    clearUserMemory, getMemoryClearTime,
    isAITTSEnabled, setAITTSEnabled,
    recordBotMessageContext, getBotMessageContext,
    processMessageContent,
    withTyping, speakWithTTS, splitMessage,
};
