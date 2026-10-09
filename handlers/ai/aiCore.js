const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { GENERATION_CONFIG } = require('./aiSettings');
const { selectMode, getModeName } = require('./modeSelector');
const promptStore = require('./promptStore');

const {
    historyCache, HISTORY_CACHE_TTL_MS,
    getMemoryClearTime, getBotMessageContext,
    processAttachments,
    processImageUrls,
} = require('./aiUtils');

// ════════════════════════════════════════════════════════
//  設定常數
// ════════════════════════════════════════════════════════
const MODEL_NAME           = "gemini-3.1-flash-lite";
const HISTORY_FETCH_LIMIT  = 30;
const HISTORY_PAIR_LIMIT   = 12; 
const HISTORY_TIME_LIMIT_MS = 10 * 60 * 1000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ════════════════════════════════════════════════════════
//  Token 用量 Debug
// ════════════════════════════════════════════════════════
// createTokenAccumulator：每次外部請求（getGeminiResponse 等）建立一個
// 獨立的累加器物件，透過參數往下傳遞給所有子呼叫（歷史淨化、引用淨化、
// 主要生成），藉此在多位使用者並發請求時，避免共用全域變數造成的
// token 計數互相汙染。
function createTokenAccumulator(label) {
    return { label, prompt: 0, candidates: 0, total: 0, calls: 0 };
}

// logTokenUsage：印出單次 API 呼叫的 token 用量。
// 若傳入 accumulator，會同時將這筆用量累加進去，供後續彙總使用。
function logTokenUsage(label, response, accumulator = null) {
    const meta = response.usageMetadata;
    if (!meta) {
        console.log(`[Token] (${label}) ⚠️ 無法取得 usageMetadata`);
        return;
    }
    const prompt     = meta.promptTokenCount     ?? 0;
    const candidates = meta.candidatesTokenCount ?? 0;
    const total      = meta.totalTokenCount      ?? 0;
    console.log(
        `[Token] (${label})\n` +
        `        輸入: ${prompt} | 輸出: ${candidates} | 總計: ${total}`
    );
    if (accumulator) {
        accumulator.prompt     += prompt;
        accumulator.candidates += candidates;
        accumulator.total      += total;
        accumulator.calls      += 1;
    }
}

// logTokenSummary：印出單次外部請求（含所有子呼叫）的 token 總花費。
function logTokenSummary(accumulator) {
    console.log(
        `[Token] ══════ (${accumulator.label}) 本次請求總花費 ══════\n` +
        `        子呼叫數: ${accumulator.calls} | 輸入: ${accumulator.prompt} | ` +
        `輸出: ${accumulator.candidates} | 總計: ${accumulator.total}`
    );
}

// ════════════════════════════════════════════════════════
//  工具函式：將 imageParts 陣列轉換為 Gemini API 格式
// ════════════════════════════════════════════════════════
function toGeminiPart(part) {
    if (part.type === 'text')  return { text: part.text };
    if (part.type === 'image') return { inlineData: { mimeType: part.mimeType, data: part.data } };
    if (part.mimeType && part.data) return { inlineData: { mimeType: part.mimeType, data: part.data } };
    return null;
}

// ════════════════════════════════════════════════════════
//  模式工具函式
// ════════════════════════════════════════════════════════
// prompt 內容由 promptStore 從 data/prompts/ 讀取（可熱重載），這裡不做快取
const FALLBACK_MODE = 'loss';

function getSystemPrompt(mode) {
    const modeData = promptStore.getMode(mode);
    if (modeData) return modeData.prompt;
    console.error(`Unknown mode: ${mode}，改用 ${FALLBACK_MODE}`);
    return promptStore.getMode(FALLBACK_MODE)?.prompt ?? '';
}

function getUserMode(userId, message) {
    const mode = selectMode(userId, message);
    console.log(`[Mode] User ${userId} -> ${getModeName(mode)}`);
    return mode;
}

function getModel(mode, isVoice = false) {
    const parts = [getSystemPrompt(mode), promptStore.getShared('_general')];
    if (isVoice) parts.push(promptStore.getShared('_voice'));
    const systemPrompt = parts.filter(Boolean).join('\n\n');

    return genAI.getGenerativeModel({
        model: MODEL_NAME,
        systemInstruction: systemPrompt,
        safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ]
    });
}

// ════════════════════════════════════════════════════════
//  歷史記錄
// ════════════════════════════════════════════════════════
function mergeConsecutiveRoles(history) {
    if (!history || history.length === 0) return [];
    const merged = [];
    let current = { ...history[0] };
    for (let i = 1; i < history.length; i++) {
        const next = history[i];
        if (next.role === current.role) {
            current.parts = [...current.parts, ...next.parts];
        } else {
            merged.push(current);
            current = { ...next };
        }
    }
    merged.push(current);
    return merged;
}

function isBotReplyToUser(msg, userId, fetchedMessages) {
    if (msg.reference?.messageId) {
        const refMsg = fetchedMessages.get(msg.reference.messageId);
        if (refMsg && refMsg.author.id === userId) return true;
        if (!refMsg || refMsg.author.id !== userId) return false;
    }
    return true;
}

async function fetchUserChannelHistory(channel, userId, currentMessageId, botId) {
    try {
        const channelId = channel.id;
        const now = Date.now();

        let fetched;
        const cached = historyCache.get(channelId);
        if (cached && (now - cached.cachedAt) < HISTORY_CACHE_TTL_MS) {
            console.log(`[History Cache] 命中快取：${channelId}`);
            fetched = cached.messages;
        } else {
            fetched = await channel.messages.fetch({ limit: HISTORY_FETCH_LIMIT });
            historyCache.set(channelId, { messages: fetched, cachedAt: now });
            console.log(`[History Cache] 已更新快取：${channelId}`);
        }

        const currentMsg       = fetched.get(currentMessageId);
        const currentTimestamp = currentMsg?.createdTimestamp ?? Date.now();
        const clearTime        = getMemoryClearTime(userId);

        let relevantMessages = fetched
            .filter(msg => {
                if (msg.id === currentMessageId) return false;
                if ((currentTimestamp - msg.createdTimestamp) > HISTORY_TIME_LIMIT_MS) return false;
                if (msg.createdTimestamp <= clearTime) return false;
                
                const textContent = msg.cleanContent || msg.content;
                if (!textContent?.trim().length && msg.attachments.size === 0) return false;
                
                if (msg.author.id === userId) return true;
                if (msg.author.id === botId) return isBotReplyToUser(msg, userId, fetched);
                return false;
            })
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        while (relevantMessages.size > 0) {
            const first = relevantMessages.first();
            if (first.author.id === botId) {
                relevantMessages = relevantMessages.filter(m => m.id !== first.id);
            } else break;
        }

        relevantMessages = relevantMessages.last(HISTORY_PAIR_LIMIT);

        const history = [];
        for (const msg of relevantMessages.values()) {
            const parts = [];
            if (msg.attachments.size > 0) {
                const imgParts = await processAttachments(msg.attachments);
                imgParts.forEach(img => parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } }));
            }
            
            const textContent = msg.cleanContent || msg.content;
            if (textContent?.trim().length > 0) {
                // 歷史紀錄中，明確標示發言者
                if (msg.author.id === botId) {
                    parts.push({ text: textContent.trim() });
                } else {
                    parts.push({ text: `【發言者：${msg.author.username}】\n${textContent.trim()}` });
                }
            }
            
            if (parts.length === 0) parts.push({ text: '[使用者傳了一張無法讀取的圖片]' });
            history.push({ role: msg.author.id === botId ? 'model' : 'user', parts });
        }

        let finalHistory = mergeConsecutiveRoles(history);

        const firstUserIndex = finalHistory.findIndex(msg => msg.role === 'user');
        if (firstUserIndex > 0) {
            finalHistory = finalHistory.slice(firstUserIndex);
        } else if (firstUserIndex === -1) {
            finalHistory = [];
        }

        console.log(`[History] 載入 ${finalHistory.length} 筆對話紀錄`);
        return finalHistory;
    } catch (err) {
        console.error('[History] 抓取頻道歷史失敗：', err.message);
        return [];
    }
}

// ════════════════════════════════════════════════════════
//  引用訊息 / 差別待遇 Prompt 建構
// ════════════════════════════════════════════════════════
async function fetchReferencedMessage(message) {
    if (!message.reference?.messageId) return null;
    try {
        return await message.channel.messages.fetch(message.reference.messageId) ?? null;
    } catch { return null; }
}

async function buildMessagePartsWithReference(message, question, imageParts, botId, currentMode, currentUserId) {
    const parts = [];
    const refMsg = await fetchReferencedMessage(message);

    if (refMsg) {
        const refAuthor  = refMsg.author.username;
        const refContent = refMsg.cleanContent?.trim() || refMsg.content?.trim();
        const isSelf     = refMsg.author.id === botId;
        let refText      = '';

        if (isSelf) {
            const cachedContext = getBotMessageContext(refMsg.id);
            if (cachedContext) {
                const { mode: refMode, userId: refTargetId, userName: refTargetName } = cachedContext;
                if (refTargetId !== currentUserId) {
                    refText = `> 引用你之前對別人（${refTargetName}）說的話：\n> 「${refContent}」\n\n`;
                } else if (refMode !== currentMode) {
                    refText = `> 引用你之前對他說的話：\n> 「${refContent}」\n\n`;
                } else {
                    refText = `> 引用你之前的發言：\n> 「${refContent}」\n\n`;
                }
            } else {
                refText = `> 引用你之前的發言：\n> 「${refContent}」\n\n`;
            }
        } else {
            // 引用別人發言時，使用括號將暱稱隔開
            refText = `> 引用【發言者：${refAuthor}】的發言：\n> 「${refContent}」\n\n`;
        }

        // 處理實體附件
        if (refMsg.attachments.size > 0) {
            const refImageParts = await processAttachments(refMsg.attachments);
            refImageParts.forEach(img =>
                parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } })
            );
            refText += refContent ? ' [附帶圖片]' : ' [一張圖片]';
        }

        // 解析引用訊息中的網址圖片，依 type 分流處理
        if (refContent) {
            const refUrlImageParts = await processImageUrls(refContent);
            refUrlImageParts.forEach(part => {
                const geminiPart = toGeminiPart(part);
                if (geminiPart) parts.push(geminiPart);
            });
            if (refUrlImageParts.some(p => p.type === 'image') && refMsg.attachments.size === 0) {
                refText += ' [附帶網址圖片]';
            }
        }

        parts.push({ text: refText });
    }

    imageParts.forEach(part => {
        const geminiPart = toGeminiPart(part);
        if (geminiPart) parts.push(geminiPart);
    });

    // 將當下的提問也加上發言者標籤
    if (question) {
        const authorName = message?.author?.username || '使用者';
        parts.push({ text: `【發言者：${authorName}】\n${question}` });
    }
    return parts;
}

// ════════════════════════════════════════════════════════
//  核心 AI 呼叫
// ════════════════════════════════════════════════════════
async function getGeminiResponse(userId, prompt, imageParts = [], channel = null, messageId = null, botId = null, message = null, mode = null) {
    try {
        if (!mode) mode = getUserMode(userId, prompt);
        const model   = getModel(mode);
        const history = channel ? await fetchUserChannelHistory(channel, userId, messageId, botId) : [];
        const chat    = model.startChat({ history, generationConfig: GENERATION_CONFIG });

        // 如果沒有 message (例如斜線指令)，也要加上預設標籤
        const messageParts = message
            ? await buildMessagePartsWithReference(message, prompt, imageParts, botId, mode, userId)
            : [
                ...imageParts.map(part => toGeminiPart(part)).filter(Boolean),
                { text: prompt ? `【發言者：使用者】\n${prompt}` : '' }
            ];

        const result = await chat.sendMessage(messageParts);
        logTokenUsage(`getGeminiResponse / user:${userId} / mode:${mode}`, result.response); 
        return result.response.text();
    } catch (error) {
        console.error(`Gemini Error (${MODEL_NAME}):`, error.message);
        throw error;
    }
}

async function getGeminiResponseVoice(userId, prompt, channel = null, messageId = null, botId = null, mode = null) {
    try {
        if (!mode) mode = getUserMode(userId, prompt);
        const model   = getModel(mode, true);
        const history = channel ? await fetchUserChannelHistory(channel, userId, messageId, botId) : [];
        const chat    = model.startChat({ history, generationConfig: { ...GENERATION_CONFIG, maxOutputTokens: 150 } });

        const result   = await chat.sendMessage([{ text: prompt }]);
        const response = result.response.text().trim();
        logTokenUsage(`getGeminiResponseVoice / user:${userId} / mode:${mode}`, result.response); 
        console.log(`[Voice AI] ${userId}: "${prompt}" → "${response}"`);
        return response;
    } catch (error) {
        console.error(`[Voice AI] Gemini Error:`, error.message);
        throw error;
    }
}

async function getShortResponse(userId, promptText, imageParts = [], channel = null, messageId = null, botId = null, message = null, mode = null) {
    try {
        if (!mode) mode = getUserMode(userId, promptText);
        const model   = getModel(mode);
        const history = channel ? await fetchUserChannelHistory(channel, userId, messageId, botId) : [];
        const shortPrompt = imageParts.length > 0 && !promptText
            ? `請用大約10~200個字回應或吐槽這張圖片`
            : `請用大約10~200字回應或吐槽訊息：「${promptText}」`;
        const chat = model.startChat({ history, generationConfig: { ...GENERATION_CONFIG, maxOutputTokens: 300 } });

        // 短回覆標籤邏輯
        const messageParts = message
            ? await buildMessagePartsWithReference(message, shortPrompt, imageParts, botId, mode, userId)
            : [
                ...imageParts.map(part => toGeminiPart(part)).filter(Boolean),
                { text: `【發言者：使用者】\n${shortPrompt}` }
            ];

        const result = await chat.sendMessage(messageParts);
        logTokenUsage(`getShortResponse / user:${userId} / mode:${mode}`, result.response); 
        return result.response.text().trim();
    } catch (error) {
        console.error(`Short Response Error:`, error.message);
        return null;
    }
}

module.exports = {
    getUserMode,
    getGeminiResponse,
    getGeminiResponseVoice,
    getShortResponse,
};