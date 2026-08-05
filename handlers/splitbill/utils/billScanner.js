'use strict';

/**
 * 帳單圖片辨識（透過 Gemini Vision）
 * 讓使用者在「新增花費」時可直接上傳帳單/收據照片，
 * 由 AI 自動判讀項目名稱、金額與幣別，減少手動輸入。
 */

const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold, GoogleGenerativeAIAbortError } = require('@google/generative-ai');

const MODEL_NAME = 'gemini-3.1-flash-lite';

// Gemini API 呼叫的逾時上限。外層 expenseUI.js 的 90 秒逾時只保護「等待使用者上傳圖片」
// 這個階段；一旦圖片送出、進入「🔍 辨識中...」畫面後，若不對 API 呼叫本身加上逾時，
// 一旦 Google 端網路異常延遲或掛住，使用者就會被卡在辨識畫面上無限期等待。
// 這裡用 AbortController 主動中斷請求，確保無論如何最多等待這個時間就會得到結果或錯誤訊息。
const GEMINI_REQUEST_TIMEOUT_MS = 30 * 1000;

let genAI = null;
function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('尚未設定 GEMINI_API_KEY，帳單辨識功能無法使用。');
  }
  if (!genAI) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return genAI;
}

// 讓 Gemini 直接輸出結構化 JSON，避免自己再手刻脆弱的文字解析
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    description: {
      type: 'string',
      description: '這筆花費的簡短項目名稱（優先用店名，其次用品項摘要），20字以內'
    },
    amount: {
      type: 'number',
      description: '帳單上實際應付的總金額（含稅/服務費後的最終數字），只填數字，不含貨幣符號'
    },
    currency: {
      type: 'string',
      description: '幣別的 ISO 4217 三字代碼，例如 TWD、JPY、USD、KRW、CNY 等'
    },
    date: {
      type: 'string',
      description: '帳單上的日期，格式 YYYY-MM-DD，若無法辨識則輸出空字串'
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: '你對這次辨識結果整體的信心程度'
    }
  },
  required: ['description', 'amount', 'currency']
};

function buildPrompt(tripCurrencies, baseCurrency) {
  const currencyList = (tripCurrencies && tripCurrencies.length ? tripCurrencies : [baseCurrency]).join('、');

  return `你是一個專門辨識收據/帳單圖片的助手，請仔細閱讀圖片中的帳單、發票或收據內容，並提取以下資訊：

1. description：這筆消費的簡短摘要（優先使用店名，其次用品項類別，例如「王品牛排」、「7-11 飲料」、「計程車」），控制在 20 字以內，不要照抄整張收據的所有品項明細。
2. amount：帳單「實際需要支付」的總金額（優先抓「合計」「總計」「應付金額」「Total」欄位的最終數字，若有折扣請使用折扣後金額），只輸出數字，不要包含貨幣符號或千分位逗號。
3. currency：判斷這是什麼貨幣，輸出 ISO 4217 三字代碼。這趟行程目前使用的幣別有：${currencyList}（基準幣別為 ${baseCurrency}），如果圖片內容符合其中一種請優先使用；否則依據貨幣符號、文字語言或店家所在地合理判斷。
4. date：帳單上的日期（若有），格式 YYYY-MM-DD；辨識不到就輸出空字串。
5. confidence：你對整體辨識結果的信心程度（high/medium/low）。

請只根據圖片中「實際看得到」的內容作答，絕對不要編造數字。如果完全看不出金額，amount 請填 0。`;
}

/**
 * @param {Array<{mimeType: string, data: string}>} imageParts base64 圖片資料（沿用 aiUtils.processAttachments 的輸出格式）
 * @param {string[]} tripCurrencies 該行程目前已設定的幣別清單，作為 AI 判斷幣別時的參考
 * @param {string} baseCurrency 行程基準幣別
 * @returns {Promise<{description: string, amount: number|null, currency: string, date: string, confidence: string}>}
 */
async function scanBillImage(imageParts, tripCurrencies = [], baseCurrency = 'TWD') {
  if (!imageParts || !imageParts.length) {
    throw new Error('沒有可辨識的圖片內容，請確認上傳的是常見圖片格式 (png/jpg/webp)。');
  }

  const client = getClient();
  const model = client.getGenerativeModel({
    model: MODEL_NAME,
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.2
    }
  });

  const parts = [
    { text: buildPrompt(tripCurrencies, baseCurrency) },
    // 帳單辨識只需要一張清晰的照片就夠了，多張反而增加誤判/token 成本，
    // 這裡再做一層保底裁切（呼叫端 expenseUI.js 目前也只會傳入 1 張）。
    // 注意：圖片本身已在 aiUtils.processAttachments -> fetchImageUrlAsBase64 階段
    // 被 resize 到最長邊 1024px 以內（並轉為 webp），這裡不需要重複處理。
    ...imageParts.slice(0, 1).map(p => ({ inlineData: { mimeType: p.mimeType, data: p.data } }))
  ];

  let response;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_REQUEST_TIMEOUT_MS);

  try {
    const result = await model.generateContent(
      { contents: [{ role: 'user', parts }] },
      // signal 讓我們可以主動中斷卡住的請求；timeout 則讓 SDK 內部的 fetch 也遵守同一個上限，
      // 兩者一起設可以涵蓋「請求送出前就卡住」與「回應遲遲不來」兩種情況。
      { signal: controller.signal, timeout: GEMINI_REQUEST_TIMEOUT_MS }
    );
    response = result.response;
  } catch (err) {
    if (err instanceof GoogleGenerativeAIAbortError || err?.name === 'AbortError') {
      console.error(`[billScanner] Gemini API 呼叫逾時（超過 ${GEMINI_REQUEST_TIMEOUT_MS / 1000} 秒）`);
      throw new Error(`辨識逾時（超過 ${GEMINI_REQUEST_TIMEOUT_MS / 1000} 秒未回應），請稍後再試一次，或改用手動輸入。`);
    }
    console.error('[billScanner] Gemini API 呼叫失敗:', err.message);
    throw new Error('辨識服務暫時發生問題，請稍後再試一次。');
  } finally {
    clearTimeout(timeoutId);
  }

  let parsed;
  try {
    parsed = JSON.parse(response.text());
  } catch (err) {
    console.error('[billScanner] JSON 解析失敗:', err.message);
    throw new Error('AI 回傳格式異常，無法解析帳單內容，請再試一次或改用手動輸入。');
  }

  const amount = Number(parsed.amount);
  const description = (parsed.description || '').toString().trim().slice(0, 90);
  const recognizedNothing = !description && !(Number.isFinite(amount) && amount > 0);

  // 過去這裡「兩項都辨識不到」時會直接 throw，把使用者導向純錯誤畫面（只能重掃或整個改手動輸入），
  // 之前辨識到的任何蛛絲馬跡（例如幣別、日期）就全部作廢，體驗上很挫折。
  // 現在改成：即使什麼都沒認出來，也還是回傳一個「空白預設值」的結果，讓使用者一樣走進
  // 「確認並送出」那個表單（欄位空著讓他自己填），而不是被卡在死路。信心程度強制標成
  // low，讓下面 UI 對這種情況顯示醒目的警示提示使用者仔細檢查／自行輸入。
  return {
    description: description || '帳單花費',
    amount: Number.isFinite(amount) && amount > 0 ? Math.round((amount + Number.EPSILON) * 100) / 100 : null,
    currency: (parsed.currency || '').toString().trim().toUpperCase(),
    date: (parsed.date || '').toString().trim(),
    confidence: recognizedNothing ? 'low' : (parsed.confidence || 'medium')
  };
}

module.exports = { scanBillImage };
