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

const { FunctionCallingConfigMode } = require('@google/genai');
const { generate } = require('../geminiClient');
const { recordUsage } = require('../tokenTracker');
const logger = require('../../../utils/logger');
const { ToolError } = require('./toolError');

const MAX_CALLS = 3;
const ROUTER_TIMEOUT_MS = 15_000;

const ALL_TOOLS = [
    ...require('./music').tools,
    ...require('./splitbill').tools,
    ...require('./freeGames').tools,
    ...require('./voice').tools,
];
const TOOL_MAP = new Map(ALL_TOOLS.map(t => [t.declaration.name, t]));

const isEnabled = () => process.env.AI_TOOLS !== '0';

// 召回率優先：寧可多跑一次便宜的判斷，也不要漏掉真正的要求；精準度交給判斷階段
const TOOL_KEYWORDS = new RegExp([
    // 音樂
    '歌', '曲', '音樂', '播', '放', '點', '跳過', '切', '下一首', '停', '循環', '重複', '佇列', '隊列',
    'music', 'play', 'skip', 'song', 'youtu', 'bilibili', 'b23\\.tv',
    // 分帳
    '分帳', '記帳', '帳', '付', '欠', '還錢', '請客', '花了', '多少錢', '行程',
    '\\d\\s*(元|塊|圓|円|日幣|日圓|美金|台幣|twd|jpy|usd)',
    // 免費遊戲
    '免費', '白嫖', '送遊戲', '領取', 'epic', 'steam',
    // 語音
    '語音', '進來', '過來', '離開', '出去', '唸', '念出', '說一聲', '講一聲', '廣播', '大聲',
    '跟大家(說|講)', '幫我(說|講)',
].join('|'), 'i');

function needsTools(text) {
    return !!text && TOOL_KEYWORDS.test(text);
}

const ROUTER_PROMPT = [
    '你是 Discord 機器人的指令判斷器，只負責決定要不要呼叫工具，不回覆使用者。',
    '對話中以「【發言者：名稱】」標示說話者；只看最新一則訊息，之前的對話只用來理解指代（例如「剛剛那首」）。',
    '只有在最新訊息「明確要求機器人現在去做某件事」時才呼叫工具，例如「放周杰倫的晴天」「幫我記帳晚餐 900 三個人分」「現在 Epic 送什麼」「進來語音」。',
    '以下都不要呼叫工具：單純提到或聊到歌、遊戲、錢（「昨天那首歌好好聽」「Epic 上次送的很爛」）；過去式或假設；開玩笑、反諷；問機器人意見或感想；要求不完整到無法執行（例如只說「放歌」沒說放什麼。但「隨便放一首」可以用 music_random）。',
    '不確定時不要呼叫。不需要工具時直接回覆 NONE。',
].join('\n');

function availableTools(source) {
    return ALL_TOOLS.filter(t => !t.skipSources?.includes(source));
}

/** 判斷階段只需要文字，圖片不送（省 token，也避免把圖片內容當成指令） */
function textOnly(contents) {
    return contents
        .map(c => ({ ...c, parts: (c.parts || []).filter(p => typeof p.text === 'string' && p.text.trim()) }))
        .filter(c => c.parts.length > 0);
}

async function execute(call, ctx) {
    const tool = TOOL_MAP.get(call.name);
    if (!tool) return { label: call.name, ok: false, text: '不支援的動作' };
    try {
        const text = await tool.run(ctx, call.args || {});
        logger.info('AITool', `🛠️ ${call.name} (${ctx.guild.id} / ${ctx.userId})：${String(text).split('\n')[0]}`);
        return { label: tool.label, ok: true, text };
    } catch (err) {
        if (err instanceof ToolError) {
            logger.info('AITool', `🛠️ ${call.name} 未執行（${ctx.userId}）：${err.message}`);
            return { label: tool.label, ok: false, text: err.message };
        }
        logger.error('AITool', `工具 ${call.name} 執行錯誤：`, err);
        return { label: tool.label, ok: false, text: '執行時發生錯誤' };
    }
}

const RESULT_HEADER = '【剛剛替使用者執行的動作（系統實際結果，以此為準）】';
const RESULT_RULE = '請用你原本的人格語氣，自然地告訴使用者結果；失敗的要說明原因。'
    + '不要捏造上面沒有的動作或資料；需要附遊戲、歌曲連結時直接貼網址。不要提到「工具」「系統」這些字眼。';
// 預篩命中但最後沒有執行任何動作時附上，避免人格嘴上說「好喔幫你放了」實際上什麼都沒做
const NO_ACTION_RULE = '【注意】這次沒有替使用者播放音樂、記帳、查遊戲或進出語音頻道。'
    + '只有在使用者明顯是要你做這些事時才需要理會這段：不要假裝已經做了，可以請他把要求說清楚（例如要放哪首歌）。'
    + '使用者只是在聊天的話，完全忽略這段，也不要提起。';

/**
 * 工具階段。回傳要附在人格 system instruction 後面的文字；不需要工具時回傳 null。
 *
 * @param {object} opts
 * @param {Array}  opts.history   對話歷史（Gemini contents）
 * @param {Array}  opts.parts     本次訊息的 parts
 * @param {string} opts.text      本次訊息的純文字（預篩用）
 * @param {object} opts.ctx       { guild, member, textChannel, userId, source: 'text'|'voice' }
 * @param {string} [opts.mode]    人格模式（只用於用量統計）
 * @returns {Promise<string|null>}
 */
async function runToolStage({ history, parts, text, ctx, mode = null }) {
    if (!isEnabled() || !ctx?.guild || !ctx.member || !needsTools(text)) return null;

    const tools = availableTools(ctx.source);
    let response;
    try {
        response = await generate({
            systemInstruction: ROUTER_PROMPT,
            contents: textOnly([...history, { role: 'user', parts }]),
            config: {
                tools: [{ functionDeclarations: tools.map(t => t.declaration) }],
                toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
                maxOutputTokens: 512,
            },
            timeoutMs: ROUTER_TIMEOUT_MS,
        });
    } catch (err) {
        logger.warn('AITool', `判斷階段失敗，略過：${err.message}`);
        return NO_ACTION_RULE;
    }
    recordUsage('tools', response, { userId: ctx.userId, mode });

    const allowed = new Set(tools.map(t => t.declaration.name));
    const calls = (response.functionCalls ?? []).filter(c => allowed.has(c.name)).slice(0, MAX_CALLS);
    if (!calls.length) return NO_ACTION_RULE;

    // 依序執行：同一則訊息裡的動作可能有先後關係（例如先進語音再放歌）
    const results = [];
    for (const call of calls) results.push(await execute(call, ctx));

    const lines = results.map(r => `- ${r.label}：${r.ok ? '成功。' : '沒有執行，原因：'}${r.text}`);
    return `${RESULT_HEADER}\n${lines.join('\n')}\n${RESULT_RULE}`;
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
    _ALL_TOOLS: ALL_TOOLS,
    _textOnly: textOnly,
    _execute: execute,
};
