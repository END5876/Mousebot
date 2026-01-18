require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function listModels() {
    if (!process.env.GEMINI_API_KEY) {
        console.error('❌ 錯誤：找不到 GEMINI_API_KEY，請確認 .env 檔案已設定');
        return;
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    try {
        console.log('🔍 正在查詢可用模型...');
        const modelResponse = await genAI.getGenerativeModel({ model: "gemini-pro" }).apiKey; // 只是為了觸發 client 初始化
        
        // 實際上 SDK 沒有直接提供 listModels 的簡單方法，
        // 我們直接用 fetch 測試最常用的幾個模型名稱
        
        const candidates = [
            "gemini-2.0-flash-exp",
            "gemini-1.5-flash",
            "gemini-1.5-flash-latest",
            "gemini-1.5-flash-001",
            "gemini-1.5-flash-002",
            "gemini-1.5-pro",
            "gemini-pro"
        ];

        console.log('\n--- 模型測試報告 ---');
        
        for (const modelName of candidates) {
            try {
                const model = genAI.getGenerativeModel({ model: modelName });
                // 嘗試發送一個極短的請求來測試模型是否存在
                await model.generateContent("Hi");
                console.log(`✅ ${modelName}: 可用！`);
            } catch (error) {
                if (error.message.includes('404') || error.message.includes('not found')) {
                    console.log(`❌ ${modelName}: 找不到 (404)`);
                } else if (error.message.includes('429')) {
                    console.log(`⚠️ ${modelName}: 存在但額度已滿 (429)`);
                } else {
                    console.log(`❓ ${modelName}: 其他錯誤 (${error.message.split('[')[0]})`);
                }
            }
        }
        
    } catch (error) {
        console.error('發生錯誤:', error);
    }
}

listModels();