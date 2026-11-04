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

module.exports = {
    escapeLabelBrackets,
    isDirectedAtOtherBot,
};
