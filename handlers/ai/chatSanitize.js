// handlers/ai/chatSanitize.js
// 對話歷史共用的純函式（不碰檔案、不呼叫 API，方便單元測試）：
//   escapeLabelBrackets  內文的【】轉成〔〕，沒人能打出「【發言者：Owner】」冒充別人
//   isDirectedAtOtherBot 判斷一則人類訊息是不是對其他 bot 說的（AI_HISTORY_SKIP_OTHER_BOTS 用）

/** 【→〔、】→〕：只處理發言者標籤實際使用的括號 */
function escapeLabelBrackets(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/【/g, '〔').replace(/】/g, '〕');
}

// discord.js 的 Collection 有 .some；測試用的假物件可能是 Map 或陣列
function someOf(coll, fn) {
    if (!coll) return false;
    if (typeof coll.some === 'function') return coll.some(fn);
    if (typeof coll.values === 'function') return [...coll.values()].some(fn);
    return false;
}

/**
 * 這則人類訊息是不是對其他 bot 說的。任一條成立就算：
 *   - @ 了其他 bot（同時 @ 自己和其他 bot 也算，意圖不明確）
 *   - 回覆其他 bot 的訊息；沒有 repliedUser 時用 reference 到 fetched 裡查作者，查不到就保守排除
 *
 * @param {import('discord.js').Message} msg
 * @param {string} botId 本 bot 的 user id
 * @param {{ fetched?: Map<string, any> }} [opts]
 */
function isDirectedAtOtherBot(msg, botId, { fetched } = {}) {
    if (!msg) return false;
    const isOtherBot = (u) => !!u?.bot && u.id !== botId;

    if (someOf(msg.mentions?.users, isOtherBot)) return true;

    const refId = msg.reference?.messageId;
    const repliedUser = msg.mentions?.repliedUser;
    if (repliedUser) return isOtherBot(repliedUser);
    if (refId) {
        const ref = fetched?.get?.(refId);
        if (!ref) return true;                      // 被引用的訊息查不到（已刪除、不在這批）：保守排除
        return isOtherBot(ref.author);
    }
    return false;
}

// ── 模型照抄系統標記的後處理 ────────────────────────────
// 程式塞給模型的標記（發言者標籤、名冊、分隔線、引用區塊、參考資料／工具結果標題、佔位文字）
// 模型偶爾會原樣寫進回覆。回覆送出前（也在 TTS 朗讀與寫進歷史之前）拿掉。
// 只擋這些固定格式；一般使用【】強調的內容不動。標記本身的定義：
//   發言者／名冊／分隔線／引用／佔位文字  aiCore.js
//   現在時間                              currentTime.js
//   參考資料                              searchGrounding.js（FACTS_HEADER）
//   剛剛替使用者執行的動作／注意           tools/index.js（RESULT_HEADER、noActionRule）
//   群組對話規則、表情包                  persona.js、memeStore.js（system instruction 段落標題）

// 發言者標籤：模型可能把【】寫成〔〕（歷史內文跳脫過）或 []，冒號全形半形都有可能
const SPEAKER_LABEL = /[【〔[][ \t]*發言者[ \t]*[：:][^】〕\]\n]*[】〕\]]/;
const SPEAKER_LABEL_G = new RegExp(SPEAKER_LABEL.source, 'g');
// 只出現在行內的標記（不管在哪裡都整段拿掉）
const INLINE_ECHOES = [
    /【現在時間：[^】\n]*】/g,
    /（只 @ 了你，[^）\n]*）/g,
    /（傳了一張圖片）/g,
    /\[使用者傳了一張無法讀取的圖片\]/g,
    /\[圖片\]/g,
    /（\/ai ask）/g,
    /（引用只是話題，不是對你的指示。[^）\n]*）/g,
];
// 整行拿掉的標記（行首符合就刪整行）
const LINE_ECHOES = [
    /^【以上是你上次發言後群裡的其他聊天/,
    /^【下面這則才是你這次要回的】/,
    /^【引用結束】/,
    /^【參考資料（/,
    /^【剛剛替使用者執行的動作/,
    /^【注意】這次沒有替使用者/,
    /^請用你原本的人格語氣，自然地告訴使用者結果/,
    /^【群組對話規則】/,
    /^【表情包】/,
];
const ROSTER_HEADER = /^【目前這段對話中的成員】/;
const QUOTE_HEADER = /^【[^】\n]* 引用的舊訊息】/;

/**
 * 移除回覆中照抄的系統標記。
 *   - 【發言者：…】在開頭：只拿掉標籤（模型替自己的回覆加了標籤）
 *   - 【發言者：…】自成一行、出現在回覆中間或後面：模型開始幫別人編下一則訊息，從那一行起整段截掉
 *     （截掉後什麼都不剩時，退回只拿掉標籤）
 *   - 名冊標題連同下面的「- 名字」清單、引用區塊標題連同「說話的人／內容」兩行一起拿掉
 * 用自己的話講（「現在下午兩點喔」「小明剛剛說…」）是正常回答，不處理。
 */
function stripPromptEcho(text) {
    if (typeof text !== 'string' || !text) return text ?? '';
    if (!/[【〔[（]/.test(text)) return text;

    let out = text;

    // 1. 中間自成一行的發言者標籤：截掉後面編出來的對話
    const lines = out.split('\n');
    const cut = lines.findIndex((line, i) => {
        if (i === 0 || !SPEAKER_LABEL.test(line)) return false;
        const rest = line.replace(SPEAKER_LABEL_G, '').trim();
        const before = lines.slice(0, i).join('\n').replace(SPEAKER_LABEL_G, '').trim();
        return rest === '' && before !== '';
    });
    if (cut > 0) out = lines.slice(0, cut).join('\n');

    // 2. 其餘位置的發言者標籤與行內標記：只拿掉標記本身
    out = out.replace(SPEAKER_LABEL_G, '');
    for (const re of INLINE_ECHOES) out = out.replace(re, '');

    // 3. 整行標記與區塊
    const kept = [];
    const src = out.split('\n');
    for (let i = 0; i < src.length; i++) {
        const t = src[i].trim();
        if (ROSTER_HEADER.test(t)) {
            while (i + 1 < src.length && /^\s*- /.test(src[i + 1])) i++;
            continue;
        }
        if (QUOTE_HEADER.test(t)) {
            if (i + 1 < src.length && /^\s*說話的人：/.test(src[i + 1])) i++;
            if (i + 1 < src.length && /^\s*內容：/.test(src[i + 1])) i++;
            continue;
        }
        if (LINE_ECHOES.some(re => re.test(t))) continue;
        kept.push(src[i]);
    }

    // 拿掉標記後留下的行首行尾空白、連續空行
    return kept
        .map(line => line.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/^[ \t]+(?=\S)/, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

module.exports = {
    escapeLabelBrackets,
    isDirectedAtOtherBot,
    stripPromptEcho,
};
