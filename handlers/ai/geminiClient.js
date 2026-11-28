// handlers/ai/geminiClient.js
// 所有 Gemini 呼叫共用的唯一入口（@google/genai）。
//
// 過去 aiCore.js / gugugagaGenerator.js / splitbill/utils/billScanner.js 各自 new 一個
// GoogleGenerativeAI（舊版 @google/generative-ai，官方已停止維護）、各自寫死一份
// MODEL_NAME 與 safetySettings。現在統一由這裡提供：
//   - 模型名稱：環境變數 GEMINI_MODEL（未設定時用 DEFAULT_MODEL）
//   - 帳單辨識可另外用 GEMINI_VISION_MODEL 指定（未設定時沿用 GEMINI_MODEL）
//   - 共用的 safetySettings
//   - Gemini 3 系列固定 thinkingLevel: minimal（見 THINKING_CONFIG）
//   - generate()：包好 systemInstruction / 逾時 / AbortSignal 的 generateContent
//   - 忙碌處理（見下方「重試與排隊」）

const { GoogleGenAI, HarmCategory, HarmBlockThreshold, ThinkingLevel } = require('@google/genai');
const { envIntByMode } = require('../../utils/publicMode');

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const MODEL_NAME        = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
const VISION_MODEL_NAME = process.env.GEMINI_VISION_MODEL?.trim() || MODEL_NAME;

// 沒有指定 timeoutMs 的呼叫都套用這個上限：Gemini 卡住時不能讓使用者一直等、請求一直佔著
const DEFAULT_TIMEOUT_MS = 60_000;

const SAFETY_SETTINGS = [
    HarmCategory.HARM_CATEGORY_HARASSMENT,
    HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
].map(category => ({ category, threshold: HarmBlockThreshold.BLOCK_NONE }));

// 思考 token 會算進 maxOutputTokens（語音只給 150）。3.1 Flash-Lite 預設就是 minimal，
// 但其他 Gemini 3 模型預設是 high，換 GEMINI_MODEL 時可能整段被思考吃掉，所以明確指定。
// 2.x 不支援 thinkingLevel，只對 gemini-3 系列帶；呼叫端的 config 可以覆蓋
const THINKING_CONFIG = { thinkingLevel: ThinkingLevel.MINIMAL };
const supportsThinkingLevel = model => /^gemini-3/.test(model);

let client = null;
function getClient() {
    if (!process.env.GEMINI_API_KEY) {
        throw new Error('尚未設定 GEMINI_API_KEY');
    }
    if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    return client;
}

// ════════════════════════════════════════════════════════
//  重試與排隊
// ════════════════════════════════════════════════════════
// 重試：Gemini 明確回 429（太多請求）或 5xx 時，等一下再送，最多 AI_RETRY_ATTEMPTS 次（含第一次，預設 3）。
//   只重試這些狀態碼；逾時、網路錯誤、400 類錯誤都不重試（逾時重試會讓使用者多等好幾倍的時間）。
//   SDK 內建的 retryOptions 連逾時也會重試，所以不用它。
// 排隊：AI_MAX_CONCURRENT 限制同時送出的請求數，超過的排隊；排隊超過 AI_QUEUE_MAX 筆就直接回「太忙」。
//   私人版預設 0＝不限（和以前一樣）；公開模式預設同時 8 筆、排隊 50 筆。
// 重試後還是 429／503，或排隊滿了，丟 AiBusyError（aiQuota.isQuotaError 認得它，呼叫端會顯示「AI 現在太忙」）。
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const BUSY_STATUSES  = new Set([429, 503]);
const RETRY_BASE_MS  = 1000;
const RETRY_MAX_MS   = 4000;

function retryAttempts() {
    return Math.max(1, envIntByMode('AI_RETRY_ATTEMPTS', 3, 3));
}
function maxConcurrent() {
    return envIntByMode('AI_MAX_CONCURRENT', 0, 8);
}
function queueMax() {
    return envIntByMode('AI_QUEUE_MAX', 50, 50);
}

class AiBusyError extends Error {
    constructor(message = 'Gemini 忙碌中', cause = undefined) {
        super(message, cause ? { cause } : undefined);
        this.name = 'AiBusyError';
        this.reason = 'busy';   // 和 AiQuotaError 一樣，quotaMessage 用 reason 決定提示文字
    }
}

let active = 0;
const waiting = [];   // 等待中的 { resolve, reject, signal, onAbort }

function acquire(signal) {
    const limit = maxConcurrent();
    if (limit <= 0) return Promise.resolve(false);   // 不限：不佔名額
    if (active < limit) {
        active++;
        return Promise.resolve(true);
    }
    if (waiting.length >= queueMax()) return Promise.reject(new AiBusyError('AI 排隊已滿'));
    return new Promise((resolve, reject) => {
        const entry = { resolve, reject, signal, onAbort: null };
        if (signal) {
            entry.onAbort = () => {
                const i = waiting.indexOf(entry);
                if (i >= 0) waiting.splice(i, 1);
                reject(signal.reason ?? new Error('aborted'));
            };
            signal.addEventListener('abort', entry.onAbort, { once: true });
        }
        waiting.push(entry);
    });
}

function release(held) {
    if (!held) return;
    const next = waiting.shift();
    if (next) {
        // 名額直接交給下一位，active 不變
        if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
        next.resolve(true);
    } else {
        active--;
    }
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
        const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
        const onAbort = () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function backoffMs(attempt) {
    const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
    return Math.round(base / 2 + Math.random() * base / 2);   // 加隨機量，避免大家同時重送
}

/**
 * 依照「重試與排隊」規則執行一次 API 呼叫
 * @template T
 * @param {() => Promise<T>} call
 * @param {AbortSignal} [signal]
 * @param {{ sleep?: typeof sleep }} [deps] 測試用
 * @returns {Promise<T>}
 */
async function withRetryAndQueue(call, signal, deps = {}) {
    const wait = deps.sleep ?? sleep;
    const held = await acquire(signal);
    try {
        const attempts = retryAttempts();
        for (let attempt = 1; ; attempt++) {
            try {
                return await call();
            } catch (err) {
                const status = Number(err?.status);
                if (!RETRY_STATUSES.has(status) || signal?.aborted) throw err;
                if (attempt >= attempts) {
                    if (BUSY_STATUSES.has(status)) throw new AiBusyError(`Gemini 回應 ${status}，重試 ${attempts} 次仍失敗`, err);
                    throw err;
                }
                await wait(backoffMs(attempt), signal);
            }
        }
    } finally {
        release(held);
    }
}

/**
 * @param {object} opts
 * @param {Array|string} opts.contents          Gemini contents（[{ role, parts }]）或純文字
 * @param {string} [opts.systemInstruction]
 * @param {object} [opts.config]                 generationConfig 欄位（temperature、maxOutputTokens、responseMimeType...）
 * @param {string} [opts.model]                  預設 MODEL_NAME
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs]             預設 DEFAULT_TIMEOUT_MS
 * @returns {Promise<import('@google/genai').GenerateContentResponse>}
 *          回傳值的 .text 是 getter（不是函式），.usageMetadata 給 tokenTracker 用
 */
async function generate({ contents, systemInstruction, config = {}, model = MODEL_NAME, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    return withRetryAndQueue(() => getClient().models.generateContent({
        model,
        contents,
        config: {
            ...(supportsThinkingLevel(model) ? { thinkingConfig: THINKING_CONFIG } : {}),
            ...config,
            ...(systemInstruction ? { systemInstruction } : {}),
            safetySettings: SAFETY_SETTINGS,
            ...(signal ? { abortSignal: signal } : {}),
            httpOptions: { timeout: timeoutMs },
        },
    }), signal);
}

/** 目前送出中／排隊中的請求數（管理面板、測試用） */
function queueStats() {
    return { active, waiting: waiting.length, maxConcurrent: maxConcurrent(), queueMax: queueMax() };
}

module.exports = {
    generate, DEFAULT_TIMEOUT_MS, MODEL_NAME, VISION_MODEL_NAME,
    AiBusyError, queueStats,
    _internal: { withRetryAndQueue },
};
