// handlers/ai/aiQuota.js
// AI 呼叫的用量閘門：在真正打 Gemini 之前檢查，避免單一使用者洗版或整體費用失控。
//
// 三道限制（皆可用環境變數調整，設為 0 代表不限制）：
//   AI_USER_RATE_LIMIT          每位使用者在 AI_USER_RATE_WINDOW_SEC 秒內最多幾次（預設 8 次 / 60 秒）
//   AI_USER_DAILY_TOKEN_BUDGET  每位使用者每日 token 上限（預設 0 = 不限）
//   AI_DAILY_TOKEN_BUDGET       全體每日 token 上限（預設 0 = 不限）
//
// 擁有者（OWNER_USER_ID）不受「單一使用者」的兩道限制，但仍受全體每日上限約束，
// 確保預算是真正的硬上限。

const { SlidingWindowRateLimiter } = require('../../utils/rateLimiter');
const { isOwner } = require('../../utils/config');
const { getTodayTotal, getTodayUserTotal } = require('./tokenTracker');

function envInt(name, fallback) {
    const n = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const USER_RATE_LIMIT     = envInt('AI_USER_RATE_LIMIT', 8);
const USER_RATE_WINDOW_MS = envInt('AI_USER_RATE_WINDOW_SEC', 60) * 1000;
const USER_DAILY_BUDGET   = envInt('AI_USER_DAILY_TOKEN_BUDGET', 0);
const DAILY_BUDGET        = envInt('AI_DAILY_TOKEN_BUDGET', 0);

const limiter = USER_RATE_LIMIT > 0 && USER_RATE_WINDOW_MS > 0
    ? new SlidingWindowRateLimiter(USER_RATE_LIMIT, USER_RATE_WINDOW_MS)
    : null;

class AiQuotaError extends Error {
    /**
     * @param {'rate'|'userDaily'|'daily'} reason
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
 */
function consumeQuota(userId) {
    if (DAILY_BUDGET > 0 && getTodayTotal() >= DAILY_BUDGET) {
        throw new AiQuotaError('daily');
    }
    if (!userId || isOwner(userId)) return;

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
        case 'daily':
            return '🪫 今天的 AI 總額度已用完，明天再來吧。';
        default:
            return '❌ AI 暫時無法使用。';
    }
}

function isQuotaError(err) {
    return err instanceof AiQuotaError;
}

function describeLimits() {
    const parts = [];
    parts.push(limiter ? `每人 ${USER_RATE_LIMIT} 次/${USER_RATE_WINDOW_MS / 1000}s` : '無頻率限制');
    if (USER_DAILY_BUDGET > 0) parts.push(`每人每日 ${USER_DAILY_BUDGET} tokens`);
    if (DAILY_BUDGET > 0) parts.push(`全體每日 ${DAILY_BUDGET} tokens`);
    return parts.join('、');
}

module.exports = { consumeQuota, quotaMessage, isQuotaError, AiQuotaError, describeLimits };
