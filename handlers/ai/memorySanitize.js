// handlers/ai/memorySanitize.js
// 長期記憶與群組歷史共用的純函式（不碰檔案、不呼叫 API，方便單元測試）：
//   escapeLabelBrackets  內文的【】轉成〔〕，沒人能打出「【發言者：Owner】」冒充別人
//   sanitizeFact         事實文字清理：去換行、跳脫標籤、截斷
//   INJECTION_RE         擋下想改變 Bot 身分／規則的指令注入句
//   hasInjection         先 NFKC、去零寬字元再比對 INJECTION_RE（請用這個）
//   hasLinkOrMention     擋下網址、提及、邀請連結
//   normalizeForHash     比對用的正規化（全形轉半形、去空白、小寫）
//   factHash             tombstone 用的雜湊
//   verifyEvidence       驗證模型給的 evidence 真的逐字出自原文
//   isDirectedAtOtherBot 判斷一則人類訊息是不是對其他 bot 說的（這種訊息不送進萃取）
//   parseIgnorePrefixes  解析 MEMORY_IGNORE_PREFIXES（常見 bot 指令前綴）

const crypto = require('crypto');
const { MEMORY_CAPS } = require('./aiSettings');

const DEFAULT_FACT_MAX = MEMORY_CAPS.factChars;
const DEFAULT_IGNORE_PREFIXES = ['!', '?', '$', '%', '-', '.', ';'];

/** 【→〔、】→〕：只處理發言者標籤實際使用的括號 */
function escapeLabelBrackets(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/【/g, '〔').replace(/】/g, '〕');
}

// 指令注入：要求忽略規則、改變身分或長期行為的句子。
// 與計畫草稿相比，「從現在起」「以後要」「扮演」「是」都要求對象是 Bot（你／妳／Bot／機器人／AI），
// 避免誤殺「以後要去日本」「從現在開始戒菸」「喜歡角色扮演遊戲」這類正常事實。
// 萃取出的事實多半是第三人稱（「要求Bot以後都要…」），所以對象也接受 Bot／機器人／AI；
// 觸發詞和對象之間允許夾幾個空白或標點（「從現在起，你…」）。
// 請用 hasInjection() 檢查：它會先做 NFKC 並去掉零寬字元，直接用 INJECTION_RE.test 可被零寬字元繞過。
const T = String.raw`(?:你|妳|\bbot\b|機器人|\bai\b)`;
const GAP = String.raw`[\s，,、:：。.!！]{0,3}`;
const INJECTION_RE = new RegExp([
    String.raw`(?:忽略|無視|ignore|disregard).{0,20}(?:指令|規則|設定|prompt|instruction)`,
    String.raw`system\s*prompt`,
    `從現在(?:起|開始)${GAP}${T}`,
    `以後${GAP}${T}${GAP}(?:都)?(?:要|必須|只能)`,
    `${T}${GAP}以後(?:都)?(?:要|必須|只能)`,
    '以後(?:的)?(?:回答|回覆|回話)(?:都)?(?:要|必須|只能)',
    `(?:要求|命令)${T}`,
    `(?:請|${T})(?:要|來|現在)?(?:改)?扮演`,
    '扮演成',
    `${T}現在(?:是|變成|成為)`,
    '(?:你|妳)(?:變成|成為|就是)',
    '(?:你|妳)是(?:一[隻個位名]|我的)',
    '越獄|jailbreak',
    String.raw`you\s+are\s+now`,
    String.raw`from\s+now\s+on`,
    String.raw`pretend\s+(?:to\s+be|you\s+are)`,
].join('|'), 'i');

// 零寬字元與軟連字號：插在關鍵字中間就能繞過正則
const INVISIBLE_RE = /[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/g;

/** 指令注入檢查：NFKC（全形轉半形）、去零寬字元後再比對 INJECTION_RE */
function hasInjection(text) {
    if (typeof text !== 'string' || !text) return false;
    return INJECTION_RE.test(text.normalize('NFKC').replace(INVISIBLE_RE, ''));
}

const LINK_OR_MENTION_RE = /https?:\/\/|www\.|discord(?:app)?\.(?:gg|com\/invite)\/|<@[!&]?\d+>|<#\d+>|@everyone|@here/i;

function hasLinkOrMention(text) {
    return typeof text === 'string' && LINK_OR_MENTION_RE.test(text);
}

/**
 * 事實文字清理：換行與連續空白壓成一個空白、跳脫【】、截到 maxChars 字（以字元計，不切壞 emoji）
 * @returns {string} 清理後的文字；沒有內容時回傳 ''
 */
function sanitizeFact(text, maxChars = DEFAULT_FACT_MAX) {
    if (typeof text !== 'string') return '';
    const cleaned = escapeLabelBrackets(text).replace(/\s+/g, ' ').trim();
    const chars = [...cleaned];
    return chars.length > maxChars ? chars.slice(0, maxChars).join('').trim() : cleaned;
}

/** 比對用：NFKC（全形英數轉半形）、去掉所有空白、小寫 */
function normalizeForHash(text) {
    if (typeof text !== 'string') return '';
    return text.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/** tombstone 用：正規化後取 sha1 */
function factHash(text) {
    return crypto.createHash('sha1').update(normalizeForHash(text)).digest('hex');
}

/**
 * evidence 經過正規化後必須是原文的子字串（至少 2 個字，避免空字串或單字元恆成立）
 */
function verifyEvidence(evidence, sourceText) {
    const ev = normalizeForHash(evidence);
    if ([...ev].length < 2) return false;
    return normalizeForHash(sourceText).includes(ev);
}

/**
 * 解析 MEMORY_IGNORE_PREFIXES：未設定用預設值；空字串（或只有空白）＝關閉
 * @param {string|undefined} [raw]
 * @returns {string[]}
 */
function parseIgnorePrefixes(raw = process.env.MEMORY_IGNORE_PREFIXES) {
    if (raw === undefined || raw === null) return [...DEFAULT_IGNORE_PREFIXES];
    return String(raw).split(',').map(p => p.trim()).filter(Boolean);
}

// discord.js 的 Collection 有 .some；測試用的假物件可能是 Map 或陣列
function someOf(coll, fn) {
    if (!coll) return false;
    if (typeof coll.some === 'function') return coll.some(fn);
    if (typeof coll.values === 'function') return [...coll.values()].some(fn);
    return false;
}

/**
 * 這則人類訊息是不是對其他 bot 說的（只用在萃取；群組歷史仍保留這些訊息當上下文）。
 * 任一條成立就算：
 *   - @ 了其他 bot（同時 @ 自己和其他 bot 也算，意圖不明確）
 *   - 回覆其他 bot 的訊息；沒有 repliedUser 時用 reference 到 fetched 裡查作者，查不到就保守排除
 *   - 開頭是常見的 bot 指令前綴（!play、$daily…）
 *
 * @param {import('discord.js').Message} msg
 * @param {string} botId 本 bot 的 user id
 * @param {{ fetched?: Map<string, any>, ignorePrefixes?: string[] }} [opts]
 */
function isDirectedAtOtherBot(msg, botId, { fetched, ignorePrefixes = parseIgnorePrefixes() } = {}) {
    if (!msg) return false;
    const isOtherBot = (u) => !!u?.bot && u.id !== botId;

    if (someOf(msg.mentions?.users, isOtherBot)) return true;

    const refId = msg.reference?.messageId;
    const repliedUser = msg.mentions?.repliedUser;
    if (repliedUser) {
        if (isOtherBot(repliedUser)) return true;
    } else if (refId) {
        const ref = fetched?.get?.(refId);
        if (!ref) return true;                      // 被引用的訊息查不到（已刪除、不在這批）：保守排除
        if (isOtherBot(ref.author)) return true;
    }

    const content = (msg.content ?? '').trimStart();
    if (content && ignorePrefixes.some(p => content.startsWith(p))) return true;

    return false;
}

module.exports = {
    escapeLabelBrackets,
    sanitizeFact,
    INJECTION_RE,
    hasInjection,
    hasLinkOrMention,
    normalizeForHash,
    factHash,
    verifyEvidence,
    parseIgnorePrefixes,
    isDirectedAtOtherBot,
    DEFAULT_IGNORE_PREFIXES,
    DEFAULT_FACT_MAX,
};
