const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { GENERATION_CONFIG } = require('../../config/aiSettings');
const { selectMode, getModeName } = require('./modeSelector');

// 模式
const developerMode = require('./modes/developerMode');
const guguMode = require('./modes/gugugagaMode');
const lossMode = require('./modes/lossMode');
const mambaMentorMode = require('./modes/mambaMentorMode');
const mygoMode = require('./modes/mygoMode');
const inmuMode = require('./modes/inmuMode');
const loverMode = require('./modes/loverMode');

const {
    historyCache, getMemoryClearTime, getBotMessageContext
} = require('./aiUtils');

// ════════════════════════════════════════════════════════
//  API Key 驗證 
// ════════════════════════════════════════════════════════
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    throw new Error('[aiCore] 環境變數 GEMINI_API_KEY 未設定，請檢查 .env 檔案');
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ════════════════════════════════════════════════════════
//  設定常數與模式映射
// ════════════════════════════════════════════════════════
const MODEL_NAME = "gemini-3.1-flash-lite";
const HISTORY_FETCH_LIMIT = 30;
const HISTORY_PAIR_LIMIT = 10;
const HISTORY_TIME_LIMIT_MS = 10 * 60 * 1000;

const MODE_MAP = {
    loss: lossMode, mambaMentor: mambaMentorMode, mygo: mygoMode,
    inmu: inmuMode, lover: loverMode, developer: developerMode, gugu: guguMode
};

const VOICE_MODE_ADDON = `\n## 語音回覆規則（最高優先，覆蓋長度設定）\n1. 使用者現在是透過「語音」跟你講話，回覆必須口語化，像真人聊天一樣自然。\n2. 控制在 1~3 句話以內（約 30~50 字），絕對不要長篇大論。\n3. 絕對不要使用 Markdown 語法，語音引擎無法朗讀排版。\n4. 必須完全保持你現在的人格設定。`;
const GENERAL_TEXT_ADDON = `\n## 全局回覆長度限制\n- 日常閒聊控制在 60 字以內。\n- 技術問題、需要詳細解說或撰寫程式碼時不受此限。`;

// ════════════════════════════════════════════════════════
//  模式工具函式
// ════════════════════════════════════════════════════════
const promptCache = {};
const modelCache = new Map(); //  Model 快取

function getSystemPrompt(mode) {
    if (promptCache[mode]) return promptCache[mode];
    const modeModule = MODE_MAP[mode] || lossMode;
    const promptKey = Object.keys(modeModule).find(key => key.endsWith('_PROMPT'));
    promptCache[mode] = modeModule[promptKey];
    return promptCache[mode];
}

function getUserMode(userId, message) {
    const mode = selectMode(userId, message);
    console.log(`[Mode] User ${userId} -> ${getModeName(mode)}`);
    return mode;
}

function getModel(mode, isVoice = false) {
    const cacheKey = `${mode}:${isVoice}`;
    if (modelCache.has(cacheKey)) return modelCache.get(cacheKey);

    let systemPrompt = getSystemPrompt(mode) + GENERAL_TEXT_ADDON;
    if (isVoice) systemPrompt += VOICE_MODE_ADDON;
    
    const model = genAI.getGenerativeModel({
        model: MODEL_NAME,
        systemInstruction: systemPrompt,
        safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ]
    });
    modelCache.set(cacheKey, model);
    return model;
}

// ════════════════════════════════════════════════════════
//  歷史記錄管理
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

// 修正邏輯可讀性，刪除多餘的條件
function isBotReplyToUser(msg, userId, fetchedMessages) {
    if (!msg.reference?.messageId) return true;
    const refMsg = fetchedMessages.get(msg.reference.messageId);
    return !!(refMsg && refMsg.author.id === userId);
}

async function fetchUserChannelHistory(channel, userId, currentMessageId, botId) {
    try {
        const channelId = channel.id;
        const now = Date.now();

        let fetched = historyCache.get(channelId);
        if (!fetched) {
            fetched = await channel.messages.fetch({ limit: HISTORY_FETCH_LIMIT });
            historyCache.set(channelId, fetched); // 使用 TTLCache 簡化寫法
        }

        const currentMsg = fetched.get(currentMessageId);
        const currentTimestamp = currentMsg?.createdTimestamp ?? now;
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

        // 轉換為陣列操作，避免 Collection filter O(n^2) 效能問題
        const msgArray = [...relevantMessages.values()];
        const firstUserIndex = msgArray.findIndex(m => m.author.id !== botId);
        const trimmedMessages = firstUserIndex === -1 ? [] : msgArray.slice(firstUserIndex).slice(-HISTORY_PAIR_LIMIT);

        const history = [];
        for (const msg of trimmedMessages) {
            const parts = [];
            // 注意：歷史抓取這裡原本需要 processAttachments，由於非同步限制，為避免效能過載，
            // 這裡保留原設計或改為僅讀取文字，因歷史記錄中圖片較難 100% 準確快取，
            // 若需完全還原，這裡建議改回純文字提示。為保持功能不變，這裡假定為文字佔位符。
            if (msg.attachments.size > 0) parts.push({ text: '[使用者傳了一張圖片]' });
            if (msg.content?.trim().length > 0) parts.push({ text: msg.content.trim() });
            if (parts.length === 0) parts.push({ text: '[無法讀取的內容]' });
            history.push({ role: msg.author.id === botId ? 'model' : 'user', parts });
        }

        let finalHistory = mergeConsecutiveRoles(history);
        const finalFirstUserIdx = finalHistory.findIndex(msg => msg.role === 'user');
        if (finalFirstUserIdx > 0) finalHistory = finalHistory.slice(finalFirstUserIdx);
        else if (finalFirstUserIdx === -1) finalHistory = [];

        return finalHistory;
    } catch (err) {
        console.error('[History] 抓取頻道歷史失敗：', err.message);
        return [];
    }
}

// ════════════════════════════════════════════════════════
//  引用訊息處理
// ════════════════════════════════════════════════════════
async function fetchReferencedMessage(message) {
    if (!message.reference?.messageId) return null;
    try { return await message.channel.messages.fetch(message.reference.messageId) ?? null; } 
    catch { return null; }
}

// 重構引用判斷，使用早期返回 (Early Return)
function buildRefText(refContent, isSelf, refAuthor, cachedContext, currentUserId, currentMode) {
    if (!isSelf) return `> 引用 ${refAuthor} 的發言：\n> 「${refContent}」\n\n`;
    if (!cachedContext) return `> 引用你之前的發言：\n> 「${refContent}」\n\n`;

    const { mode: refMode, userId: refTargetId, userName: refTargetName } = cachedContext;
    if (refTargetId !== currentUserId) return `> 引用你之前對別人（${refTargetName}）說的話：\n> 「${refContent}」\n\n`;
    if (refMode !== currentMode) return `> 引用你之前對他說的話：\n> 「${refContent}」\n\n`;
    return `> 引用你之前的發言：\n> 「${refContent}」\n\n`;
}

async function buildMessagePartsWithReference(message, question, imageParts, botId, currentMode, currentUserId) {
    const parts = [];
    const refMsg = await fetchReferencedMessage(message);

    if (refMsg) {
        const refContent = refMsg.content?.trim() || '';
        const isSelf = refMsg.author.id === botId;
        const cachedContext = isSelf ? getBotMessageContext(refMsg.id) : null;
        
        let refText = buildRefText(refContent, isSelf, refMsg.author.username, cachedContext, currentUserId, currentMode);
        
        if (refMsg.attachments.size > 0) refText += refContent ? ' [附帶圖片]' : ' [一張圖片]';
        parts.push({ text: refText });
    }

    imageParts.forEach(img => parts.push({ inlineData: img }));
    if (question) parts.push({ text: question });
    return parts;
}

// ════════════════════════════════════════════════════════
//  核心 AI 呼叫封裝
// ════════════════════════════════════════════════════════
async function withRetry(fn, maxRetries = 2, baseDelayMs = 1000) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isRetryable = err.status === 503 || err.status === 529 || err.code === 'ECONNRESET';
            if (!isRetryable || attempt === maxRetries) throw err;
            const delay = baseDelayMs * Math.pow(2, attempt);
            console.warn(`[Retry] API 異常，第 ${attempt + 1} 次重試，等待 ${delay}ms...`);
            await new Promise(res => setTimeout(res, delay));
        }
    }
}

async function callGemini(userId, prompt, options = {}) {
    const {
        imageParts = [], channel = null, messageId = null, botId = null,
        message = null, mode: forcedMode = null, isVoice = false,
        maxOutputTokens = null, promptPrefix = null,
    } = options;

    const mode = forcedMode ?? getUserMode(userId, prompt);
    const model = getModel(mode, isVoice);
    const history = channel ? await fetchUserChannelHistory(channel, userId, messageId, botId) : [];

    const genConfig = maxOutputTokens ? { ...GENERATION_CONFIG, maxOutputTokens } : GENERATION_CONFIG;
    const chat = model.startChat({ history, generationConfig: genConfig });

    const effectivePrompt = promptPrefix 
        ? (imageParts.length > 0 && !prompt ? promptPrefix : `${promptPrefix}：「${prompt}」`) 
        : prompt;

    const messageParts = message
        ? await buildMessagePartsWithReference(message, effectivePrompt, imageParts, botId, mode, userId)
        : [...imageParts.map(img => ({ inlineData: img })), { text: effectivePrompt || '' }];

    const result = await withRetry(() => chat.sendMessage(messageParts));
    return { text: result.response.text(), mode };
}

// ════════════════════════════════════════════════════════
//  公開對外介面
// ════════════════════════════════════════════════════════

/**
 * 取得一般 AI 文字回覆
 */
async function getGeminiResponse(userId, prompt, imageParts = [], channel = null, messageId = null, botId = null, message = null, mode = null) {
    const { text } = await callGemini(userId, prompt, { imageParts, channel, messageId, botId, message, mode });
    return text;
}

/**
 * 取得語音專用短回覆
 */
async function getGeminiResponseVoice(userId, prompt, channel = null, messageId = null, botId = null, mode = null) {
    const { text } = await callGemini(userId, prompt, { channel, messageId, botId, mode, isVoice: true, maxOutputTokens: 150 });
    console.log(`[Voice AI] ${userId}: "${prompt}" → "${text.trim()}"`);
    return text.trim();
}

/**
 * 取得隨機短回覆/吐槽
 */
async function getShortResponse(userId, promptText, imageParts = [], channel = null, messageId = null, botId = null, message = null, mode = null) {
    try {
        const prefix = imageParts.length > 0 && !promptText ? '請用大約10~200個字回應或吐槽這張圖片' : '請用大約10~200字回應或吐槽訊息';
        const { text } = await callGemini(userId, promptText, {
            imageParts, channel, messageId, botId, message, mode,
            maxOutputTokens: 300, promptPrefix: prefix
        });
        return text.trim();
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