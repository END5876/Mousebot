const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { EmbedBuilder } = require('discord.js');
const { PREFIX } = require('../config/settings');
const { SYSTEM_PROMPT, GENERATION_CONFIG } = require('../config/aiSettings');

// --- 設定區域 ---
// 嘗試使用 latest 別名，或者你可以改為 'gemini-pro' (最穩定)
const MODEL_NAME = "gemini-2.5-flash-lite"; 

// 初始化 API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 獲取模型實例的函數 (方便動態切換)
function getModel() {
    return genAI.getGenerativeModel({ 
        model: MODEL_NAME,
        systemInstruction: SYSTEM_PROMPT, // 加入系統指令
        safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ]
    });
}

// --- 記憶體管理 ---
const userChats = new Map();

function getUserHistory(userId) {
    if (!userChats.has(userId)) userChats.set(userId, []);
    return userChats.get(userId);
}

function updateUserHistory(userId, role, text) {
    const history = getUserHistory(userId);
    history.push({ role: role, parts: [{ text: text }] });
    if (history.length > 20) {
        history.shift(); 
        history.shift();
    }
}

function clearUserHistory(userId) {
    userChats.delete(userId);
}

// --- 核心邏輯 ---

async function getGeminiResponse(userId, prompt) {
    try {
        const model = getModel();
        const history = getUserHistory(userId);
        
        const chat = model.startChat({
            history: history,
            generationConfig: GENERATION_CONFIG, // 使用配置
        });

        const result = await chat.sendMessage(prompt);
        const response = result.response.text();

        updateUserHistory(userId, 'user', prompt);
        updateUserHistory(userId, 'model', response);

        return response;
    } catch (error) {
        console.error(`Gemini Error (${MODEL_NAME}):`, error.message);
        throw error;
    }
}

// --- Discord 訊息處理 ---

function setupAICommands(client) {
  client.on('messageCreate', async message => {
      if (message.author.bot) return;

      const content = message.content.trim();
      
      // 保留清除記憶指令
      const isClearCommand = content === `${PREFIX}reset` || content === `${PREFIX}clearai`;
      if (isClearCommand) {
          clearUserHistory(message.author.id);
          return message.reply('🧠 已清除你的對話記憶。');
      }

      // 檢查是否被 tag (提及)
      const isMentioned = message.mentions.has(client.user);
      
      if (isMentioned) {
          // 移除 bot 的 mention，取得實際問題內容
          let question = content
              .replace(/<@!?\d+>/g, '') // 移除所有 mention 標籤
              .trim();
          
          if (!question) return;
          if (!process.env.GEMINI_API_KEY) return message.reply('❌ 未設定 API Key');

          let thinkingMsg = null;
          try {
              thinkingMsg = await message.reply('⏳ 思考中...');
              const answer = await getGeminiResponse(message.author.id, question);
              if (thinkingMsg) await thinkingMsg.delete().catch(() => {});

              if (answer.length <= 2000) {
                  await message.reply(answer);
              } else {
                  const chunks = splitMessage(answer);
                  
                  // 第一則訊息用 reply
                  await message.reply(chunks[0]);
                  
                  // 後續訊息直接發送
                  for (let i = 1; i < chunks.length; i++) {
                      await message.channel.send(chunks[i]);
                  }
              }
          } catch (error) {
              if (thinkingMsg) await thinkingMsg.delete().catch(() => {});
              
              let errorMsg = `❌ 錯誤：${error.message}`;
              if (error.message.includes('404')) errorMsg = `❌ 找不到模型 ${MODEL_NAME}，請嘗試更改模型名稱 (例如 gemini-pro)`;
              if (error.message.includes('429')) errorMsg = '⚠️ 請求太頻繁 (Rate Limit)，請稍後再試';
              
              message.reply(errorMsg);
          }
      }
  });
}

function splitMessage(text, maxLength = 1900) {
    if (text.length <= maxLength) return [text];
    const chunks = [];
    while (text.length > 0) {
        let chunk = text.slice(0, maxLength);
        const lastNewLine = chunk.lastIndexOf('\n');
        if (lastNewLine > maxLength * 0.8) {
            chunk = text.slice(0, lastNewLine);
            text = text.slice(lastNewLine + 1);
        } else {
            text = text.slice(maxLength);
        }
        chunks.push(chunk);
    }
    return chunks;
}

module.exports = { setupAICommands };