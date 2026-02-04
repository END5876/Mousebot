const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { GUGU_MODE_PROMPT } = require('./modes/gugugagaMode');

// 初始化 API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 模型名稱
const MODEL_NAME = "gemini-2.5-flash-lite";

// 生成配置
const GENERATION_CONFIG = {
temperature: 1.2,        // 提高創意度
topK: 64,
topP: 0.95,
maxOutputTokens: 8192,
};

/**
 * 獲取咕咕嘎嘎生成模型
 */
function getGuguModel() {
return genAI.getGenerativeModel({ 
    model: MODEL_NAME,
    systemInstruction: GUGU_MODE_PROMPT,
    safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ],
    generationConfig: GENERATION_CONFIG
});
}

/**
 * 生成咕咕嘎嘎風格文章
 * @param {string} topic - 用戶提供的主題
 * @returns {Promise<string>} 生成的文章
 */
async function generateGuguArticle(topic) {
try {
    const model = getGuguModel();
    
    // 構建提示詞
    const prompt = `請根據以下主題，創作一篇完整的「咕咕嘎嘎體」文章：

主題：${topic}

要求：
1. 必須使用開場語（「我操了老鐵」系列）
2. 必須使用結尾「咕咕嘎嘎！」
3. 將主題遊戲化處理（旮旯 game）
4. 使用遊戲術語：好感度、特殊 CG、攻略線、爆 CG 等
5. 邏輯荒誕但內部自洽
6. 語言口語化、網路化
7. 字數 100-300 字
8. 使用三段式結構：引入觀點 → 展開邏輯 → 自我感嘆收尾

請直接生成文章，不要有任何前綴說明。`;

    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    
    return text;
} catch (error) {
    console.error('咕咕嘎嘎生成錯誤:', error);
    throw error;
}
}

/**
 * 設置咕咕嘎嘎生成指令
 * @param {Client} client - Discord 客戶端
 */
function setupGuguGenerator(client) {
client.on('messageCreate', async (message) => {
    // 忽略機器人自己的訊息
    if (message.author.bot) return;

    // 檢查是否為咕咕嘎嘎生成指令
    // 只支援格式：!gugu <主題>
    const guguRegex = /^!gugu\s+(.+)/;
    const match = message.content.match(guguRegex);

    // 如果沒有匹配到，直接返回（不做任何事）
    if (!match) return;

    const topic = match[1].trim();

    // 檢查主題是否為空（理論上不會發生，因為正則已經要求 .+）
    if (!topic) return;

    try {
        // 發送思考訊息
        const thinkingMsg = await message.channel.send('⏳ 我操了老鐵...');

        // 生成文章
        const article = await generateGuguArticle(topic);

        // 直接顯示文章內容
        await thinkingMsg.edit(article);

    } catch (error) {
        console.error('生成咕咕嘎嘎文章時發生錯誤:', error);
        
        let errorMsg = '❌ 我草了老鐵...生成失敗了：' + error.message;
        
        if (error.message.includes('quota')) {
            errorMsg += '\n\n⚠️ API 配額用完了，這攻略線崩了啊🤔 咕咕嘎嘎';
        } else if (error.message.includes('safety')) {
            errorMsg += '\n\n⚠️ 內容被安全過濾擋住了，這好感度掉太快了吧😨 咕咕嘎嘎';
        } else if (error.message.includes('not found') || error.message.includes('404')) {
            errorMsg += '\n\n⚠️ 模型不可用，請檢查 API 設定 咕咕嘎嘎';
        }
        
        await message.reply(errorMsg);
    }
});

console.log('✅ 咕咕嘎嘎生成器已啟動！');
}

module.exports = {
setupGuguGenerator,
generateGuguArticle
};