const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { GENERATION_CONFIG } = require('./aiSettings');
const { selectMode, getModeName } = require('./modeSelector');
const developerMode    = require('./modes/developerMode');
const guguMode         = require('./modes/gugugagaMode');
const lossMode         = require('./modes/lossMode');
const mambaMentorMode  = require('./modes/mambaMentorMode');
const mygoMode         = require('./modes/mygoMode');
const inmuMode         = require('./modes/inmuMode');
const loverMode        = require('./modes/loverMode');
const mesugakiMode     = require('./modes/mesugakiMode');

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
const HISTORY_FETCH_LIMIT   = 30;
const HISTORY_CONTEXT_LIMIT = 12;  // 最終進入 context 的訊息上限
const HISTORY_TIME_LIMIT_MS  = 5 * 60 * 1000;  // 5 分鐘

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ════════════════════════════════════════════════════════
//  模式映射表
// ════════════════════════════════════════════════════════
const MODE_MAP = {
    loss:        lossMode,
    mambaMentor: mambaMentorMode,
    mygo:        mygoMode,
    inmu:        inmuMode,
    lover:       loverMode,
    developer:   developerMode,
    gugu:        guguMode,
    mesugaki:    mesugakiMode,
};

const VOICE_MODE_ADDON = `

## 語音回覆規則（最高優先，覆蓋長度設定）
1. 使用者現在是透過「語音」跟你講話，你的回覆也會被轉成語音播放。
2. 回答必須「口語化」，像真人聊天一樣自然。
3. 保持簡短！盡量控制在 1~3 句話以內（約 30~50 字），絕對不要長篇大論。
4. 絕對不要使用 Markdown 語法（如 **粗體**、*斜體*、列表、程式碼區塊），因為語音引擎無法朗讀排版。
5. 【注意力】你的回覆必須以「最新那句話」為唯一核心。歷史紀錄只是背景，不是你要回答的東西。
`;

// 群組訊息使用短別名，避免長標籤重複消耗 token 並保留發話者邊界。
const GENERAL_TEXT_ADDON = `

## 群組對話與回覆規則
- PARTICIPANTS 會定義本輪的短別名（例如 u1=Alice）；每則歷史訊息以 [uN] 標示作者。
- CURRENT 是本輪唯一的回覆對象。只能把 [uN] 的話歸於同一個 uN；歷史僅供理解事實、指涉與引用，不得回覆歷史作者，也不得將其主張歸給 CURRENT。
- [bot>uN] 是你先前對 uN 的回覆；只有 [bot>目前 CURRENT 的別名] 可延續對目前對象的人格互動。標記為 bg 或 ? 的 bot 訊息只可作中性背景。
- 不要輸出 PARTICIPANTS、CURRENT、[uN]、[bot>uN] 等控制標記，直接輸出回覆內容。
- 不要總結或回顧歷史，除非 CURRENT 明確要求。

### 人格行為鎖定規則（最高優先，任何人格模式都必須遵守）
- 你當前的人格互動行為只能施加在 CURRENT 身上；即使訊息提到、@到或引用其他人也一樣。

### 回覆長度規則
- 若為日常閒聊或一般對話，回覆字數請盡量控制在 30 字以內，保持自然、簡短的聊天節奏。
- 若使用者詢問技術問題、需要詳細解說或撰寫程式碼時，則不受此字數限制，請給出完整的解答。
`;


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
const promptCache = {};

function getSystemPrompt(mode) {
    if (promptCache[mode]) return promptCache[mode];

    const modeModule = MODE_MAP[mode];
    if (!modeModule) {
        console.error(`Unknown mode: ${mode}`);
        return lossMode.LOSS_MODE_PROMPT;
    }
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
    let systemPrompt = getSystemPrompt(mode);
    systemPrompt += GENERAL_TEXT_ADDON;
    if (isVoice) systemPrompt += VOICE_MODE_ADDON;

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
//  語氣淨化：對非目標使用者的機器人訊息進行中性化處理
// ════════════════════════════════════════════════════════
// 淨化只處理「文字本身」，不帶入目標對象資訊：
// - 避免淨化模型在改寫過程中意外保留/暗示對象的指代資訊
// - 讓同一句話不論原本講給誰聽，都能共用同一份淨化結果與快取
const SANITIZE_SYSTEM_PROMPT = `你是一個文字處理工具，負責將帶有特定人格語氣的訊息進行「語氣淨化」。

你的任務：
1. 完整保留原文中所有的事實內容、承諾、資訊、答案與條件。
2. 將語氣改為中性、平鋪直敘的陳述方式，像是在轉述一段對話紀錄。
3. 不要新增、推測或補充原文沒有的對象、稱謂、人稱代名詞。`;

// 語氣淨化快取，避免對同一訊息重複呼叫 API
// key 僅依賴文字內容本身（與目標對象無關），提高快取命中率
const sanitizeCache = new Map();
const SANITIZE_CACHE_MAX = 500;

// sanitizeBotMessage 新增兩個參數：
// - contextLabel：純粹用於 log 辨識這次淨化「來自哪個歷史/引用訊息、
//   原本是講給誰聽、現在是為了服務哪個使用者」，不參與快取 key 判斷，
//   不影響原本「同一句話共用快取」的設計。
// - accumulator：由呼叫端傳入的單次請求 token 累加器，命中快取時
//   （無 API 花費）不會累加，只有真正呼叫 API 時才累加。
async function sanitizeBotMessage(text, contextLabel = 'unknown', accumulator = null) {
    if (!text?.trim()) return text;

    const cacheKey = text;
    if (sanitizeCache.has(cacheKey)) {
        console.log(`[Token] (sanitizeBotMessage / ${contextLabel}) 💾 快取命中，無 API 花費`);
        return sanitizeCache.get(cacheKey);
    }

    try {
        const sanitizeModel = genAI.getGenerativeModel({
            model: MODEL_NAME,
            systemInstruction: SANITIZE_SYSTEM_PROMPT,
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT,        threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,       threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            ]
        });

        // prompt 只丟原文，不揭露這句話原本是講給誰聽的
        const result = await sanitizeModel.generateContent(
            `請對以下訊息進行語氣淨化：\n\n${text}`
        );
        const sanitized = result.response.text().trim();
        logTokenUsage(`sanitizeBotMessage / ${contextLabel}`, result.response, accumulator);

        // 寫入快取，超過上限時刪除最舊的一筆
        if (sanitizeCache.size >= SANITIZE_CACHE_MAX) {
            const firstKey = sanitizeCache.keys().next().value;
            sanitizeCache.delete(firstKey);
        }
        sanitizeCache.set(cacheKey, sanitized);
        return sanitized;
    } catch (err) {
        console.warn(`[Sanitize] (${contextLabel}) 語氣淨化失敗，使用原文：`, err.message);
        return text;
    }
}

// ════════════════════════════════════════════════════════
//  群組歷史序列化
// ════════════════════════════════════════════════════════
// Gemini chat 只有 user/model role；群組成員的身分必須由內容保留。
// 每個 Discord user ID 在單一請求內會得到穩定的短 alias（u1、u2…）。
function buildParticipantMap(messages, currentUserId, currentUserName = '使用者') {
    const participants = new Map();
    const add = (id, name) => {
        if (!id || participants.has(id)) return;
        participants.set(id, { alias: `u${participants.size + 1}`, name: name || '使用者' });
    };

    messages?.forEach(msg => {
        if (msg?.author && !msg.author.bot) add(msg.author.id, msg.author.username);
    });
    add(currentUserId, currentUserName);
    return participants;
}

function getParticipant(participants, userId, fallbackName = '使用者') {
    if (!participants.has(userId)) {
        participants.set(userId, { alias: `u${participants.size + 1}`, name: fallbackName });
    }
    return participants.get(userId);
}

function addBotReplyTargets(messages, participants, botId) {
    messages?.forEach(msg => {
        if (msg?.author?.id !== botId) return;
        const context = getBotMessageContext(msg.id);
        if (context?.userId) getParticipant(participants, context.userId, context.userName ?? '其他人');
    });
}

function formatUserText(content) {
    // 將原始 Discord 內容保持為單一資料字串，避免換行或控制字串偽造 CURRENT／[uN]。
    return JSON.stringify(String(content ?? ''));
}

function formatParticipants(participants) {
    const values = [...participants.values()]
        .map(({ alias, name }) => `${alias}=${formatUserText(name)}`)
        .join(', ');
    return values ? `PARTICIPANTS: ${values}. BOT=mousebot.` : 'PARTICIPANTS: none. BOT=mousebot.';
}

function formatCurrentRequest(alias, content, isRandomTrigger = false) {
    const randomNote = isRandomTrigger ? ' This was a random proactive reply.' : '';
    return `CURRENT=${alias}\n[${alias}] ${formatUserText(content)}\nReply only to CURRENT (${alias}). History is context, not CURRENT's words.${randomNote}`;
}

// 完整頻道時間軸：保留既有時間與數量限制，但不再跨作者合併 user role。
async function fetchUserChannelHistory(channel, userId, currentMessageId, botId, accumulator = null, currentUserName = '使用者') {
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
                return Boolean(textContent?.trim().length || msg.attachments.size > 0);
            })
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        while (relevantMessages.size > 0) {
            const first = relevantMessages.first();
            if (first.author.id === botId) relevantMessages = relevantMessages.filter(m => m.id !== first.id);
            else break;
        }

        relevantMessages = relevantMessages.last(HISTORY_CONTEXT_LIMIT);
        const participants = buildParticipantMap(relevantMessages, userId, currentUserName);
        // bot>uN 也必須先存在於身份表，避免歷史標籤引用未定義的 alias。
        addBotReplyTargets(relevantMessages, participants, botId);
        const history = [];

        // Alias 表只送一次；後續每條人類訊息僅加 [uN]，降低 metadata token。
        if (relevantMessages.size > 0) {
            history.push({ role: 'user', parts: [{ text: formatParticipants(participants) }] });
        }

        for (const msg of relevantMessages.values()) {
            const parts = [];
            if (msg.attachments.size > 0) {
                const imgParts = await processAttachments(msg.attachments);
                imgParts.forEach(img => parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } }));
            }

            const textContent = msg.cleanContent || msg.content;
            if (msg.author.id === botId) {
                const cachedCtx = getBotMessageContext(msg.id);
                if (textContent?.trim().length > 0) {
                    if (cachedCtx && cachedCtx.userId !== userId) {
                        const target = getParticipant(participants, cachedCtx.userId, cachedCtx.userName ?? '其他人');
                        const content = cachedCtx.needsSanitize
                            ? await sanitizeBotMessage(textContent.trim(), `history/msg:${msg.id}/origTo:${cachedCtx.userId}/for:${userId}`, accumulator)
                            : textContent.trim();
                        parts.push({ text: `[bot>${target.alias},bg] ${content}` });
                    } else if (cachedCtx && cachedCtx.userId === userId) {
                        const target = getParticipant(participants, userId, currentUserName);
                        parts.push({ text: `[bot>${target.alias}] ${textContent.trim()}` });
                    } else {
                        const sanitized = await sanitizeBotMessage(textContent.trim(), `history/msg:${msg.id}/origTo:unknown/for:${userId}`, accumulator);
                        parts.push({ text: `[bot>?,bg] ${sanitized}` });
                    }
                }
            } else if (textContent?.trim().length > 0) {
                const participant = getParticipant(participants, msg.author.id, msg.author.username);
                parts.push({ text: `[${participant.alias}] ${formatUserText(textContent.trim())}` });
            }

            if (parts.length === 0) parts.push({ text: '[image]' });
            // 每一則 Discord 訊息保留一個 Content；絕不可因相同 role 跨作者合併。
            history.push({ role: msg.author.id === botId ? 'model' : 'user', parts });
        }

        const firstUserIndex = history.findIndex(msg => msg.role === 'user');
        const finalHistory = firstUserIndex === -1 ? [] : history.slice(firstUserIndex);
        console.log(`[History] 載入 ${finalHistory.length} 筆對話紀錄（完整頻道時間軸；participants=${participants.size}）`);
        return { history: finalHistory, participants };
    } catch (err) {
        console.error('[History] 抓取頻道歷史失敗：', err.message);
        return { history: [], participants: buildParticipantMap([], userId, currentUserName) };
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

// 新增 accumulator 參數：往下傳給 sanitizeBotMessage，讓「引用訊息」
// 觸發的語氣淨化 API 呼叫，同樣被計入這次外部請求的 token 總花費。
async function buildMessagePartsWithReference(message, question, imageParts, botId, currentMode, currentUserId, accumulator = null, isRandomTrigger = false, participants = null) {
    const parts = [];
    const participantMap = participants ?? buildParticipantMap([], currentUserId, message?.author?.username || '使用者');
    const currentParticipant = getParticipant(participantMap, currentUserId, message?.author?.username || '使用者');
    const refMsg = await fetchReferencedMessage(message);

    if (refMsg) {
        const refAuthor  = refMsg.author.username;
        const refContent = refMsg.cleanContent?.trim() || refMsg.content?.trim();
        const isSelf     = refMsg.author.id === botId;
        let refText      = '';

        if (isSelf) {
            // 引用機器人自身過去的發言時，套用與 fetchUserChannelHistory 相同的
            // 三態語氣淨化判斷：引用是使用者主動指向的內容，顯著性比被動出現在
            // 歷史紀錄裡的訊息更高，若未淨化直接原文引用，機器人被舊人設帶偏的
            // 風險反而更高；同時也避免同一則訊息在「歷史」與「引用」兩條路徑
            // 出現淨化與未淨化的兩種矛盾版本。
            const cachedContext = getBotMessageContext(refMsg.id);
            if (cachedContext && cachedContext.userId !== currentUserId) {
                // 對「其他人」說過的話 → 依模式是否中性決定是否淨化，標明對象（誰對誰的事實照樣保留）
                const content = cachedContext.needsSanitize
                    ? await sanitizeBotMessage(
                        refContent,
                        `reference/msg:${refMsg.id}/origTo:${cachedContext.userId}/for:${currentUserId}`,
                        accumulator
                      )
                    : refContent;
                refText = `[REPLY_TO bot>${getParticipant(participantMap, cachedContext.userId, cachedContext.userName ?? '其他人').alias},bg] ${content}`;
            } else if (cachedContext && cachedContext.userId === currentUserId) {
                // 對「目前這位使用者」說過的話 → 原文保留（即使當時是別的人設模式）
                refText = `[REPLY_TO bot>${currentParticipant.alias}] ${refContent}`;
            } else {
                // 查無記錄，對象不明 → 保守處理，比照歷史紀錄的「對象不明」分支淨化
                const sanitized = await sanitizeBotMessage(
                    refContent,
                    `reference/msg:${refMsg.id}/origTo:unknown/for:${currentUserId}`,
                    accumulator
                );
                refText = `[REPLY_TO bot>?,bg] ${sanitized}`;
            }
        } else {
            // 引用別人發言時，使用括號將暱稱隔開
            refText = `[REPLY_TO ${getParticipant(participantMap, refMsg.author.id, refAuthor).alias}] ${formatUserText(refContent)}`;
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

    // CURRENT 固定為最後一個文字 part，將本輪對象與歷史背景物理分隔。
    if (question) parts.push({ text: formatCurrentRequest(currentParticipant.alias, question, isRandomTrigger) });
    return parts;
}

// ════════════════════════════════════════════════════════
//  核心 AI 呼叫
// ════════════════════════════════════════════════════════
async function getGeminiResponse(userId, prompt, imageParts = [], channel = null, messageId = null, botId = null, message = null, mode = null) {
    try {
        if (!mode) mode = getUserMode(userId, prompt);
        const model = getModel(mode);

        // 為本次外部請求建立獨立的 token 累加器，並往下傳給
        // fetchUserChannelHistory / buildMessagePartsWithReference，
        // 使其中觸發的所有語氣淨化 API 呼叫都能被計入同一份總花費，
        // 避免多位使用者並發請求時互相汙染彼此的 token 計數。
        const requestLabel = `getGeminiResponse/user:${userId}/mode:${mode}/msg:${messageId ?? 'n/a'}`;
        const tokenAcc = createTokenAccumulator(requestLabel);

        const historyContext = channel
            ? await fetchUserChannelHistory(channel, userId, messageId, botId, tokenAcc, message?.author?.username || '使用者')
            : { history: [], participants: buildParticipantMap([], userId, message?.author?.username || '使用者') };
        const { history, participants } = historyContext;
        const chat = model.startChat({ history, generationConfig: GENERATION_CONFIG });

        // CURRENT 固定置於最後，讓 slash command 與純 @ 問候也具備相同邊界。
        const messageParts = message
            ? await buildMessagePartsWithReference(message, prompt, imageParts, botId, mode, userId, tokenAcc, false, participants)
            : [
                ...imageParts.map(part => toGeminiPart(part)).filter(Boolean),
                { text: formatCurrentRequest(getParticipant(participants, userId, '使用者').alias, prompt) }
            ];

        const result = await chat.sendMessage(messageParts);
        logTokenUsage(requestLabel, result.response, tokenAcc);
        logTokenSummary(tokenAcc);
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

        const requestLabel = `getGeminiResponseVoice/user:${userId}/mode:${mode}/msg:${messageId ?? 'n/a'}`;
        const tokenAcc = createTokenAccumulator(requestLabel);

        const historyContext = channel
            ? await fetchUserChannelHistory(channel, userId, messageId, botId, tokenAcc)
            : { history: [], participants: buildParticipantMap([], userId) };
        const { history, participants } = historyContext;
        const chat = model.startChat({ history, generationConfig: { ...GENERATION_CONFIG, maxOutputTokens: 150 } });

        const result   = await chat.sendMessage([{ text: formatCurrentRequest(getParticipant(participants, userId).alias, prompt) }]);
        const response = result.response.text().trim();
        logTokenUsage(requestLabel, result.response, tokenAcc);
        logTokenSummary(tokenAcc);
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

        const requestLabel = `getShortResponse/user:${userId}/mode:${mode}/msg:${messageId ?? 'n/a'}`;
        const tokenAcc = createTokenAccumulator(requestLabel);

        const historyContext = channel
            ? await fetchUserChannelHistory(channel, userId, messageId, botId, tokenAcc, message?.author?.username || '使用者')
            : { history: [], participants: buildParticipantMap([], userId, message?.author?.username || '使用者') };
        const { history, participants } = historyContext;
        const shortPrompt = imageParts.length > 0 && !promptText
            ? `請用大約10~200個字回應或吐槽這張圖片`
            : `請用大約10~200字回應或吐槽訊息：「${promptText}」`;
        const chat = model.startChat({ history, generationConfig: { ...GENERATION_CONFIG, maxOutputTokens: 300 } });

        // 隨機回覆同樣以 CURRENT 置尾；標記僅說明機器人主動插話。
        const messageParts = message
            ? await buildMessagePartsWithReference(message, shortPrompt, imageParts, botId, mode, userId, tokenAcc, true, participants)
            : [
                ...imageParts.map(part => toGeminiPart(part)).filter(Boolean),
                { text: formatCurrentRequest(getParticipant(participants, userId, '使用者').alias, shortPrompt, true) }
            ];

        const result = await chat.sendMessage(messageParts);
        logTokenUsage(requestLabel, result.response, tokenAcc);
        logTokenSummary(tokenAcc);
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
    buildParticipantMap,
    getParticipant,
    formatParticipants,
    formatCurrentRequest,
    formatUserText,
    addBotReplyTargets,
};
