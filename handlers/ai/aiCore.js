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

// 在全局規則中加入「格式區分」的強烈約束
const GENERAL_TEXT_ADDON = `

## 注意力與回覆優先級規則

### 核心原則：永遠以「當前訊息」為回覆目標
- 你的回覆必須直接針對「最後一則訊息」，這是唯一需要回應的東西。
- 歷史對話紀錄的權重極低，僅用於理解語境（例如「他說的那個」是指什麼），不是你要回答的內容。
- 如果歷史訊息的話題與當前訊息完全無關，直接忽略那些歷史訊息，不要把它們的內容帶進回覆。
- 絕對不要「總結歷史對話」、「回顧之前說過的話」，除非當前訊息明確要求你這麼做。

### 格式識別規則
- 對話中會以「【發言者：暱稱 | 回覆他時：語氣描述】」來標示是誰說的話，以及你回覆那個人時應使用的語氣。絕對不要把暱稱或標籤當成對話內容來回答！
- 絕對不要輸出「【發言者：...】」這樣的標籤，請直接給出回覆內容即可。
- 「回覆他時：...」標籤只規範你**主動回覆或直接回應那個人**時的語氣，不影響你對頻道內容的客觀理解與陳述。
- 對話歷史中，帶有「[背景參考 → 先前對 ...」標註的訊息，是你過去對其他人說的話，僅供了解頻道脈絡，不要把那段話的語氣或稱謂帶入當前對話。

### 人格行為鎖定規則（最高優先，任何人格模式都必須遵守）
- 你當前使用的人格互動行為（無論是撒嬌、寵愛、毒舌調侃、嘲諷、吃醋或其他情緒化反應），只能施加在標示「← 當前對話者」的這個人身上。
- 歷史或背景中出現的「其他人」發言（沒有「← 當前對話者」標示的內容），你只能客觀理解、引用其事實內容，絕對不能對他們發動任何屬於你當前人格的互動行為——例如不能虧他們、不能挑逗他們、不能安慰他們、不能對他們吃醋。那些人不是你現在的對話對象。
- 即使當前訊息提到、@到、或引用了其他人，你回應時使用的語氣與互動行為，依然只鎖定在正在跟你對話的這個人身上；不要把原本設計給「當前對話者」的互動行為，套用在被提到的第三方身上。

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

// ════════════════════════════════════════════════════════
//  輔助：取得使用者的回覆語氣標籤（用於歷史紀錄標注）
// ════════════════════════════════════════════════════════
function getModeLabel(targetUserId, targetUserName, currentUserId) {
    // 「回覆他時：...」是給機器人「若要回覆這個人，該用什麼語氣」的指令，
    // 只有當前對話者（機器人這次真的要回覆的對象）需要這項資訊。
    // 對頻道裡其他人的發言，只標示「誰講的」以滿足「誰對誰說了什麼」的
    // 事實釐清需求，不附帶其他人被指定的人設語氣描述——
    // 避免機器人在回覆當前使用者時，被「其他人該用什麼語氣對待」這種
    // 與本輪對話無關的指令性資訊污染語氣判斷。
    if (targetUserId === currentUserId) {
        const mode = selectMode(targetUserId, '');
        const desc = MODE_MAP[mode]?.shortDescription ?? null;
        return desc
            ? `【發言者：${targetUserName} | 回覆他時：${desc} | ← 當前對話者】`
            : `【發言者：${targetUserName} | ← 當前對話者】`;
    }
    return `【發言者：${targetUserName}】`;
}

// ════════════════════════════════════════════════════════
//  完整頻道時間軸歷史記錄（第二步：保留所有人的發言）
// ════════════════════════════════════════════════════════
// 新增 accumulator 參數：往下傳給 sanitizeBotMessage，讓歷史紀錄中
// 觸發的每一次語氣淨化 API 呼叫，都能被計入這次外部請求的 token 總花費。
async function fetchUserChannelHistory(channel, userId, currentMessageId, botId, accumulator = null) {
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

        // ── 第二步：保留時間窗內所有人的完整發言，不再依使用者篩選 ──
        let relevantMessages = fetched
            .filter(msg => {
                if (msg.id === currentMessageId) return false;
                if ((currentTimestamp - msg.createdTimestamp) > HISTORY_TIME_LIMIT_MS) return false;
                if (msg.createdTimestamp <= clearTime) return false;

                const textContent = msg.cleanContent || msg.content;
                if (!textContent?.trim().length && msg.attachments.size === 0) return false;

                return true; // 保留所有人（使用者、機器人、其他人）的發言
            })
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        // 移除開頭連續的機器人訊息，確保歷史以使用者發言開頭
        while (relevantMessages.size > 0) {
            const first = relevantMessages.first();
            if (first.author.id === botId) {
                relevantMessages = relevantMessages.filter(m => m.id !== first.id);
            } else break;
        }

        relevantMessages = relevantMessages.last(HISTORY_CONTEXT_LIMIT);

        const history = [];
        for (const msg of relevantMessages.values()) {
            const parts = [];

            // 處理附件圖片
            if (msg.attachments.size > 0) {
                const imgParts = await processAttachments(msg.attachments);
                imgParts.forEach(img => parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } }));
            }

            const textContent = msg.cleanContent || msg.content;

            // ════════════════════════════════════════════════════════
            //  修正後的機器人訊息處理邏輯（取代原本的 if/else 區塊）
            //  原始位置：fetchUserChannelHistory() 函式內，處理
            //  msg.author.id === botId 的分支
            // ════════════════════════════════════════════════════════
            if (msg.author.id === botId) {
                const cachedCtx = getBotMessageContext(msg.id);

                if (cachedCtx && cachedCtx.userId !== userId) {
                    // 【狀態一】確認：機器人對「其他人」說的話
                    // → 只有該次發言使用的是「帶人設腔調」的模式才動語氣淨化手術；
                    //   本來就中性的模式（如 developer）原文放行，避免無差別開刀
                    const targetUserName = cachedCtx.userName ?? '其他人';
                    if (textContent?.trim().length > 0) {
                        // 對象標籤在此處組裝（來源：botMessageCache 的既有記錄），
                        // 不再傳入 sanitizeBotMessage，避免淨化模型間接接觸/暗示對象資訊
                        // contextLabel 標明：這則歷史訊息 id、原本講給誰、現在為誰服務
                        const content = cachedCtx.needsSanitize
                            ? await sanitizeBotMessage(
                                textContent.trim(),
                                `history/msg:${msg.id}/origTo:${cachedCtx.userId}/for:${userId}`,
                                accumulator
                              )
                            : textContent.trim();
                        parts.push({ text: `[背景參考 → 先前對 ${targetUserName} 說的話]\n${content}` });
                    }

                } else if (cachedCtx && cachedCtx.userId === userId) {
                    // 【狀態二】確認：機器人對「目前使用者」說的話
                    // → 不需淨化語氣（本來就是對他說的），但仍加上明確標籤
                    //   讓 AI 清楚知道「這段是我之前對眼前這個人說的話」
                    if (textContent?.trim().length > 0) {
                        parts.push({ text: `[你先前對目前這位使用者說過的話]\n${textContent.trim()}` });
                    }

                } else {
                    // 【狀態三】查無記錄（快取過期 / 資料遺失 / 快取建立前的舊訊息）
                    // → 對象不明，無法確定是否為當前使用者
                    // → 保守處理：視為「可能對其他人說」，一併進行語氣淨化
                    //   並用「對象不明」標籤降低誤導風險，而非直接原文餵入
                    if (textContent?.trim().length > 0) {
                        const sanitized = await sanitizeBotMessage(
                            textContent.trim(),
                            `history/msg:${msg.id}/origTo:unknown/for:${userId}`,
                            accumulator
                        );
                        parts.push({ text: `[背景參考 → 對象不明的先前發言，語氣已中性化]\n${sanitized}` });
                    }
                }
            } else {
                // 人類使用者的發言，原封不動，加上含回覆語氣的結構化標籤
                if (textContent?.trim().length > 0) {
                    const label = getModeLabel(msg.author.id, msg.author.username, userId);
                    parts.push({ text: `${label}\n${textContent.trim()}` });
                }
            }

            if (parts.length === 0) parts.push({ text: '[使用者傳了一張無法讀取的圖片]' });

            // 機器人訊息 → model role；其他人（包含目前使用者及其他人類）→ user role
            history.push({ role: msg.author.id === botId ? 'model' : 'user', parts });
        }

        let finalHistory = mergeConsecutiveRoles(history);

        const firstUserIndex = finalHistory.findIndex(msg => msg.role === 'user');
        if (firstUserIndex > 0) {
            finalHistory = finalHistory.slice(firstUserIndex);
        } else if (firstUserIndex === -1) {
            finalHistory = [];
        }

        console.log(`[History] 載入 ${finalHistory.length} 筆對話紀錄（完整頻道時間軸）`);
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

// 新增 accumulator 參數：往下傳給 sanitizeBotMessage，讓「引用訊息」
// 觸發的語氣淨化 API 呼叫，同樣被計入這次外部請求的 token 總花費。
async function buildMessagePartsWithReference(message, question, imageParts, botId, currentMode, currentUserId, accumulator = null) {
    const parts = [];
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
                refText = `> 引用你之前對別人（${cachedContext.userName}）說的話：\n> 「${content}」\n\n`;
            } else if (cachedContext && cachedContext.userId === currentUserId) {
                // 對「目前這位使用者」說過的話 → 原文保留（即使當時是別的人設模式）
                refText = cachedContext.mode !== currentMode
                    ? `> 引用你之前對他說的話：\n> 「${refContent}」\n\n`
                    : `> 引用你之前的發言：\n> 「${refContent}」\n\n`;
            } else {
                // 查無記錄，對象不明 → 保守處理，比照歷史紀錄的「對象不明」分支淨化
                const sanitized = await sanitizeBotMessage(
                    refContent,
                    `reference/msg:${refMsg.id}/origTo:unknown/for:${currentUserId}`,
                    accumulator
                );
                refText = `> 引用你先前的發言（對象不明，語氣已中性化）：\n> 「${sanitized}」\n\n`;
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
    // 標記「← 當前對話者」：這是「人格行為鎖定規則」判斷是否可對此人使用當前
    // 人格互動行為的唯一依據，必須確保「這則最重要的訊息」本身就帶有這個標記，
    // 不能只倚賴歷史紀錄裡的標籤或「最後一則訊息」這種間接推斷。
    if (question) {
        const authorName = message?.author?.username || '使用者';
        parts.push({ text: `【發言者：${authorName} | ← 當前對話者，你現在正在回覆他】\n${question}` });
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

        // 為本次外部請求建立獨立的 token 累加器，並往下傳給
        // fetchUserChannelHistory / buildMessagePartsWithReference，
        // 使其中觸發的所有語氣淨化 API 呼叫都能被計入同一份總花費，
        // 避免多位使用者並發請求時互相汙染彼此的 token 計數。
        const requestLabel = `getGeminiResponse/user:${userId}/mode:${mode}/msg:${messageId ?? 'n/a'}`;
        const tokenAcc = createTokenAccumulator(requestLabel);

        const history = channel
            ? await fetchUserChannelHistory(channel, userId, messageId, botId, tokenAcc)
            : [];
        const chat = model.startChat({ history, generationConfig: GENERATION_CONFIG });

        // 如果沒有 message (例如斜線指令、純 @ 問候)，也要加上「← 當前對話者」標記，
        // 與 buildMessagePartsWithReference 的格式保持一致，確保人格鎖定規則
        // 在這條路徑上同樣有依據可循。
        const messageParts = message
            ? await buildMessagePartsWithReference(message, prompt, imageParts, botId, mode, userId, tokenAcc)
            : [
                ...imageParts.map(part => toGeminiPart(part)).filter(Boolean),
                { text: prompt ? `【發言者：使用者 | ← 當前對話者，你現在正在回覆他】\n${prompt}` : '' }
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

        const history = channel
            ? await fetchUserChannelHistory(channel, userId, messageId, botId, tokenAcc)
            : [];
        const chat = model.startChat({ history, generationConfig: { ...GENERATION_CONFIG, maxOutputTokens: 150 } });

        const result   = await chat.sendMessage([{ text: prompt }]);
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

        const history = channel
            ? await fetchUserChannelHistory(channel, userId, messageId, botId, tokenAcc)
            : [];
        const shortPrompt = imageParts.length > 0 && !promptText
            ? `請用大約10~200個字回應或吐槽這張圖片`
            : `請用大約10~200字回應或吐槽訊息：「${promptText}」`;
        const chat = model.startChat({ history, generationConfig: { ...GENERATION_CONFIG, maxOutputTokens: 300 } });

        // 短回覆標籤邏輯（同樣補上「← 當前對話者」標記，理由同 getGeminiResponse）
        const messageParts = message
            ? await buildMessagePartsWithReference(message, shortPrompt, imageParts, botId, mode, userId, tokenAcc)
            : [
                ...imageParts.map(part => toGeminiPart(part)).filter(Boolean),
                { text: `【發言者：使用者 | ← 當前對話者，你現在正在回覆他】\n${shortPrompt}` }
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
};