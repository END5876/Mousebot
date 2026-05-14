const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { GENERATION_CONFIG } = require('../../config/aiSettings');
const { selectMode, getModeName } = require('./modeSelector');
const developerMode = require('./modes/developerMode');
const guguMode = require('./modes/gugugagaMode');
const lossMode = require('./modes/lossMode');
const mambaMentorMode = require('./modes/mambaMentorMode');
const mygoMode = require('./modes/mygoMode');
const inmuMode = require('./modes/inmuMode');
const loverMode = require('./modes/loverMode');

const {
    historyCache, HISTORY_CACHE_TTL_MS,
    getMemoryClearTime, getBotMessageContext,
    processAttachments,
} = require('./aiUtils');

// ════════════════════════════════════════════════════════
//  設定常數
// ════════════════════════════════════════════════════════
const MODEL_NAME = "gemini-3.1-flash-lite";
const HISTORY_FETCH_LIMIT = 30;
const HISTORY_PAIR_LIMIT = 10;
const HISTORY_TIME_LIMIT_MS = 10 * 60 * 1000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ════════════════════════════════════════════════════════
//  模式映射表
// ════════════════════════════════════════════════════════
const MODE_MAP = {
    loss: lossMode,
    mambaMentor: mambaMentorMode,
    mygo: mygoMode,
    inmu: inmuMode,
    lover: loverMode,
    developer: developerMode,
    gugu: guguMode
};

const VOICE_MODE_ADDON = `

## 語音回覆規則（最高優先，覆蓋長度設定）
1. 使用者現在是透過「語音」跟你講話，你的回覆也會被轉成語音播放。
2. 回答必須「口語化」，像真人聊天一樣自然。
3. 保持簡短！盡量控制在 1~3 句話以內（約 30~50 字），絕對不要長篇大論。
4. 絕對不要使用 Markdown 語法（如 **粗體**、*斜體*、列表、程式碼區塊），因為語音引擎無法朗讀排版。
5. 在遵守以上規則的前提下，必須完全保持你現在的人格設定與語氣。
`;

// ════════════════════════════════════════════════════════
//  模式工具函式
// ════════════════════════════════════════════════════════
function getSystemPrompt(mode) {
    const modeModule = MODE_MAP[mode];
    if (!modeModule) {
        console.error(`Unknown mode: ${mode}`);
        return lossMode.LOSS_MODE_PROMPT;
    }
    const promptKey = Object.keys(modeModule).find(key => key.endsWith('_PROMPT'));
    return modeModule[promptKey];
}

function getUserMode(userId, message) {
    const mode = selectMode(userId, message);
    console.log(`[Mode] User ${userId} -> ${getModeName(mode)}`);
    return mode;
}

function getModel(mode, isVoice = false) {
    let systemPrompt = getSystemPrompt(mode);
    if (isVoice) systemPrompt += VOICE_MODE_ADDON;
    return genAI.getGenerativeModel({
        model: MODEL_NAME,
        systemInstruction: systemPrompt,
        safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT,         threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,        threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,  threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,  threshold: HarmBlockThreshold.BLOCK_NONE },
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

        const currentMsg = fetched.get(currentMessageId);
        const currentTimestamp = currentMsg?.createdTimestamp ?? Date.now();
        const clearTime = getMemoryClearTime(userId);

        let relevantMessages = fetched
            .filter(msg => {
                if (msg.id === currentMessageId) return false;
                if ((currentTimestamp - msg.createdTimestamp) > HISTORY_TIME_LIMIT_MS) return false;
                if (msg.createdTimestamp <= clearTime) return false;
                if (!msg.content?.trim().length && msg.attachments.size === 0) return false;
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
            if (msg.content?.trim().length > 0) parts.push({ text: msg.content.trim() });
            if (parts.length === 0) parts.push({ text: '[使用者傳了一張無法讀取的圖片]' });
            history.push({ role: msg.author.id === botId ? 'model' : 'user', parts });
        }

        let finalHistory = mergeConsecutiveRoles(history);
        while (finalHistory.length > 0 && finalHistory[0].role === 'model') finalHistory.shift();

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
        const refAuthor = refMsg.author.username;
        const refContent = refMsg.content?.trim();
        const isSelf = refMsg.author.id === botId;
        let refText = '';

        if (isSelf) {
            const cachedContext = getBotMessageContext(refMsg.id);

            if (cachedContext) {
                const { mode: refMode, userId: refTargetId, userName: refTargetName } = cachedContext;

                if (refTargetId !== currentUserId) {
                    // ✅ 跨用戶引用：明確告訴 AI 這是它自己對「別人」說的
                    refText = `> 引用你之前對別人（${refTargetName}）說的話：\n> 「${refContent}」\n\n`;
                } else if (refMode !== currentMode) {
                    // 同用戶但跨模式
                    refText = `> 引用你之前對他說的話：\n> 「${refContent}」\n\n`;
                } else {
                    // 完全相同情境
                    refText = `> 引用你之前的發言：\n> 「${refContent}」\n\n`;
                }
            } else {
                refText = `> 引用你之前的發言：\n> 「${refContent}」\n\n`;
            }
        } else {
            refText = `> 引用 ${refAuthor} 的發言：\n> 「${refContent}」\n\n`;
        }

        if (refMsg.attachments.size > 0) {
            const refImageParts = await processAttachments(refMsg.attachments);
            refImageParts.forEach(img => parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } }));
            refText += refContent ? ' [附帶圖片]' : ' [一張圖片]';
        }
        parts.push({ text: refText });
    }

    imageParts.forEach(img => parts.push({ inlineData: img }));
    if (question) {
        parts.push({ text: question });
    }
    return parts;
}

// ════════════════════════════════════════════════════════
//  核心 AI 呼叫
// ════════════════════════════════════════════════════════
async function getGeminiResponse(userId, prompt, imageParts = [], channel = null, messageId = null, botId = null, message = null, mode = null) {
    try {
        if (!mode) mode = getUserMode(userId, prompt);
        const model = getModel(mode);
        const history = channel ? await fetchUserChannelHistory(channel, userId, messageId, botId) : [];
        const chat = model.startChat({ history, generationConfig: GENERATION_CONFIG });
        const messageParts = message
            ? await buildMessagePartsWithReference(message, prompt, imageParts, botId, mode, userId)
            : [...imageParts.map(img => ({ inlineData: img })), { text: prompt || '' }];
        const result = await chat.sendMessage(messageParts);
        return result.response.text();
    } catch (error) {
        console.error(`Gemini Error (${MODEL_NAME}):`, error.message);
        throw error;
    }
}

async function getGeminiResponseVoice(userId, prompt, channel = null, messageId = null, botId = null, mode = null) {
    try {
        if (!mode) mode = getUserMode(userId, prompt);
        const model = getModel(mode, true);
        const history = channel ? await fetchUserChannelHistory(channel, userId, messageId, botId) : [];
        const chat = model.startChat({ history, generationConfig: { ...GENERATION_CONFIG, maxOutputTokens: 150 } });
        const result = await chat.sendMessage([{ text: prompt }]);
        const response = result.response.text().trim();
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
        const model = getModel(mode);
        const history = channel ? await fetchUserChannelHistory(channel, userId, messageId, botId) : [];
        const shortPrompt = imageParts.length > 0 && !promptText
            ? `請用大約10~200個字回應或吐槽這張圖片`
            : `請用大約10~200字回應或吐槽訊息：「${promptText}」`;
        const chat = model.startChat({ history, generationConfig: { ...GENERATION_CONFIG, maxOutputTokens: 300 } });
        const messageParts = message
            ? await buildMessagePartsWithReference(message, shortPrompt, imageParts, botId, mode, userId)
            : [...imageParts.map(img => ({ inlineData: img })), { text: shortPrompt }];
        const result = await chat.sendMessage(messageParts);
        return result.response.text().trim();
    } catch (error) {
        console.error(`Short Response Error:`, error.message);
        return null;
    }
}

module.exports = {
    MODE_MAP,
    getUserMode,
    getGeminiResponse,
    getGeminiResponseVoice,
    getShortResponse,
};
