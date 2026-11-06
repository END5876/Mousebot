'use strict';
// handlers/ai/tools/index.js
// AI 聊天的 function calling（音樂、分帳、免費遊戲、語音）。
//
// 做法比照 searchGrounding 的兩段式：
//   1. 判斷階段：不帶人格 prompt 的中性請求 + functionDeclarations，由模型決定要不要呼叫工具、呼叫哪些。
//      實測輕量模型帶著人格 prompt（temperature 1.0）時工具呼叫很不穩定，所以把判斷拆出來。
//   2. 執行工具，把結果整理成一段文字，附在人格的 system instruction 後面，讓人格用原本的語氣轉述。
//   判斷階段不把 functionResponse 回傳給模型（不需要多輪），Gemini 3 的 thought signature 也就不用處理。
//
// 防誤觸（平常聊天不會動到音樂、帳本）：
//   - 只有使用者主動找 Bot 時才帶工具（@提及、/ai ask、語音喚醒）；隨機插話一律不帶
//   - 關鍵字預篩：訊息完全沒提到相關字眼就不跑判斷階段（不多花一次呼叫）
//   - 判斷 prompt 規定「只有明確要求 Bot 去做」才呼叫，單純提到、聊天、過去式都不算
//   - 有副作用的工具：音樂控制要求跟 Bot 在同一個語音頻道；記帳要本人按確認卡
//
// 環境變數：
//   AI_TOOLS=0   關閉整個功能（預設開啟）
//
// 依模組決定可用的工具群組（utils/features.js）：音樂←music、分帳←splitbill、免費遊戲←notice、
// 語音←voice 或 tts。停用的群組不載入、不宣告，預篩關鍵字也不收；全部停用時預篩一律不命中。

const { FunctionCallingConfigMode } = require('@google/genai');
const { generate } = require('../geminiClient');
const { recordUsage } = require('../tokenTracker');
const logger = require('../../../utils/logger');
const { ToolError } = require('./toolError');
const features = require('../../../utils/features');

const MAX_CALLS = 3;
const ROUTER_TIMEOUT_MS = 15_000;
// 判斷階段只帶最近幾輪（使用者一則＋Bot 一則為一輪）：只需要理解「剛剛那首」這類指代，
// 不需要人格那邊完整的 12 則訊息，對話歷史是判斷呼叫裡最大的變動 token 來源
const ROUTER_HISTORY_TURNS = 3;

// 工具群組：available() 為 true 時才載入該檔，每個群組只載入一次。
// 各檔匯出 { tools, keywords }；陣列順序就是宣告與預篩關鍵字的順序
const GROUPS = [
    { key: 'music',     file: './music',     available: () => features.isEnabled('music'),     noAction: '播放音樂' },
    { key: 'splitbill', file: './splitbill', available: () => features.isEnabled('splitbill'), noAction: '記帳' },
    { key: 'freeGames', file: './freeGames', available: () => features.isEnabled('notice'),    noAction: '查遊戲' },
    { key: 'voice',     file: './voice',     available: () => features.isEnabled('voice') || features.isEnabled('tts'), noAction: '進出語音頻道' },
];
const loadedGroups = new Map(); // key → { tools, keywords }

function loadGroup(group) {
    if (!loadedGroups.has(group.key)) loadedGroups.set(group.key, require(group.file));
    return loadedGroups.get(group.key);
}

/** 目前可用的群組（模組狀態每次從 env 重新判斷） */
function availableGroups() {
    return GROUPS.filter(g => g.available());
}

const isEnabled = () => process.env.AI_TOOLS !== '0';

// 召回率優先：寧可多跑一次便宜的判斷，也不要漏掉真正的要求；精準度交給判斷階段。
// 關鍵字放在各工具檔；依可用群組的組合組成 regex 並記住
const keywordMemo = new Map(); // 群組 key 組合 → RegExp|null

function keywordRegex(groups) {
    const memoKey = groups.map(g => g.key).join(',');
    if (!keywordMemo.has(memoKey)) {
        const words = groups.flatMap(g => loadGroup(g).keywords);
        keywordMemo.set(memoKey, words.length ? new RegExp(words.join('|'), 'i') : null);
    }
    return keywordMemo.get(memoKey);
}

function needsTools(text) {
    if (!text) return false;
    const groups = availableGroups();
    if (!groups.length) return false;
    const re = keywordRegex(groups);
    return !!re && re.test(text);
}

const ROUTER_PROMPT = [
    '你是 Discord 機器人的指令判斷器，只負責決定要不要呼叫工具，不回覆使用者。',
    '對話中以「【發言者：名稱】」標示說話者；只看最新一則訊息，之前的對話只用來理解指代（例如「剛剛那首」）。',
    '只有在最新訊息「明確要求機器人現在去做某件事」時才呼叫工具，例如「放周杰倫的晴天」「幫我記帳晚餐 900 三個人分」「現在 Epic 送什麼」「進來語音」。',
    '以下都不要呼叫工具：單純提到或聊到歌、遊戲、錢（「昨天那首歌好好聽」「Epic 上次送的很爛」）；過去式或假設；開玩笑、反諷；問機器人意見或感想；要求不完整到無法執行（例如只說「放歌」沒說放什麼。但「隨便放一首」可以用 music_random）。',
    '不確定時不要呼叫。不需要工具時直接回覆 NONE。',
].join('\n');

/** 可用群組裡的全部工具（不看 source 與工具層級的 isAvailable） */
function allTools(groups = availableGroups()) {
    return groups.flatMap(g => loadGroup(g).tools);
}

function availableTools(source) {
    return allTools().filter(t => !t.skipSources?.includes(source) && (t.isAvailable?.() ?? true));
}

/** 取最近 turns 輪；切完開頭若是 Bot 的話就丟掉，對話一律從使用者開始 */
function recentTurns(history, turns) {
    const recent = history.slice(-turns * 2);
    const firstUser = recent.findIndex(c => c.role === 'user');
    return firstUser === -1 ? [] : recent.slice(firstUser);
}

/**
 * 接上本次訊息。mergeUser=true（單一人格的群組歷史）時，歷史最後一則若是 user，
 * 就把本次 parts 併進去，避免連續兩個 user content；多人格維持原本的寫法
 */
function withCurrent(history, parts, mergeUser) {
    const last = history[history.length - 1];
    if (mergeUser && last?.role === 'user') {
        return [...history.slice(0, -1), { role: 'user', parts: [...last.parts, ...parts] }];
    }
    return [...history, { role: 'user', parts }];
}

/** 判斷階段只需要文字，圖片不送（省 token，也避免把圖片內容當成指令） */
function textOnly(contents) {
    return contents
        .map(c => ({ ...c, parts: (c.parts || []).filter(p => typeof p.text === 'string' && p.text.trim()) }))
        .filter(c => c.parts.length > 0);
}

async function execute(call, ctx) {
    const tool = allTools().find(t => t.declaration.name === call.name);
    if (!tool) return { label: call.name, ok: false, text: '不支援的動作', quiet: false };
    const quiet = !!tool.quiet;
    try {
        const text = await tool.run(ctx, call.args || {});
        logger.info('AITool', `🛠️ ${call.name} (${ctx.guild.id} / ${ctx.userId})：${String(text).split('\n')[0]}`);
        return { label: tool.label, ok: true, text, quiet };
    } catch (err) {
        if (err instanceof ToolError) {
            logger.info('AITool', `🛠️ ${call.name} 未執行（${ctx.userId}）：${err.message}`);
            return { label: tool.label, ok: false, text: err.message, quiet };
        }
        logger.error('AITool', `工具 ${call.name} 執行錯誤：`, err);
        return { label: tool.label, ok: false, text: '執行時發生錯誤', quiet };
    }
}

const RESULT_HEADER = '【剛剛替使用者執行的動作（系統實際結果，以此為準）】';
const RESULT_RULE = '請用你原本的人格語氣，自然地告訴使用者結果；失敗的要說明原因。'
    + '不要捏造上面沒有的動作或資料。網址只能原樣貼上面結果裡出現過的，結果裡沒有網址就完全不要貼任何連結（絕對不要自己編 YouTube 網址）。'
    + '不要提到「工具」「系統」這些字眼。';
// 預篩命中但最後沒有執行任何動作時附上，避免人格嘴上說「好喔幫你放了」實際上什麼都沒做
// 依可用群組組出「播放音樂、記帳、查遊戲或進出語音頻道」；全開時和原本的字串逐字相同
function noActionRule(groups = availableGroups()) {
    const items = groups.map(g => g.noAction);
    const list = items.length > 1 ? `${items.slice(0, -1).join('、')}或${items.at(-1)}` : (items[0] ?? '');
    return `【注意】這次沒有替使用者${list}。`
        + '只有在使用者明顯是要你做這些事時才需要理會這段：不要假裝已經做了，可以請他把要求說清楚（例如要放哪首歌）。'
        + '使用者只是在聊天的話，完全忽略這段，也不要提起。';
}

/**
 * 工具階段。回傳要附在人格 system instruction 後面的文字；不需要工具時回傳 null。
 *
 * @param {object} opts
 * @param {Array}  opts.history   對話歷史（Gemini contents）
 * @param {Array}  opts.parts     本次訊息的 parts
 * @param {string} opts.text      本次訊息的純文字（預篩用）
 * @param {object} opts.ctx       { guild, member, textChannel, userId, source: 'text'|'voice' }
 * @param {string} [opts.mode]    人格模式（只用於用量統計）
 * @param {boolean} [opts.mergeUser] 本次訊息併進歷史最後的 user content（單一人格）。
 *                                   群組歷史的 part 數／字數由呼叫端先精簡（aiCore 的 compactHistory）
 * @returns {Promise<{ text: string, skipTTS: boolean }|null>}
 *          text：附在 system instruction 後面的文字；skipTTS：這次回覆不要朗讀（用到了 quiet 工具，例如點歌）
 */
async function runToolStage({ history, parts, text, ctx, mode = null, mergeUser = false }) {
    if (!isEnabled() || !ctx?.guild || !ctx.member || !needsTools(text)) return null;

    const tools = availableTools(ctx.source);
    // 例如只剩語音群組、而這次是語音對話（voice_say 不提供）：沒有可宣告的工具就不跑判斷
    if (!tools.length) return null;
    const NO_ACTION_RULE = noActionRule();
    let response;
    try {
        response = await generate({
            systemInstruction: ROUTER_PROMPT,
            contents: textOnly(withCurrent(recentTurns(history, ROUTER_HISTORY_TURNS), parts, mergeUser)),
            config: {
                tools: [{ functionDeclarations: tools.map(t => t.declaration) }],
                toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
                maxOutputTokens: 512,
            },
            timeoutMs: ROUTER_TIMEOUT_MS,
        });
    } catch (err) {
        logger.warn('AITool', `判斷階段失敗，略過：${err.message}`);
        return { text: NO_ACTION_RULE, skipTTS: false };
    }
    recordUsage('tools', response, { userId: ctx.userId, mode });

    const allowed = new Set(tools.map(t => t.declaration.name));
    const calls = (response.functionCalls ?? []).filter(c => allowed.has(c.name)).slice(0, MAX_CALLS);
    if (!calls.length) return { text: NO_ACTION_RULE, skipTTS: false };

    // 依序執行：同一則訊息裡的動作可能有先後關係（例如先進語音再放歌）
    const results = [];
    for (const call of calls) results.push(await execute(call, ctx));

    const lines = results.map(r => `- ${r.label}：${r.ok ? '成功。' : '沒有執行，原因：'}${r.text}`);
    return {
        text: `${RESULT_HEADER}\n${lines.join('\n')}\n${RESULT_RULE}`,
        skipTTS: results.some(r => r.quiet),
    };
}

/** 從 Discord 訊息或互動組出工具需要的 context（訊息與互動都有 guild / member / channel） */
function contextFrom(source, { guild, member, channel, userId }) {
    if (!guild || !member) return null;
    return { guild, member, textChannel: channel ?? null, userId: userId ?? member.id, source };
}

module.exports = {
    runToolStage,
    contextFrom,
    needsTools,
    isEnabled,
    _ROUTER_PROMPT: ROUTER_PROMPT,
    _allTools: () => allTools(),
    _noActionRule: () => noActionRule(),
    _textOnly: textOnly,
    _recentTurns: recentTurns,
    _withCurrent: withCurrent,
    _execute: execute,
};
