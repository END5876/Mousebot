const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { PREFIX } = require('../../config/settings');
const { GENERATION_CONFIG } = require('../../config/aiSettings');
const { selectMode, getModeName } = require('./modeSelector');
const developerMode = require('./modes/developerMode');
const guguMode = require('./modes/gugugagaMode'); // 🆕 新增

// 導入所有模式
const lossMode = require('./modes/lossMode');
const mambaMentorMode = require('./modes/mambaMentorMode');
const mygoMode = require('./modes/mygoMode');
const inmuMode = require('./modes/inmuMode');
const loverMode = require('./modes/loverMode');

// --- 設定區域 ---
const MODEL_NAME = "gemini-2.5-flash-lite"; 
const RANDOM_REPLY_CHANCE = 0.15; // 15% 機率自動回應

// 初始化 API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 模式映射表
const MODE_MAP = {
    loss: lossMode,
    mambaMentor: mambaMentorMode,
    mygo: mygoMode,
    inmu: inmuMode,
    lover: loverMode,
    developer: developerMode,
    gugu: guguMode
};

/**
 * 根據模式名稱獲取對應的 System Prompt
 */
function getSystemPrompt(mode) {
    const modeModule = MODE_MAP[mode];
    if (!modeModule) {
        console.error(`Unknown mode: ${mode}`);
        return lossMode.LOSS_MODE_PROMPT;
    }
    
    const promptKey = Object.keys(modeModule).find(key => key.endsWith('_PROMPT'));
    return modeModule[promptKey];
}

/**
 * 獲取模型實例（根據模式調整 prompt）
 */
function getModel(mode) {
    const systemPrompt = getSystemPrompt(mode);
    
    return genAI.getGenerativeModel({ 
        model: MODEL_NAME,
        systemInstruction: systemPrompt,
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

/**
 * 🆕 每次都重新選擇模式（不記住）
 */
function getUserMode(userId, message) {
    const mode = selectMode(userId, message);
    console.log(`[Mode] User ${userId} -> ${getModeName(mode)}`);
    return mode;
}

// --- 核心邏輯 ---

async function getGeminiResponse(userId, prompt) {
    try {
        const mode = getUserMode(userId, prompt);
        const model = getModel(mode);
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

/**
 * 短回應生成函數（隨機回應用）
 */
async function getShortResponse(userId, message) {
    try {
        const mode = getUserMode(userId, message);
        const model = getModel(mode);
        const history = getUserHistory(userId);
        
        const shortPrompt = `請用20個字以內簡短回應這句話（不要使用標點符號結尾）：「${message}」`;
        
        const chat = model.startChat({
            history: history,
            generationConfig: {
                ...GENERATION_CONFIG,
                maxOutputTokens: 300,
            },
        });

        const result = await chat.sendMessage(shortPrompt);
        let response = result.response.text().trim();
        
        return response;
    } catch (error) {
        console.error(`Short Response Error:`, error.message);
        return null;
    }
}

// --- Discord 訊息處理 ---

function setupAICommands(client) {
  client.on('messageCreate', async message => {
      if (message.author.bot) return;
      if (!message.content || message.content.trim() === '') return;

      const content = message.content.trim();
      const userId = message.author.id;
      
      // 清除記憶指令
      const isClearCommand = content === `${PREFIX}reset` || content === `${PREFIX}clearai`;
      if (isClearCommand) {
          // 🆕 隨機選擇一個模式來顯示清除訊息
          const mode = selectMode(userId, content);
          const modeModule = MODE_MAP[mode];
          const clearMsg = modeModule.getClearMemoryMessage();
          
          clearUserHistory(userId);
          return message.channel.send(clearMsg);
      }

      const isMentioned = message.mentions.has(client.user);
      
      if (isMentioned) {
          // === Mention 回應邏輯 ===
          let question = content.replace(/<@!?\d+>/g, '').trim();
          
          if (!question) return;
          if (!process.env.GEMINI_API_KEY) return message.channel.send('❌ 未設定 API Key');

          let thinkingMsg = null;
          try {
              const mode = getUserMode(userId, question);
              const modeModule = MODE_MAP[mode];
              const thinkingText = modeModule.getThinkingMessage();
              
              thinkingMsg = await message.channel.send(thinkingText);
              
              const answer = await getGeminiResponse(userId, question);
              if (thinkingMsg) await thinkingMsg.delete().catch(() => {});

              if (answer.length <= 2000) {
                  await message.channel.send(answer);
              } else {
                  const chunks = splitMessage(answer);
                  for (let i = 0; i < chunks.length; i++) {
                      await message.channel.send(chunks[i]);
                  }
              }
          } catch (error) {
              if (thinkingMsg) await thinkingMsg.delete().catch(() => {});
              
              // 🆕 隨機選擇一個模式來顯示錯誤訊息
              const mode = selectMode(userId, question);
              const modeModule = MODE_MAP[mode];
              const errorMsg = modeModule.getErrorMessage(error);
              
              message.channel.send(errorMsg);
          }
      } else {
          // === 隨機回應邏輯 ===
          if (!process.env.GEMINI_API_KEY) return;
            // 檢查是否包含網址
            const urlPattern = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi;
            const hasUrl = urlPattern.test(content);
            
            // 檢查是否為純圖片訊息（有附件但沒有文字內容，或文字內容很短）
            const hasAttachment = message.attachments.size > 0;
            const isPureImage = hasAttachment && (!content || content.length < 10);

            // 檢查是否為 !gugu 指令
            const isGuguCommand = content.startsWith('!gugu');
            
            // 如果包含網址或純圖片，跳過隨機回應
            if (hasUrl || isPureImage || isGuguCommand) {
                return;
            }
          
          const randomValue = Math.random();
          if (randomValue < RANDOM_REPLY_CHANCE) {
              try {
                  const shortReply = await getShortResponse(userId, content);
                  if (shortReply) {
                      await message.channel.send(shortReply);
                  }
              } catch (error) {
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