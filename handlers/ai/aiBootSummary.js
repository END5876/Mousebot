// handlers/ai/aiBootSummary.js（MouseBot 與 mousebot-lite 共用，兩邊內容相同）
// 開機摘要裡的 AI 那幾列。

const promptStore = require('./promptStore');
const persona = require('./persona');
const { listMemes, listLibraries, publicBase } = require('./memeStore');
const bootSummary = require('../../utils/bootSummary');
const { DEFAULT_MODE, DEFAULT_MODE_INVALID, USER_MODE_OVERRIDE_ERRORS } = require('./aiSettings');
const { describeLimits } = require('./aiQuota');
const { MODEL_NAME } = require('./geminiClient');
const { ENABLED_GUILD_IDS: SEARCH_GUILD_IDS } = require('./searchGrounding');

const modeSelector = () => require('./modeSelector');
// 範圍鎖定：persona 在模組載入時就算好了，之後不會變
const getLock = () => persona.getLock();

// ════════════════════════════════════════════════════════
//  開機摘要
// ════════════════════════════════════════════════════════
// 預設人格與固定人格（AI_DEFAULT_MODE／AI_USER_MODE_OVERRIDES）的設定問題（不鎖定時）
// 只列模式代號，不印使用者 ID
function describePersonaWarnings() {
    const warnings = [];
    if (DEFAULT_MODE_INVALID) warnings.push(`AI_DEFAULT_MODE=${DEFAULT_MODE_INVALID} 不合法，改用 default`);
    if (!promptStore.getMode(DEFAULT_MODE)) {
        warnings.push(`預設人格 data/prompts/modes/${DEFAULT_MODE}.md 不存在，沒選人格的人會沒有人格`);
    }
    const { invalid, duplicates } = USER_MODE_OVERRIDE_ERRORS;
    if (invalid.length) warnings.push(`AI_USER_MODE_OVERRIDES 有 ${invalid.length} 筆格式錯誤`);
    if (duplicates.length) warnings.push(`AI_USER_MODE_OVERRIDES 有 ${duplicates.length} 筆重複的使用者（以後面的為準）`);
    const missing = [...new Set(Object.values(modeSelector().listFixedUserModes()))].filter((m) => !promptStore.getMode(m));
    for (const m of missing) warnings.push(`固定人格 ${m} 不存在，那些人改用 ${DEFAULT_MODE}`);
    return warnings;
}

const MEME_SEND_TEXT = () => (publicBase()
    ? `送網址（${publicBase()}）`
    : '送附件（手機版會拉滿寬度；設 MEME_PUBLIC_URL=https://… 改送網址）');

function reportBootSummary() {
    const searchText = `搜尋接地：${SEARCH_GUILD_IDS.size ? `${SEARCH_GUILD_IDS.size} 個伺服器` : '停用'}`;

    if (getLock()) {
        // 單一人格：人格檔不存在時用內建的通用人格（warn）；表情包那一列一律顯示
        const key = persona.getPersonaKey();
        const hasFile = persona.hasPersonaFile();
        const personaText = hasFile
            ? `人格：${persona.getPersonaName()}（${key}）`
            : `找不到 data/prompts/modes/${key}.md，使用內建的通用人格`;
        bootSummary.report(
            'AI 對話 (/ai)',
            hasFile ? 'ok' : 'warn',
            `Gemini (${MODEL_NAME}) 單一人格；${personaText}；額度：${describeLimits()}；${searchText}`
        );
        const memeCount = listMemes(key).length;
        bootSummary.report(
            'AI 表情包',
            memeCount ? 'ok' : 'off',
            memeCount
                ? `${memeCount} 張，${MEME_SEND_TEXT()}`
                : `沒有圖庫（data/memes/${key}/），要用請跑 node examples/memes/importNekowhale.js --persona ${key}（見 README「表情包」）`
        );
        return;
    }

    const personaWarnings = describePersonaWarnings();
    bootSummary.report(
        'AI 對話 (/ai)',
        personaWarnings.length ? 'warn' : 'ok',
        `Gemini (${MODEL_NAME}) 已連線，${modeSelector().getAvailableModes().length} 種人格模式可用；額度：${describeLimits()}；` +
        searchText +
        personaWarnings.map((w) => `；${w}`).join('')
    );
    // 多人格時每個人格各自的圖庫；一個都沒有就不顯示這一列
    const libs = listLibraries();
    if (libs.length > 0) {
        bootSummary.report(
            'AI 表情包',
            'ok',
            `${libs.map(l => `${l.key} ${l.count} 張`).join('、')}，${MEME_SEND_TEXT()}`
        );
    }
}

module.exports = {
  reportBootSummary,
};
