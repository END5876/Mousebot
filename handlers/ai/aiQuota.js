// handlers/ai/aiQuota.js
// AI 呼叫的用量閘門：在真正打 Gemini 之前檢查，避免單一使用者洗版或整體費用失控。
//
// 四道限制（皆可用環境變數調整，設為 0 代表不限制）：
//   AI_USER_RATE_LIMIT           每位使用者在 AI_USER_RATE_WINDOW_SEC 秒內最多幾次（預設 8 次 / 60 秒）
//   AI_USER_DAILY_TOKEN_BUDGET   每位使用者每日 token 上限
//   AI_GUILD_DAILY_TOKEN_BUDGET  每個伺服器每日 token 上限（私訊不算）
//   AI_DAILY_TOKEN_BUDGET        全體每日 token 上限
// 沒設定時：私人版三個每日上限都是 0（不限）；公開模式（PUBLIC_MODE=1）預設
// 每人 5 萬、每個伺服器 30 萬、全體 200 萬（見 utils/publicMode.js、docs/PUBLIC-MODE.md）。
//
// 擁有者（OWNER_USER_ID）不受「單一使用者」和「單一伺服器」的限制，但仍受全體每日上限約束，
// 確保預算是真正的硬上限。全體用量到 AI_BUDGET_WARN_PERCENT（預設 80）% 時先通知維運一次。

const { SlidingWindowRateLimiter } = require('../../utils/rateLimiter');
const { isOwner } = require('../../utils/config');
const { envIntByMode } = require('../../utils/publicMode');
const { getTodayTotal, getTodayUserTotal, getTodayGuildTotal } = require('./tokenTracker');
const { alert } = require('../../utils/alert');

function envInt(name, fallback) {
    const n = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const USER_RATE_LIMIT     = envInt('AI_USER_RATE_LIMIT', 8);
const USER_RATE_WINDOW_MS = envInt('AI_USER_RATE_WINDOW_SEC', 60) * 1000;
const USER_DAILY_BUDGET   = envIntByMode('AI_USER_DAILY_TOKEN_BUDGET', 0, 50_000);
const GUILD_DAILY_BUDGET  = envIntByMode('AI_GUILD_DAILY_TOKEN_BUDGET', 0, 300_000);
const DAILY_BUDGET        = envIntByMode('AI_DAILY_TOKEN_BUDGET', 0, 2_000_000);
const WARN_PERCENT        = Math.min(100, envInt('AI_BUDGET_WARN_PERCENT', 80));

const limiter = USER_RATE_LIMIT > 0 && USER_RATE_WINDOW_MS > 0
    ? new SlidingWindowRateLimiter(USER_RATE_LIMIT, USER_RATE_WINDOW_MS)
    : null;

class AiQuotaError extends Error {
    /**
     * @param {'rate'|'userDaily'|'guildDaily'|'daily'|'busy'} reason
     * @param {number} [retryAfterMs]
     */
    constructor(reason, retryAfterMs = 0) {
        super(`AI quota exceeded: ${reason}`);
        this.name = 'AiQuotaError';
        this.reason = reason;
        this.retryAfterMs = retryAfterMs;
    }
}

/**
 * 檢查並登記一次 AI 呼叫；超過限制時丟出 AiQuotaError。
 * 預算檢查在速率檢查之前，被預算擋下的呼叫不會佔用速率配額。
 * @param {string|null} userId
 * @param {string|null} [guildId] 私訊或不明時傳 null（不檢查伺服器上限）
 */
function consumeQuota(userId, guildId = null) {
    if (DAILY_BUDGET > 0) {
        const used = getTodayTotal();
        if (used >= DAILY_BUDGET) {
            // 全體預算用完＝今天所有人的 AI 都停了，通知維運（同一天最多一次）
            alert('ai-daily-budget', `今日 AI token 用量已達全體上限 ${DAILY_BUDGET.toLocaleString()}（AI_DAILY_TOKEN_BUDGET），今天的 AI 回覆暫停到額度重置`,
                { cooldownMs: 12 * 60 * 60 * 1000 });
            throw new AiQuotaError('daily');
        }
        if (WARN_PERCENT > 0 && used >= DAILY_BUDGET * WARN_PERCENT / 100) {
            alert('ai-daily-budget-warn', `今日 AI token 用量已達全體上限的 ${WARN_PERCENT}%（${used.toLocaleString()} / ${DAILY_BUDGET.toLocaleString()}），用完後今天的 AI 回覆會暫停`,
                { cooldownMs: 12 * 60 * 60 * 1000 });
        }
    }
    if (!userId || isOwner(userId)) return;

    if (GUILD_DAILY_BUDGET > 0 && guildId && getTodayGuildTotal(guildId) >= GUILD_DAILY_BUDGET) {
        throw new AiQuotaError('guildDaily');
    }
    if (USER_DAILY_BUDGET > 0 && getTodayUserTotal(userId) >= USER_DAILY_BUDGET) {
        throw new AiQuotaError('userDaily');
    }
    if (limiter) {
        const { allowed, retryAfterMs } = limiter.check(String(userId));
        if (!allowed) throw new AiQuotaError('rate', retryAfterMs);
    }
}

/** 給使用者看的提示文字 */
function quotaMessage(err) {
    switch (err?.reason) {
        case 'rate':
            return `⏳ 你問得太快了，請 ${Math.max(1, Math.ceil(err.retryAfterMs / 1000))} 秒後再試。`;
        case 'userDaily':
            return '🪫 你今天的 AI 額度已用完，明天再來吧。';
        case 'guildDaily':
            return '🪫 這個伺服器今天的 AI 額度已用完，明天再來吧。';
        case 'busy':
            return '⏳ AI 現在太忙了，請過一分鐘再試。';
        case 'daily':
            return '🪫 今天的 AI 總額度已用完，明天再來吧。';
        default:
            return '❌ AI 暫時無法使用。';
    }
}

// geminiClient 的 AiBusyError（排隊滿了、Gemini 一直回 429）也當成額度錯誤處理：
// 呼叫端原本就會對額度錯誤顯示 quotaMessage、隨機插話則安靜放棄，不用每個地方另外判斷。
// 用 name 判斷而不 require geminiClient，避免額度模組連帶載入 SDK。
function isQuotaError(err) {
    return err instanceof AiQuotaError || err?.name === 'AiBusyError';
}

function describeLimits() {
    const parts = [];
    parts.push(limiter ? `每人 ${USER_RATE_LIMIT} 次/${USER_RATE_WINDOW_MS / 1000}s` : '無頻率限制');
    if (USER_DAILY_BUDGET > 0) parts.push(`每人每日 ${USER_DAILY_BUDGET} tokens`);
    if (GUILD_DAILY_BUDGET > 0) parts.push(`每個伺服器每日 ${GUILD_DAILY_BUDGET} tokens`);
    if (DAILY_BUDGET > 0) parts.push(`全體每日 ${DAILY_BUDGET} tokens`);
    return parts.join('、');
}

/** 目前的限制數值（0 = 不限制；管理面板顯示用） */
function getLimits() {
    return {
        userRateLimit: limiter ? USER_RATE_LIMIT : 0,
        userRateWindowSec: USER_RATE_WINDOW_MS / 1000,
        userDailyBudget: USER_DAILY_BUDGET,
        guildDailyBudget: GUILD_DAILY_BUDGET,
        dailyBudget: DAILY_BUDGET,
    };
}

module.exports = { consumeQuota, quotaMessage, isQuotaError, AiQuotaError, describeLimits, getLimits };
