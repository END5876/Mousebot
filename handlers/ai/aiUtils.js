const { playTTS } = require('../voice/ttsHandler');
const sharp = require('sharp'); // 引入 sharp 進行圖片壓縮

// ════════════════════════════════════════════════════════
//  設定常數
// ════════════════════════════════════════════════════════
const MAX_IMAGE_SIZE_MB = 30;
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
//  Discord CDN 圖片網址修復機制 (新增)
//  策略：① 優先重新 Fetch 訊息（免額外認證，成本低）
//        ② 失敗才 Fallback 呼叫官方 refresh-urls API
// ════════════════════════════════════════════════════════
const ATTACHMENT_PATH_PATTERN = /cdn\.discordapp\.com\/attachments\/(\d+)\/(\d+)\/([^\s?<>"']+)/i;

/**
 * 策略一：重新 Fetch 該訊息，從 message.attachments / embeds 取得新鮮網址
 * 原理：channel_id / message_id 寫在路徑上，不受簽名過期影響，
 *       重新 fetch 訊息時 discord.js 回傳的網址保證是當下有效的。
 */
async function fetchFreshUrlFromMessage(url, client) {
    if (!client) return null;
    const match = url.match(ATTACHMENT_PATH_PATTERN);
    if (!match) return null;

    const [, channelId, messageId, filename] = match;

    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.messages) return null;

        const message = await channel.messages.fetch(messageId);
        if (!message) return null;

        const attachment = message.attachments.find(
            a => a.name === filename || a.url.includes(filename)
        );
        if (attachment) return attachment.proxyURL ?? attachment.url;

        // 附件被撤下但仍留有 Embed 縮圖時，退一步找 Embed
        for (const embed of message.embeds) {
            if (embed.image?.url?.includes(filename)) return embed.image.proxyURL ?? embed.image.url;
            if (embed.thumbnail?.url?.includes(filename)) return embed.thumbnail.proxyURL ?? embed.thumbnail.url;
        }

        return null;
    } catch (err) {
        // 常見原因：頻道已刪除 / Bot 無權限 / 訊息已被刪除
        console.warn(`[resolveDiscordImageUrl] Fetch 訊息失敗 (msg:${messageId}):`, err.message);
        return null;
    }
}

/**
 * 策略二（Fallback）：呼叫官方 refresh-urls API
 * 已知限制：
 *   1. 必須帶有效的 User-Agent，否則請求可能被拒
 *   2. ephemeral-attachments 路徑無效（本函式的正規表達式已排除此路徑）
 *   3. 呼叫前必須先移除舊的 ?ex=&is=&hm= 參數
 * 需求：process.env.DISCORD_TOKEN 必須是目前登入的 Bot Token
 *       （若你的專案用不同變數名稱儲存 Token，請自行修改此處）
 */
async function refreshUrlViaAPI(url) {
    if (!process.env.DISCORD_TOKEN) {
        console.warn('[refreshUrlViaAPI] 未設定 DISCORD_TOKEN，無法呼叫官方 API');
        return null;
    }

    const cleanUrl = url.split('?')[0]; // 移除舊簽名參數，只留路徑本體

    try {
        const res = await fetch('https://discord.com/api/v10/attachments/refresh-urls', {
            method: 'POST',
            headers: {
                'Authorization': `Bot ${process.env.DISCORD_TOKEN}`,
                'Content-Type': 'application/json',
                'User-Agent': 'DiscordBot (https://github.com/discordjs/discord.js, 14.x)',
            },
            body: JSON.stringify({ attachment_urls: [cleanUrl] }),
        });

        if (!res.ok) {
            console.warn(`[refreshUrlViaAPI] API 回應失敗: HTTP ${res.status}`);
            return null;
        }

        const data = await res.json();
        const refreshed = data?.refreshed_urls?.[0]?.refreshed;
        return refreshed || null;
    } catch (err) {
        console.warn('[refreshUrlViaAPI] 呼叫失敗:', err.message);
        return null;
    }
}

/**
 * 主函式：綜合兩種策略，回傳一個「盡最大努力保證可用」的新鮮網址
 * @param {string} url - 原始（缺簽名）的 Discord 圖片網址
 * @param {import('discord.js').Client} client - discord.js Client 實例
 * @returns {Promise<string|null>} 成功回傳新鮮網址，全部失敗回傳 null
 */
async function resolveDiscordImageUrl(url, client) {
    const freshFromMessage = await fetchFreshUrlFromMessage(url, client);
    if (freshFromMessage) {
        console.log('[resolveDiscordImageUrl] ✅ 透過重新 Fetch 訊息取得新鮮網址');
        return freshFromMessage;
    }

    console.log('[resolveDiscordImageUrl] ⚠️ Fetch 訊息失敗，改用 refresh-urls API 嘗試補救');
    const freshFromAPI = await refreshUrlViaAPI(url);
    if (freshFromAPI) {
        console.log('[resolveDiscordImageUrl] ✅ 透過 refresh-urls API 取得新鮮網址');
        return freshFromAPI;
    }

    console.warn('[resolveDiscordImageUrl] ❌ 兩種策略皆失敗，該圖片確實無法存取');
    return null;
}

// ════════════════════════════════════════════════════════
//  圖片處理 (支援網址解析與靜態圖/GIF 壓縮邏輯)
// ════════════════════════════════════════════════════════
async function fetchImageUrlAsBase64(url) {
    const cached = imageCache.get(url);
    if (cached && (Date.now() - cached.cachedAt) < IMAGE_CACHE_TTL_MS) {
        console.log(`[Image] 快取命中：${url.slice(0, 60)}...`);
        return { base64: cached.base64, mimeType: cached.mimeType };
    }

    try {
        const response = await fetch(url);
        if (!response.ok) return null;

        const contentType = response.headers.get('content-type') || '';
        const supportedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'image/gif'];
        const originalMimeType = contentType.split(';')[0] || 'image/jpeg';

        if (!supportedTypes.includes(originalMimeType)) return null;

        const arrayBuffer = await response.arrayBuffer();
        const sizeLimit = MAX_IMAGE_SIZE_MB * 1024 * 1024;
        if (arrayBuffer.byteLength > sizeLimit) return null;

        let buffer = Buffer.from(arrayBuffer);
        let finalMimeType = originalMimeType;

        if (originalMimeType === 'image/gif') {
            buffer = await sharp(buffer, { animated: true })
                .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
                .gif()
                .toBuffer();
            finalMimeType = 'image/gif';
        } else {
            buffer = await sharp(buffer)
                .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 80 })
                .toBuffer();
            finalMimeType = 'image/webp';
        }

        const base64 = buffer.toString('base64');
        imageCache.set(url, { base64, mimeType: finalMimeType, cachedAt: Date.now() });
        console.log(`[Image] 已下載並壓縮快取：${url.slice(0, 60)}...`);
        return { base64, mimeType: finalMimeType };
    } catch (err) {
        console.error(`[Image] 下載或壓縮圖片失敗：`, err.message);
        return null;
    }
}

async function fetchImageAsBase64(attachment) {
    const sizeLimit = MAX_IMAGE_SIZE_MB * 1024 * 1024;
    if (attachment.size && attachment.size > sizeLimit) return null;

    const supportedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'image/gif'];
    const originalMimeType = attachment.contentType?.split(';')[0] || 'image/jpeg';
    if (originalMimeType && !supportedTypes.includes(originalMimeType)) return null;

    // 優先使用 proxyURL（不需要安全簽名），fallback 才用 url
    const fetchUrl = attachment.proxyURL ?? attachment.proxyUrl ?? attachment.url;
    return await fetchImageUrlAsBase64(fetchUrl);
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

// 檢查是否包含缺少簽名的 Discord 網址
function hasMissingSignature(content) {
    if (!content) return false;
    const urlRegex = /(https?:\/\/[^\s)\]>]+)/g;
    const urls = content.match(urlRegex) || [];
    for (const url of urls) {
        if (url.includes('cdn.discordapp.com/attachments/')) {
            const hasSig = url.includes('?ex=') && url.includes('&is=') && url.includes('&hm=');
            if (!hasSig) return true;
        }
    }
    return false;
}

// 處理 Discord Embeds (預覽圖)
async function processEmbeds(embeds) {
    const imageParts = [];
    if (!embeds || embeds.length === 0) return imageParts;

    for (const embed of embeds) {
        const imageUrl = embed.image?.proxyURL || embed.image?.url || embed.thumbnail?.proxyURL || embed.thumbnail?.url;
        if (imageUrl) {
            const imgData = await fetchImageUrlAsBase64(imageUrl);
            if (imgData) {
                imageParts.push({ type: 'image', mimeType: imgData.mimeType, data: imgData.base64 });
            }
        }
    }
    return imageParts;
}

/**
 * @param {string} content - 訊息文字內容
 * @param {import('discord.js').Client} [client] - (選填) discord.js Client 實例
 *        若有傳入，遇到缺簽名的 Discord 網址時會先嘗試自動修復，
 *        修復成功則正常回傳圖片資料；修復失敗才回傳 missing_signature。
 *        若不傳入 client，行為與修改前完全一致（向後相容）。
 */
async function processImageUrls(content, client) {
    if (!content) return [];

    const urlRegex = /(https?:\/\/[^\s)\]>]+)/g;
    const urls = content.match(urlRegex) || [];
    const imageParts = [];
    const seen = new Set();

    for (const url of urls) {
        if (seen.has(url)) continue;
        seen.add(url);

        const isDiscordCDN = url.includes('cdn.discordapp.com/attachments/');
        const hasSignature = url.includes('?ex=') && url.includes('&is=') && url.includes('&hm=');

        const isLikelyImage = /\.(png|jpg|jpeg|webp|heic|heif|gif)(?:\?.*)?$/i.test(url)
            || isDiscordCDN;

        if (isLikelyImage) {
            // 缺簽名的 Discord CDN 網址：先嘗試修復，別急著判死刑
            if (isDiscordCDN && !hasSignature) {
                const freshUrl = await resolveDiscordImageUrl(url, client);

                if (freshUrl) {
                    // ✅ 修復成功，當作正常圖片繼續處理
                    const imgData = await fetchImageUrlAsBase64(freshUrl);
                    if (imgData) {
                        imageParts.push({ type: 'image', mimeType: imgData.mimeType, data: imgData.base64 });
                        continue;
                    }
                }

                // 兩種策略皆失敗（或未傳入 client），才真的標記為缺簽名交給外部處理
                imageParts.push({ type: 'missing_signature', url });
                continue;
            }

            const imgData = await fetchImageUrlAsBase64(url);
            if (imgData) {
                imageParts.push({ type: 'image', mimeType: imgData.mimeType, data: imgData.base64 });
            } else {
                imageParts.push({ type: 'text', text: '[系統提示：使用者傳送的圖片網址無法讀取或檔案過大]' });
            }
        }
    }
    return imageParts;
}

// ════════════════════════════════════════════════════════
//  自訂 Emoji 處理
// ════════════════════════════════════════════════════════
async function fetchAndCacheEmoji(url, mimeType, name, id) {
    try {
        const cached = imageCache.get(url);
        if (cached && (Date.now() - cached.cachedAt) < IMAGE_CACHE_TTL_MS) {
            console.log(`[Emoji] 快取命中：${name}`);
            return { mimeType: cached.mimeType, data: cached.base64 };
        } else {
            const response = await fetch(url);
            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            imageCache.set(url, { base64, mimeType, cachedAt: Date.now() });
            console.log(`[Emoji] 已下載：${name} (${id})`);
            return { mimeType, data: base64 };
        }
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
// ════════════════════════════════════════════════════════
async function withTyping(channel, asyncFn) {
    let stop = false;
    let wakeUp = null;

    const typingLoop = async () => {
        while (!stop) {
            await channel.sendTyping().catch(() => {});
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
        wakeUp?.();
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
        console.log(`🔇 [TTS] 使用者不在語音頻道，跳過朗讀`);
        return;
    }
    const ttsText = text.length > TTS_MAX_LENGTH ? text.slice(0, TTS_MAX_LENGTH) : text;
    try {
        const result = await playTTS(guildId, ttsText);
        if (!result.success) {
            console.warn(`⚠️ [TTS] 朗讀失敗 (reason: ${result.reason})`);
        } else {
            console.log(`🔊 [TTS] 朗讀中 (engine: ${result.engine}, queued: ${result.queued})`);
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

// ════════════════════════════════════════════════════════
//  將提及 (Mentions) 轉換為純文字名稱
// ════════════════════════════════════════════════════════
function replaceMentions(message, botId) {
    let text = message.content || '';
    
    // 1. 移除對機器人本身的提及
    if (botId) {
        text = text.replace(new RegExp(`<@!?${botId}>`, 'g'), '');
    }
    
    // 2. 替換其他使用者、身分組、頻道為名稱
    if (message.mentions) {
        message.mentions.users?.forEach(user => {
            if (user.id === botId) return;
            text = text.replace(new RegExp(`<@!?${user.id}>`, 'g'), `@${user.username}`);
        });
        
        message.mentions.roles?.forEach(role => {
            text = text.replace(new RegExp(`<@&${role.id}>`, 'g'), `@${role.name}`);
        });
        
        message.mentions.channels?.forEach(channel => {
            text = text.replace(new RegExp(`<#${channel.id}>`, 'g'), `#${channel.name}`);
        });
    }
    
    return text.trim();
}

module.exports = {
    historyCache, HISTORY_CACHE_TTL_MS,
    clearUserMemory, getMemoryClearTime,
    isAITTSEnabled, setAITTSEnabled,
    recordBotMessageContext, getBotMessageContext,
    processAttachments,
    processCustomEmojis,
    processImageUrls,
    processEmbeds,       
    hasMissingSignature, 
    resolveDiscordImageUrl, 
    withTyping, speakWithTTS, splitMessage,
    replaceMentions,
};