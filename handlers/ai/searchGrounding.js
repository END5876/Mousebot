// handlers/ai/searchGrounding.js
// Google Search Grounding（Gemini 內建的 Google 搜尋工具）。
//
// 只在指定的 Discord 伺服器啟用：該伺服器內的 AI 對話（/ai ask、@ 提及、隨機插話、語音）
// 都會帶上 googleSearch 工具，是否搜尋、搜什麼完全由模型自行判斷，不另設任何限制。
//
// 環境變數：
//   GEMINI_SEARCH_GUILD_IDS  啟用的伺服器 ID（逗號分隔）。未設定或空字串時全部停用。
//
// 計費（Gemini 3 以上）：按「模型實際執行的搜尋次數」計費，搜尋取回的內容不以輸入 token 計費，
// 但會出現在 usageMetadata.toolUsePromptTokenCount，tokenTracker 會把它分開記錄。

// 舊版 Bot 回覆末尾曾附上來源行；讀取頻道歷史時據此濾掉，避免模型學著輸出來源格式
const SOURCES_PREFIX = '-# 📎 來源：';

const ENABLED_GUILD_IDS = new Set(
    (process.env.GEMINI_SEARCH_GUILD_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean)
);

const SEARCH_TOOLS = [{ googleSearch: {} }];

// ── 兩段式的第一段（搜尋階段）────────────────────────────
// 不帶人格的中性請求：模型自行判斷要不要搜尋；不需要時只回 RESEARCH_NONE
const RESEARCH_NONE = 'NONE';
const RESEARCH_PROMPT = [
    '你是資料查證助理，只負責判斷與蒐集資料，不直接回覆使用者。',
    '對話中以「【發言者：使用者名稱】」標示說話者，請針對最新一則訊息判斷。',
    '如果回答需要即時、近期或你不確定的外部資訊（新聞、比分、天氣、價格、近期事件、具體事實），使用 Google 搜尋，',
    '再用繁體中文條列整理與問題直接相關的事實（保留日期、數字、名稱），不要加評論或語氣。',
    `如果不需要查資料（例如閒聊、打招呼、意見、創作、推理），只輸出 ${RESEARCH_NONE}。`,
].join('\n');
const RESEARCH_CONFIG = {
    tools: SEARCH_TOOLS,
    temperature: 1.0, // Gemini 3 官方建議維持 1.0，調低可能出現重複迴圈
    maxOutputTokens: 600,
};
// 第二段附在人格 system instruction 後面的標題
const FACTS_HEADER = '【參考資料（剛剛透過 Google 搜尋取得，回答事實時以此為準；用你原本的人格語氣回答，不要提到你查了資料）】';

function hostnameOf(uri) {
    try { return new URL(uri).hostname; } catch { return '來源'; }
}

function isSearchEnabled(guildId) {
    return !!guildId && ENABLED_GUILD_IDS.has(String(guildId));
}

/**
 * 從 generateContent 的回應取出搜尋資訊
 * @returns {{ queries: string[], sources: Array<{ title: string, uri: string }> }}
 */
function getGroundingInfo(response) {
    const meta = response?.candidates?.[0]?.groundingMetadata;
    const queries = (meta?.webSearchQueries ?? []).filter(Boolean);

    const seen = new Set();
    const sources = [];
    for (const chunk of meta?.groundingChunks ?? []) {
        const uri = chunk?.web?.uri;
        if (!uri) continue;
        const title = (chunk.web.title || '').trim() || hostnameOf(uri);
        if (seen.has(title)) continue;
        seen.add(title);
        sources.push({ title, uri });
    }
    return { queries, sources };
}

/** 移除 Bot 舊回覆中的來源行（建構對話歷史用） */
function stripSourcesLine(text) {
    return text
        .split('\n')
        .filter(line => !line.startsWith(SOURCES_PREFIX))
        .join('\n')
        .trim();
}

module.exports = {
    SEARCH_TOOLS,
    RESEARCH_PROMPT,
    RESEARCH_CONFIG,
    RESEARCH_NONE,
    FACTS_HEADER,
    isSearchEnabled,
    getGroundingInfo,
    stripSourcesLine,
    ENABLED_GUILD_IDS,
};
