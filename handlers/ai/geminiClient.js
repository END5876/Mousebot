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

const { GoogleGenAI, HarmCategory, HarmBlockThreshold, ThinkingLevel } = require('@google/genai');

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const MODEL_NAME        = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
const VISION_MODEL_NAME = process.env.GEMINI_VISION_MODEL?.trim() || MODEL_NAME;

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
            ...(supportsThinkingLevel(model) ? { thinkingConfig: THINKING_CONFIG } : {}),
            ...config,
            ...(systemInstruction ? { systemInstruction } : {}),
            safetySettings: SAFETY_SETTINGS,
            ...(signal ? { abortSignal: signal } : {}),
            ...(timeoutMs ? { httpOptions: { timeout: timeoutMs } } : {}),
        },
    });
}

module.exports = { generate, MODEL_NAME, VISION_MODEL_NAME };
