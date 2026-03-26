const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { PREFIX } = require('../../config/settings');
const { GENERATION_CONFIG } = require('../../config/aiSettings');
const { selectMode, getModeName } = require('./modeSelector');
const developerMode = require('./modes/developerMode');
const guguMode = require('./modes/gugugagaMode'); 
const { playTTS } = require('../ttsHandler'); // 🔊 連動 TTS

// 導入所有模式
const lossMode = require('./modes/lossMode');
const mambaMentorMode = require('./modes/mambaMentorMode');
const mygoMode = require('./modes/mygoMode');
const inmuMode = require('./modes/inmuMode');
const loverMode = require('./modes/loverMode');

// --- 設定區域 ---
const MODEL_NAME = "gemini-2.5-flash-lite"; 
const RANDOM_REPLY_CHANCE = 0.15; // 15% 機率自動回應
const MAX_IMAGE_SIZE_MB = 7; // 圖片大小上限（MB）
const TTS_MAX_LENGTH = 1000; // TTS 字數上限（與 ttsHandler 保持一致）

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
 * 從 Discord 附件下載圖片並轉成 Base64
 */
async function fetchImageAsBase64(attachment) {
    const sizeLimit = MAX_IMAGE_SIZE_MB * 1024 * 1024;
    if (attachment.size > sizeLimit) {
        console.warn(`[Image] 圖片過大，跳過：${attachment.name} (${(attachment.size / 1024 / 1024).toFixed(2)} MB)`);
        return null;
    }

    // 只允許支援的格式
    const supportedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];
    const mimeType = attachment.contentType?.split(';')[0] || 'image/jpeg';
    if (!supportedTypes.includes(mimeType)) {
        console.warn(`[Image] 不支援的格式，跳過：${mimeType}`);
        return null;
    }

    try {
        const response = await fetch(attachment.url);
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        return { base64, mimeType };
    } catch (err) {
        console.error(`[Image] 下載圖片失敗：`, err.message);
        return null;
    }
}

/**
 * 每次都重新選擇模式（不記住）
 */
function getUserMode(userId, message) {
    const mode = selectMode(userId, message);
    console.log(`[Mode] User ${userId} -> ${getModeName(mode)}`);
    return mode;
}

/**
 * 🔊 觸發 TTS 朗讀（統一處理，靜默失敗）
 */
async function speakWithTTS(guildId, text) {
    if (!guildId) return;
    const ttsText = text.length > TTS_MAX_LENGTH ? text.slice(0, TTS_MAX_LENGTH) : text;
    try {
        const result = await playTTS(guildId, ttsText);
        if (!result.success) {
            console.warn(`⚠️ [TTS] 朗讀失敗 (reason: ${result.reason})`);
        } else {
            console.log(`🔊 [TTS] 朗讀中 (engine: ${result.engine}, queued: ${result.queued})`);
        }
    } catch (err) {
        console.error('❌ [TTS] 呼叫 playTTS 發生錯誤:', err.message);
    }
}

// --- 核心邏輯 ---

/**
 * 支援圖片的 Gemini 回應函數
 * @param {string} userId
 * @param {string} prompt - 文字內容
 * @param {Array}  imageParts - [{ base64, mimeType }, ...] 可為空陣列
 */
async function getGeminiResponse(userId, prompt, imageParts = []) {
    try {
        const mode = getUserMode(userId, prompt);
        const model = getModel(mode);
        const history = getUserHistory(userId);
        
        const chat = model.startChat({
            history: history,
            generationConfig: GENERATION_CONFIG,
        });

        // 組合訊息：文字 + 圖片
        const messageParts = [];

        // 先放圖片（Gemini 建議圖片放前面）
        for (const img of imageParts) {
            messageParts.push({
                inlineData: {
                    mimeType: img.mimeType,
                    data: img.base64,
                }
            });
        }

        // 再放文字
        if (prompt) {
            messageParts.push({ text: prompt });
        } else if (imageParts.length > 0) {
            // 沒有文字但有圖片，給預設提示
            messageParts.push({ text: '請吐槽這張圖片' });
        }

        const result = await chat.sendMessage(messageParts);
        const response = result.response.text();

        // 歷史記錄只存文字部分
        const historyText = imageParts.length > 0
            ? `[傳送了 ${imageParts.length} 張圖片] ${prompt || ''}`
            : prompt;

        updateUserHistory(userId, 'user', historyText);
        updateUserHistory(userId, 'model', response);

        return response;
    } catch (error) {
        console.error(`Gemini Error (${MODEL_NAME}):`, error.message);
        throw error;
    }
}

/**
 * 短回應生成函數（隨機回應用）
 * @param {string} userId
 * @param {string} message
 * @param {Array}  imageParts - [{ base64, mimeType }, ...] 可為空陣列
 */
async function getShortResponse(userId, message, imageParts = []) {
    try {
        const mode = getUserMode(userId, message);
        const model = getModel(mode);
        const history = getUserHistory(userId);
        
        const shortPrompt = imageParts.length > 0 && !message
            ? `請用大約10~200個字回應或吐槽這張圖片`
            : `請用大約10~200字回應或吐槽訊息：「${message}」`;
        
        const chat = model.startChat({
            history: history,
            generationConfig: {
                ...GENERATION_CONFIG,
                maxOutputTokens: 300,
            },
        });

        // 組合圖片 + 文字
        const messageParts = [];

        for (const img of imageParts) {
            messageParts.push({
                inlineData: {
                    mimeType: img.mimeType,
                    data: img.base64,
                }
            });
        }

        messageParts.push({ text: shortPrompt });

        const result = await chat.sendMessage(messageParts);
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

      // 允許純圖片訊息
      const hasAttachment = message.attachments.size > 0;
      const content = message.content?.trim() || '';

      // 如果既沒有文字也沒有圖片，直接跳過
      if (!content && !hasAttachment) return;

      const userId = message.author.id;
      
      // 清除記憶指令
      const isClearCommand = content === `${PREFIX}reset` || content === `${PREFIX}clearai`;
      if (isClearCommand) {
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
          
          // 有圖片時即使沒文字也繼續處理
          if (!question && !hasAttachment) return;
          if (!process.env.GEMINI_API_KEY) return message.channel.send('❌ 未設定 API Key');

          let thinkingMsg = null;
          try {
              const mode = getUserMode(userId, question || '圖片');
              const modeModule = MODE_MAP[mode];
              const thinkingText = modeModule.getThinkingMessage();
              
              thinkingMsg = await message.channel.send(thinkingText);

              // 處理圖片附件
              const imageParts = [];
              if (hasAttachment) {
                  for (const [, attachment] of message.attachments) {
                      const imgData = await fetchImageAsBase64(attachment);
                      if (imgData) imageParts.push(imgData);
                  }
              }
              
              const answer = await getGeminiResponse(userId, question, imageParts);
              if (thinkingMsg) await thinkingMsg.delete().catch(() => {});

              if (answer.length <= 2000) {
                  await message.channel.send(answer);
              } else {
                  const chunks = splitMessage(answer);
                  for (let i = 0; i < chunks.length; i++) {
                      await message.channel.send(chunks[i]);
                  }
              }

              // 🔊 TTS 朗讀 AI 回答
              await speakWithTTS(message.guild?.id, answer);

          } catch (error) {
              if (thinkingMsg) await thinkingMsg.delete().catch(() => {});
              
              const mode = selectMode(userId, question || '圖片');
              const modeModule = MODE_MAP[mode];
              const errorMsg = modeModule.getErrorMessage(error);
              
              message.channel.send(errorMsg);
          }
      } else {
            // === 隨機回應邏輯 ===
            if (!process.env.GEMINI_API_KEY) return;

            // 移除所有 mention（使用者/身分組/頻道）後的文字
            const cleanedContent = content
                .replace(/<@!?\d+>/g, '')   // user mention
                .replace(/<@&\d+>/g, '')    // role mention
                .replace(/<#\d+>/g, '')     // channel mention
                .trim();

            // 清洗後為空，但有圖片時繼續往下走
            if (!cleanedContent && !hasAttachment) {
                return;
            }

            // 檢查是否包含網址（用清洗後文字判斷）
            const urlPattern = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi;
            const hasUrl = urlPattern.test(cleanedContent);

            // 檢查是否為 !gugu 指令
            const isGuguCommand = cleanedContent.startsWith('!gugu');

            // 網址或 gugu 指令跳過
            if (hasUrl || isGuguCommand) {
                return;
            }

            const randomValue = Math.random();
            if (randomValue < RANDOM_REPLY_CHANCE) {
                try {
                    // 處理圖片附件
                    const imageParts = [];
                    if (hasAttachment) {
                        for (const [, attachment] of message.attachments) {
                            const imgData = await fetchImageAsBase64(attachment);
                            if (imgData) imageParts.push(imgData);
                        }
                    }

                    const shortReply = await getShortResponse(userId, cleanedContent, imageParts);
                    if (shortReply) {
                        await message.channel.send(shortReply);

                        // 🔊 TTS 朗讀隨機回應
                        await speakWithTTS(message.guild?.id, shortReply);
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