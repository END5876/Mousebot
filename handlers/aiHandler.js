const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { EmbedBuilder } = require('discord.js');
const { PREFIX } = require('../config/settings');
const { SYSTEM_PROMPT, GENERATION_CONFIG } = require('../config/aiSettings');

// --- 設定區域 ---
const MODEL_NAME = "gemini-2.5-flash-lite"; 
const RANDOM_REPLY_CHANCE = 0.15; // 15% 機率自動回應

// 初始化 API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 獲取模型實例的函數
function getModel() {
    return genAI.getGenerativeModel({ 
        model: MODEL_NAME,
        systemInstruction: SYSTEM_PROMPT,
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
            generationConfig: GENERATION_CONFIG,
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

// --- 新增：短回應生成函數 ---
async function getShortResponse(userId, message) {
    try {
        const model = getModel();
        const history = getUserHistory(userId);
        
        // 創建一個特殊的 prompt，要求簡短回應
        const shortPrompt = `請用15個字以內簡短回應這句話（不要使用標點符號結尾）：「${message}」`;
        
        const chat = model.startChat({
            history: history,
            generationConfig: {
                ...GENERATION_CONFIG,
                maxOutputTokens: 30, // 限制輸出長度
            },
        });

        const result = await chat.sendMessage(shortPrompt);
        let response = result.response.text().trim();
        
        // 確保回應不超過10個字（中文字符）
        if (response.length > 20) {
            response = response.substring(0, 20);
        }

        // 不更新歷史記錄，保持隨機回應的獨立性
        // updateUserHistory(userId, 'user', message);
        // updateUserHistory(userId, 'model', response);

        return response;
    } catch (error) {
        console.error(`Short Response Error:`, error.message);
        return null;
    }
}

// --- Discord 訊息處理 ---

function setupAICommands(client) {
  client.on('messageCreate', async message => {
      // 忽略 bot 自己的訊息
      if (message.author.bot) return;
      
      // 忽略沒有文字內容的訊息（例如只有圖片）
      if (!message.content || message.content.trim() === '') return;

      const content = message.content.trim();
      
      // 保留清除記憶指令
      const isClearCommand = content === `${PREFIX}reset` || content === `${PREFIX}clearai`;
      if (isClearCommand) {
          clearUserHistory(message.author.id);
          return message.channel.send('🧠 已清除你的對話記憶。');
      }

      // 檢查是否被 tag (提及)
      const isMentioned = message.mentions.has(client.user);
      
      if (isMentioned) {
          // === 原有的 mention 回應邏輯 ===
          let question = content
              .replace(/<@!?\d+>/g, '')
              .trim();
          
          if (!question) return;
          if (!process.env.GEMINI_API_KEY) return message.channel.send('❌ 未設定 API Key');

          let thinkingMsg = null;
          try {
              thinkingMsg = await message.channel.send('⏳ 思考中...');
              const answer = await getGeminiResponse(message.author.id, question);
              if (thinkingMsg) await thinkingMsg.delete().catch(() => {});

              if (answer.length <= 2000) {
                  await message.channel.send(answer);
              } else {
                  const chunks = splitMessage(answer);
                  
                  // 所有訊息都用 channel.send
                  for (let i = 0; i < chunks.length; i++) {
                      await message.channel.send(chunks[i]);
                  }
              }
          } catch (error) {
              if (thinkingMsg) await thinkingMsg.delete().catch(() => {});
              
              let errorMsg = `❌ 錯誤：${error.message}`;
              if (error.message.includes('404')) errorMsg = `❌ 找不到模型 ${MODEL_NAME}，請嘗試更改模型名稱`;
              if (error.message.includes('429')) errorMsg = '⚠️ 請求太頻繁，請稍後再試';
              
              message.channel.send(errorMsg);
          }
      } else {
          // === 新增：15% 機率隨機回應 ===
          if (!process.env.GEMINI_API_KEY) return;
          
          const randomValue = Math.random();
          if (randomValue < RANDOM_REPLY_CHANCE) {
              try {
                  const shortReply = await getShortResponse(message.author.id, content);
                  if (shortReply) {
                      await message.channel.send(shortReply);
                  }
              } catch (error) {
                  // 靜默處理錯誤，不影響正常聊天
                  console.error('Random reply error:', error.message);
              }
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
