// 注意：這個檔案只放常數，不要 require promptStore 等其他 AI 模組（會造成循環 require）
const toPositiveInt = (raw, fallback) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

// 與 promptStore.MODE_KEY_RE 相同（這裡不能 require promptStore）
const MODE_KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;
const USER_ID_RE = /^\d{17,20}$/;

// 預設人格代號：AI_DEFAULT_MODE 合法時用它，否則用 default
const rawDefault = process.env.AI_DEFAULT_MODE?.trim();
const DEFAULT_MODE = rawDefault && MODE_KEY_RE.test(rawDefault) ? rawDefault : 'default';
const DEFAULT_MODE_INVALID = rawDefault && !MODE_KEY_RE.test(rawDefault) ? rawDefault : null;

/**
 * 解析 AI_USER_MODE_OVERRIDES（使用者ID:模式代號,…）
 * 格式錯誤的項目放進 invalid（保留原字串）；同一個 id 出現兩次時以後面的為準，並記到 duplicates
 * 模式檔存不存在不在這裡檢查（不能 require promptStore），由 modeSelector 處理
 * @returns {{ map: Readonly<Record<string,string>>, invalid: string[], duplicates: string[] }}
 */
function parseUserModeOverrides(raw) {
    const map = {};
    const invalid = [];
    const duplicates = [];
    for (const item of String(raw ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
        const idx = item.indexOf(':');
        const id = idx === -1 ? '' : item.slice(0, idx).trim();
        const mode = idx === -1 ? '' : item.slice(idx + 1).trim();
        if (!USER_ID_RE.test(id) || !MODE_KEY_RE.test(mode)) {
            invalid.push(item);
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(map, id)) duplicates.push(id);
        map[id] = mode;
    }
    return { map: Object.freeze(map), invalid, duplicates };
}

const parsedOverrides = parseUserModeOverrides(process.env.AI_USER_MODE_OVERRIDES);

module.exports = {
    GENERATION_CONFIG: {
        maxOutputTokens: 1000,
        // Gemini 3 官方建議維持預設 1.0，調低可能出現重複迴圈或品質下降
        temperature: 1.0,
    },

    // AI 功能要有 GEMINI_API_KEY 才啟用（utils/features.js 的 ai 模組用同一個條件判斷）
    isAIEnabled: () => !!process.env.GEMINI_API_KEY?.trim(),

    // 找不到模式（或模式檔被刪除）時的預設人格；預設 default，可用 AI_DEFAULT_MODE 指定
    // modeSelector、aiCore、管理面板共用
    MODE_KEY_RE,
    DEFAULT_MODE,
    DEFAULT_MODE_INVALID,          // AI_DEFAULT_MODE 不合法時是原字串，否則 null（開機摘要警告用）

    // 指定某些使用者的預設人格（AI_USER_MODE_OVERRIDES）；/ai mode 的設定優先
    parseUserModeOverrides,
    USER_MODE_OVERRIDES: parsedOverrides.map,
    USER_MODE_OVERRIDE_ERRORS: Object.freeze({ invalid: parsedOverrides.invalid, duplicates: parsedOverrides.duplicates }),

    // ── 單一人格模式（Mode B）的群組歷史 ──
    GROUP_FETCH_LIMIT: 50,                                                    // Discord 單次上限 100
    GROUP_MSG_LIMIT: toPositiveInt(process.env.AI_GROUP_MSG_LIMIT, 24),       // 保留的訊息則數，可用環境變數調小
    GROUP_TIME_LIMIT_MS: 30 * 60 * 1000,                                      // 只看 30 分鐘內
    GROUP_IMAGE_MSGS: 3,                                                      // 只下載最後幾則訊息的圖片
    GROUP_TEXT_MAX: 400,                                                      // 每則訊息截斷字數
};
