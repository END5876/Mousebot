'use strict';
/**
 * 帳單照片辨識：呼叫 Gemini 的視覺能力，辨識出品項、金額、服務費比例、幣別。
 * 跟專案既有 /ai 指令（handlers/ai/aiCore.js）共用同一把 GEMINI_API_KEY，
 * 沒設定的話帳單辨識功能會回傳清楚的錯誤訊息，但不影響其他功能。
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');

// 跟專案既有 handlers/ai/aiCore.js 用同一顆模型，沿用已驗證可用的設定
const RECEIPT_MODEL_NAME = 'gemini-3.1-flash-lite';
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

const RECEIPT_PROMPT = `你是一個帳單／收據辨識助手。請仔細閱讀這張照片，只回傳一個 JSON 物件，不要有任何其他文字、不要用 markdown code block 包起來、不要加註解。

物件格式：
{
  "currency": "ISO 4217 三碼幣別代碼（例如 TWD、JPY、USD、KRW），看不出來就填 null",
  "language": "帳單上主要文字使用的語言，用簡短中文描述（例如：日文、韓文、泰文、英文、繁體中文、簡體中文），無法判斷則填「未知」",
  "serviceChargeRate": 數字（例如 0.1 代表 10% 服務費；完全沒有服務費就填 0）,
  "items": [
    {"name": "品項名稱（帳單原文語言）", "nameTranslated": "此品項名稱的繁體中文翻譯", "price": 數字, "type": "item" 或 "fee"}
  ]
}

規則：
- "type":"item" 用於一般餐點／商品品項；price 是「加服務費前」的原始單價，不要自己在這裡加成
- "type":"fee" 用於訂金／訂位金、外送費、清潔費、開瓶費等跟服務費無關的固定雜費；折扣或優惠請用 "fee" 且 price 填負數
- "name" 一律用帳單「原文」語言填寫，不要自己先翻譯；"nameTranslated" 才是翻譯欄位——把 name 翻譯成繁體中文。如果 name 本身已經是中文（繁體或簡體皆可），"nameTranslated" 請填空字串 ""，不要重複輸出原文
- 【重要】如果帳單上有服務費（不管是寫成百分比，或是直接列一筆服務費金額），絕對不要把它放進 items 陣列當成獨立項目；改成換算成比例填進最上層的 serviceChargeRate。如果看得到明確百分比（例如「服務費10%」「一成服務費」「Service Charge 10%」）就直接用該比例；如果只看到服務費的金額、沒寫百分比，用「服務費金額 ÷ 所有餐點品項小計」概算出比例
- price 一律是純數字，不要有貨幣符號、千分位逗號、百分比符號
- 如果同一品項的價格已經是含數量的小計（例如「奶茶 x2　$100」代表兩杯共 100 元），就填一行 100，不要拆成兩行
- 只回傳看得清楚的品項，看不清楚或無法判斷金額的部分不要瞎猜、不要編造
- 小計（subtotal）、總計（total）這種彙總列本身不算獨立品項，不要放進 items 裡（服務費要換算成 serviceChargeRate，不算在這條規則內）
- 如果整張圖片看起來不像帳單/收據，items 填空陣列 []`;

// 從模型回應中取出 JSON 物件文字，容忍模型偶爾還是包了 ```json 圍欄或前後贅字的情況
function extractJsonObject(text) {
  if (!text) throw new Error('模型沒有回傳任何內容');
  let cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('回應內容裡找不到 JSON 物件');
  cleaned = cleaned.slice(start, end + 1);
  const parsed = JSON.parse(cleaned);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('解析結果不是物件');
  return parsed;
}

// 🆕 語言辨識 + 翻譯的保險機制：跟 billScanner.js（Discord 面板）用同一套邏輯——
// 只要 AI 判斷的語言標籤裡含有「中文」或 "chinese"，一律視為不需要翻譯，
// 避免簡體/繁體中文被誤判成需要轉換，跟原文重複顯示。
function isChineseLanguageLabel(lang) {
  return /中文|chinese/i.test(lang || '');
}

// 驗證並清理辨識結果，過濾掉格式不對的資料，避免壞資料流到前端
function sanitizeReceiptResponse(raw) {
  const serviceChargeRate = (raw && typeof raw.serviceChargeRate === 'number'
    && Number.isFinite(raw.serviceChargeRate) && raw.serviceChargeRate >= 0 && raw.serviceChargeRate < 2)
    ? Math.round(raw.serviceChargeRate * 10000) / 10000
    : 0;
  const currency = (raw && typeof raw.currency === 'string' && /^[A-Za-z]{3}$/.test(raw.currency.trim()))
    ? raw.currency.trim().toUpperCase()
    : null;
  // 🆕 語言辨識：純粹給前端顯示用的提示文字（例如「偵測到日文，已附上翻譯」），
  // 不影響任何計算邏輯，因此只做基本的型別/長度防呆。
  const language = (raw && typeof raw.language === 'string') ? raw.language.trim().slice(0, 20) : '';
  const isChinese = isChineseLanguageLabel(language);
  const rawItems = Array.isArray(raw && raw.items) ? raw.items : [];
  const items = rawItems
    .filter(it => it && typeof it.name === 'string' && typeof it.price === 'number' && Number.isFinite(it.price))
    .map(it => ({
      name: it.name.trim().slice(0, 120) || '未命名品項',
      // 🆕 nameTranslated：品項名稱的繁體中文翻譯。原文已是中文（含簡體），或模型沒給
      // 翻譯時，一律留空字串，前端只在有值時才顯示「🌐 翻譯：...」提示行。
      nameTranslated: (!isChinese && typeof it.nameTranslated === 'string') ? it.nameTranslated.trim().slice(0, 120) : '',
      price: Math.round(it.price * 100) / 100,
      type: it.type === 'fee' ? 'fee' : 'item',
    }));
  return { currency, serviceChargeRate, items, language };
}

// 實際呼叫模型辨識一張帳單照片；呼叫端需先確認 genAI 已設定好（見 routes/utility.js）。
async function recognizeReceipt(image, mediaType) {
  const model = genAI.getGenerativeModel({
    model: RECEIPT_MODEL_NAME,
    generationConfig: {
      temperature: 0.1, // 辨識任務要穩定、不要有創意發揮
      responseMimeType: 'application/json',
    },
  });
  const result = await model.generateContent([
    { inlineData: { mimeType: mediaType || 'image/jpeg', data: image } },
    { text: RECEIPT_PROMPT },
  ]);
  const text = result.response.text();
  const parsed = extractJsonObject(text);
  return sanitizeReceiptResponse(parsed);
}

module.exports = {
  RECEIPT_MODEL_NAME,
  genAI,
  extractJsonObject,
  isChineseLanguageLabel,
  sanitizeReceiptResponse,
  recognizeReceipt,
};
