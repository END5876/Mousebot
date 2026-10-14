// handlers/ai/geminiClient.js
// 所有 Gemini 呼叫共用的唯一入口（@google/genai）。
//
// 過去 aiCore.js / gugugagaGenerator.js / splitbill/utils/billScanner.js 各自 new 一個
// GoogleGenerativeAI（舊版 @google/generative-ai，官方已停止維護）、各自寫死一份
// MODEL_NAME 與 safetySettings。現在統一由這裡提供：
//   - 模型名稱：環境變數 GEMINI_MODEL（未設定時用 DEFAULT_MODEL）
//   - 帳單辨識可另外用 GEMINI_VISION_MODEL 指定（未設定時沿用 GEMINI_MODEL）
//   - 共用的 safetySettings
//   - generate()：包好 systemInstruction / 逾時 / AbortSignal 的 generateContent

const { GoogleGenAI, HarmCategory, HarmBlockThreshold } = require('@google/genai');

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const MODEL_NAME        = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
const VISION_MODEL_NAME = process.env.GEMINI_VISION_MODEL?.trim() || MODEL_NAME;

const SAFETY_SETTINGS = [
    HarmCategory.HARM_CATEGORY_HARASSMENT,
    HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
].map(category => ({ category, threshold: HarmBlockThreshold.BLOCK_NONE }));

let client = null;
function getClient() {
    if (!process.env.GEMINI_API_KEY) {
        throw new Error('尚未設定 GEMINI_API_KEY');
    }
    if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    return client;
}

/**
 * @param {object} opts
 * @param {Array|string} opts.contents          Gemini contents（[{ role, parts }]）或純文字
 * @param {string} [opts.systemInstruction]
 * @param {object} [opts.config]                 generationConfig 欄位（temperature、maxOutputTokens、responseMimeType...）
 * @param {string} [opts.model]                  預設 MODEL_NAME
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<import('@google/genai').GenerateContentResponse>}
 *          回傳值的 .text 是 getter（不是函式），.usageMetadata 給 tokenTracker 用
 */
async function generate({ contents, systemInstruction, config = {}, model = MODEL_NAME, signal, timeoutMs }) {
    return getClient().models.generateContent({
        model,
        contents,
        config: {
            ...config,
            ...(systemInstruction ? { systemInstruction } : {}),
            safetySettings: SAFETY_SETTINGS,
            ...(signal ? { abortSignal: signal } : {}),
            ...(timeoutMs ? { httpOptions: { timeout: timeoutMs } } : {}),
        },
    });
}

module.exports = { generate, MODEL_NAME, VISION_MODEL_NAME };
