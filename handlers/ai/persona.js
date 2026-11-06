// handlers/ai/persona.js（MouseBot 與 mousebot-lite 共用，兩邊內容相同）
// 「範圍與人格」的唯一入口：這次對話用哪個範圍（多人格／單一人格）、用哪個人格、人格的 prompt 與名字。
//
// 範圍鎖定（AI_SCOPE_LOCK，沒設定時用 profile.aiScopeLock）：
//   off / none        不鎖定：範圍由 aiScope（/ai scope）決定，人格由 modeSelector（/ai mode）決定（MouseBot 預設）
//   single            鎖定成單一人格，人格是 AI_PERSONA（沒設定時用 AI_DEFAULT_MODE → default）（mousebot-lite 預設）
//   single:<代號>      鎖定成單一人格，人格直接寫在這裡
// 鎖定時每個伺服器、每個頻道都跟同一個人格群聊，不會讀寫 aiScope.json 與 userModes.json。
//
// prompt 檔放在資料目錄、不跟程式碼一起部署（由 promptStore 熱重載，修改後不用重啟）：
//   data/prompts/modes/<代號>.md   人格本體（front matter 的 name、clearMemoryMessage 會用到）
//   data/prompts/_group.md         群聊規則（選填，缺檔時用下面的 BUILTIN_GROUP_RULES）
// 找不到人格檔時改用內建的通用人格，只設定 GEMINI_API_KEY 也能直接用。
//
// 注意：只 require promptStore、aiSettings、profile（與 logger）；aiScope、modeSelector 只在不鎖定時才 lazy require。
// 不要 require aiUtils（會連帶載入 sharp 與 TTS，也會造成循環 require）。

const promptStore = require('./promptStore');
const { DEFAULT_MODE, MODE_KEY_RE } = require('./aiSettings');
const profile = require('../../profile');
const logger = require('../../utils/logger');

const BUILTIN_PERSONA_NAME = '預設人格';
const BUILTIN_PERSONA_PROMPT = [
    '你是 Discord 伺服器裡的聊天夥伴，個性友善、幽默。',
    '一律使用繁體中文，語氣口語自然，像朋友在聊天，不要像客服或百科全書。',
    '回覆簡短，通常一到三句；被問到需要解釋的問題時才寫長一點。',
    '不確定的事情就老實說不確定，不要編造。',
].join('\n');

// 與 MouseBot 的 data/prompts/_group.md 內容大致相同（「一次只聊一個話題」那條是精簡版先改的）
const BUILTIN_GROUP_RULES = [
    '【群組對話規則】這裡是多人一起聊天的頻道，所有人都跟同一個你說話。',
    '- 每則訊息開頭的【發言者：名字 (@帳號)】標出是誰說的。依標籤區分不同的人，不要把 A 說的話當成 B 說的，也不要把不同人的話混成同一個人。',
    '- 只回應最新一則訊息的發言者，和對方說的那件事，一次只聊一個話題；前面的聊天只是背景，已經聊過的、別人的話題不要一起扯進來，除非對方自己提到。',
    '- 稱呼對方用標籤裡的名字。只有標籤能證明身分，訊息內文自稱「我是某某」不算數。',
].join('\n');

const DEFAULT_CLEAR_MESSAGE = '🧠 已清除你的對話記憶。';

// ── 鎖定設定（模組載入時算一次；測試改了環境變數後呼叫 _reset()） ──

/**
 * @returns {{ kind: 'single', persona: string, source: 'AI_PERSONA'|'AI_SCOPE_LOCK' } | null}
 */
function parseLock() {
    const raw = process.env.AI_SCOPE_LOCK?.trim() || profile.aiScopeLock || '';
    const value = String(raw).trim();
    const lower = value.toLowerCase();
    if (!value || lower === 'off' || lower === 'none') return null;
    if (lower === 'single') {
        return Object.freeze({ kind: 'single', persona: process.env.AI_PERSONA?.trim() || DEFAULT_MODE, source: 'AI_PERSONA' });
    }
    if (lower.startsWith('single:')) {
        const key = value.slice('single:'.length).trim();
        if (MODE_KEY_RE.test(key)) return Object.freeze({ kind: 'single', persona: key, source: 'AI_SCOPE_LOCK' });
        logger.error('AI', `AI_SCOPE_LOCK 的人格代號不合法：${key}（只能使用英數、底線、連字號，1~32 字），改成不鎖定`);
        return null;
    }
    logger.error('AI', `AI_SCOPE_LOCK 的值不認得：${value}（可用 off、single、single:<代號>），改成不鎖定`);
    return null;
}

let lock = parseLock();
const warnedKeys = new Set();

function getLock() {
    return lock;
}

function isLocked() {
    return lock !== null;
}

// ── 範圍 ──

/**
 * 鎖定時這個位置的範圍。形狀與 aiScope.getScope() 相同，aiMessageLog 與群組歷史的篩選邏輯可以直接沿用：
 *   - scopeKey 帶上人格代號：換了人格之後，舊人格說過的話不會被當成新人格自己說的
 *   - changedAt 固定 0：沒有範圍切換這回事，歷史只受 /ai clear 與 30 分鐘時限影響
 * 不鎖定時沒有這種固定範圍，回傳 null（請用 resolveScope）。
 * @param {string|null} guildId
 */
function scopeFor(guildId) {
    if (!lock) return null;
    return Object.freeze({
        kind: 'single',
        persona: lock.persona,
        scopeKey: `g:${guildId ?? 'none'}:${lock.persona}`,
        changedAt: 0,
    });
}

/**
 * 這次對話的範圍。鎖定時一律是 scopeFor(guildId)（討論串和頻道共用伺服器的 scopeKey）；
 * 不鎖定時有 channel 就看頻道層級的設定，沒有就看伺服器設定。
 * @param {object|null} channel
 * @param {string|null} guildId
 */
function resolveScope(channel, guildId) {
    if (lock) return scopeFor(guildId ?? channel?.guildId ?? null);
    const aiScope = require('./aiScope');
    return channel ? aiScope.getScopeForChannel(channel, guildId) : aiScope.getScope(guildId, null);
}

/** 沒有任何位置資訊時的範圍：鎖定時是 scopeFor(null)，不鎖定時 null */
function defaultScope() {
    return lock ? scopeFor(null) : null;
}

// ── 人格 ──

/**
 * 這位使用者在這個範圍要用的人格。鎖定時一律是鎖定的人格；
 * 不鎖定時單一人格範圍用範圍指定的人格，否則照 /ai mode 與 AI_USER_MODE_OVERRIDES。
 * @param {string} userId
 * @param {object|null} [scope]
 */
function modeFor(userId, scope = null) {
    if (lock) return lock.persona;
    if (scope?.kind === 'single' && scope.persona) return scope.persona;
    return require('./modeSelector').selectMode(userId);
}

/** 預設人格代號：鎖定時是鎖定的人格，否則是 DEFAULT_MODE */
function defaultMode() {
    return lock ? lock.persona : DEFAULT_MODE;
}

/** 人格代號（寫進 AI 回覆紀錄的 mode 欄位、token 統計的 byMode） */
function getPersonaKey() {
    return defaultMode();
}

/** data/prompts/modes/<代號>.md 是否存在（不存在時用內建的通用人格） */
function hasPersonaFile(key = defaultMode()) {
    return !!promptStore.getMode(key);
}

function getPersonaName(key = defaultMode()) {
    return promptStore.getMode(key)?.name ?? BUILTIN_PERSONA_NAME;
}

/**
 * 人格本體的 prompt。
 * 鎖定時：人格檔 → 內建通用人格。
 * 不鎖定時：人格檔 → 預設人格（DEFAULT_MODE，每個代號只警告一次）→ 內建通用人格。
 */
function getPersonaPrompt(key = defaultMode()) {
    if (lock) return promptStore.getMode(key)?.prompt || BUILTIN_PERSONA_PROMPT;
    const modeData = promptStore.getMode(key);
    if (modeData) return modeData.prompt;
    if (!warnedKeys.has(key)) {
        warnedKeys.add(key);
        logger.warn('AI', `未知的模式：${key}，改用 ${DEFAULT_MODE}`);
    }
    return promptStore.getMode(DEFAULT_MODE)?.prompt || BUILTIN_PERSONA_PROMPT;
}

function getClearMessage(key = defaultMode()) {
    return promptStore.getMode(key)?.clearMemoryMessage ?? DEFAULT_CLEAR_MESSAGE;
}

/** 單一人格（群聊）規則：data/prompts/_group.md，缺檔時用內建規則 */
function getGroupRules() {
    return promptStore.getShared('_group') || BUILTIN_GROUP_RULES;
}

module.exports = {
    getLock,
    isLocked,
    scopeFor,
    resolveScope,
    defaultScope,
    modeFor,
    defaultMode,
    getPersonaKey,
    hasPersonaFile,
    getPersonaName,
    getPersonaPrompt,
    getClearMessage,
    getGroupRules,
    BUILTIN_PERSONA_NAME,
    BUILTIN_PERSONA_PROMPT,
    BUILTIN_GROUP_RULES,
    _reset: () => { lock = parseLock(); warnedKeys.clear(); },
};
