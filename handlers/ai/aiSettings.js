// 注意：這個檔案只放常數，不要 require promptStore 等其他 AI 模組（會造成循環 require）
const toPositiveInt = (raw, fallback) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

module.exports = {
    GENERATION_CONFIG: {
        maxOutputTokens: 1000,
        // Gemini 3 官方建議維持預設 1.0，調低可能出現重複迴圈或品質下降
        temperature: 1.0,
    },
    LOVER_MODE_USER_IDS: process.env.LOVER_MODE_USER_IDS
        ? process.env.LOVER_MODE_USER_IDS.split(',').map(id => id.trim())
        : [],

    DEVELOPER_MODE_USER_IDS: process.env.DEVELOPER_MODE_USER_IDS
        ? process.env.DEVELOPER_MODE_USER_IDS.split(',').map(id => id.trim())
        : [],

    // 找不到模式（或模式檔被刪除）時的預設人格；modeSelector、aiCore、管理面板共用
    DEFAULT_MODE: 'loss',

    // ── 單一人格模式（Mode B）的群組歷史 ──
    GROUP_FETCH_LIMIT: 50,                                                    // Discord 單次上限 100
    GROUP_MSG_LIMIT: toPositiveInt(process.env.AI_GROUP_MSG_LIMIT, 24),       // 保留的訊息則數，可用環境變數調小
    GROUP_TIME_LIMIT_MS: 30 * 60 * 1000,                                      // 只看 30 分鐘內
    GROUP_IMAGE_MSGS: 3,                                                      // 只下載最後幾則訊息的圖片
    GROUP_TEXT_MAX: 400,                                                      // 每則訊息截斷字數
};
