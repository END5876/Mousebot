const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { SlashCommandBuilder } = require('discord.js');
const { GENERATION_CONFIG } = require('../../config/aiSettings');
const { selectMode, getModeName, determineGroupStrategy } = require('./modeSelector');
const developerMode = require('./modes/developerMode');
const guguMode = require('./modes/gugugagaMode');
const { playTTS } = require('../ttsHandler');

// 導入所有模式
const lossMode = require('./modes/lossMode');
const mambaMentorMode = require('./modes/mambaMentorMode');
const mygoMode = require('./modes/mygoMode');
const inmuMode = require('./modes/inmuMode');
const loverMode = require('./modes/loverMode');

// --- 設定區域 ---
const MODEL_NAME = "gemini-2.5-flash-lite";
const RANDOM_REPLY_CHANCE = 0.15;
const MAX_IMAGE_SIZE_MB = 7;
const TTS_MAX_LENGTH = 1000;
const BUFFER_EXPIRE_MS = 10 * 60 * 1000; // 10 分鐘

// 初始化 API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- AI TTS 開關（每個 Guild 獨立）---
const aiTTSEnabled = new Map();

function isAITTSEnabled(guildId) {
    return aiTTSEnabled.get(guildId) ?? true;
}

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

// ── 語音模式附加 Prompt ──────────────────────────────────
const VOICE_MODE_ADDON = `

## 語音回覆規則（最高優先，覆蓋長度設定）
1. 使用者現在是透過「語音」跟你講話，你的回覆也會被轉成語音播放。
2. 回答必須「口語化」，像真人聊天一樣自然。
3. 保持簡短！盡量控制在 1~3 句話以內（約 30~50 字），絕對不要長篇大論。
4. 絕對不要使用 Markdown 語法（如 **粗體**、*斜體*、列表、程式碼區塊），因為語音引擎無法朗讀排版。
5. 在遵守以上規則的前提下，必須完全保持你現在的人格設定與語氣。
`;

function getSystemPrompt(mode) {
    const modeModule = MODE_MAP[mode];
    if (!modeModule) {
        console.error(`Unknown mode: ${mode}`);
        return lossMode.LOSS_MODE_PROMPT;
    }
    const promptKey = Object.keys(modeModule).find(key => key.endsWith('_PROMPT'));
    return modeModule[promptKey];
}

function getModel(mode, isVoice = false) {
    let systemPrompt = getSystemPrompt(mode);
    if (isVoice) systemPrompt = systemPrompt + VOICE_MODE_ADDON;

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

// --- 記憶體管理 (個人歷史) ---
const userChats = new Map();

function getUserHistory(userId) {
    if (!userChats.has(userId)) userChats.set(userId, []);
    return userChats.get(userId);
}

function updateUserHistory(userId, role, text) {
    const history = getUserHistory(userId);
    history.push({ role, parts: [{ text }] });
    if (history.length > 20) {
        history.shift();
        history.shift();
    }
}

function clearUserHistory(userId) {
    userChats.delete(userId);
}

// --- 記憶體管理 (群組 Buffer) ---
const channelBuffers = new Map();
const MAX_BUFFER_SIZE = 15;

// ✅ 加上 timestamp
function addChannelMessage(channelId, userId, name, text) {
    if (!channelId) return;
    if (!channelBuffers.has(channelId)) channelBuffers.set(channelId, []);
    const buffer = channelBuffers.get(channelId);
    buffer.push({ userId, name, text, timestamp: Date.now() });
    if (buffer.length > MAX_BUFFER_SIZE) {
        buffer.shift();
    }
}

// ✅ 讀取時過濾超過 10 分鐘的訊息，並清理記憶體
function getChannelBufferMessages(channelId) {
    if (!channelId || !channelBuffers.has(channelId)) return [];

    const now = Date.now();
    const buffer = channelBuffers.get(channelId);

    // 過濾過期訊息
    const fresh = buffer.filter(msg => (now - msg.timestamp) < BUFFER_EXPIRE_MS);

    // 若有過期訊息被清除，更新 Map（順便清理記憶體）
    if (fresh.length !== buffer.length) {
        if (fresh.length === 0) {
            channelBuffers.delete(channelId); // 全空就直接刪除 key
        } else {
            channelBuffers.set(channelId, fresh);
        }
    }

    return fresh;
}

// ✅ 注入現在時間（台灣時區，24h 格式）
function getNowString() {
    return new Date().toLocaleString('zh-TW', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
}

function getChannelBufferText(channelId) {
    const buffer = getChannelBufferMessages(channelId);
    const nowStr = getNowString();
    const header = `【現在時間】${nowStr}`;
    if (buffer.length === 0) return `${header}\n【近期對話】無近期對話紀錄。`;
    const messages = buffer.map(msg => `[${msg.name}]: ${msg.text}`).join('\n');
    return `${header}\n【近期對話】\n${messages}`;
}

async function fetchImageAsBase64(attachment) {
    const sizeLimit = MAX_IMAGE_SIZE_MB * 1024 * 1024;
    if (attachment.size > sizeLimit) return null;

    const supportedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];
    const mimeType = attachment.contentType?.split(';')[0] || 'image/jpeg';
    if (!supportedTypes.includes(mimeType)) return null;

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

async function speakWithTTS(source, text, guildId) {
    if (!guildId) return;
    if (!isAITTSEnabled(guildId)) return;

    const voiceChannel = source.member?.voice?.channel;
    if (!voiceChannel) {
        console.log(`🔇 [TTS] 使用者不在語音頻道，跳過朗讀`);
        return;
    }

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

// --- 核心 AI 邏輯 ---

async function getGeminiResponse(userId, prompt, imageParts = [], channelId = null, displayName = 'User', mentionedUserIds = []) {
    try {
        const recentMessages = getChannelBufferMessages(channelId);
        const { finalMode, injectedRule } = determineGroupStrategy(userId, mentionedUserIds, recentMessages);
        
        console.log(`[Mode] Channel ${channelId} / User ${userId} -> ${getModeName(finalMode)}`);
        
        const model = getModel(finalMode);
        const history = getUserHistory(userId);

        const chat = model.startChat({ history, generationConfig: GENERATION_CONFIG });

        let finalPrompt = prompt || '請吐槽這張圖片';
        if (channelId) {
            const bufferText = getChannelBufferText(channelId);
            finalPrompt = `${injectedRule}\n\n${bufferText}\n\n【當前訊息】\n[${displayName}] 說：${prompt || '請吐槽這張圖片'}`;
        }

        const messageParts = [];
        for (const img of imageParts) {
            messageParts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
        }
        messageParts.push({ text: finalPrompt });

        const result = await chat.sendMessage(messageParts);
        const response = result.response.text();

        const historyText = imageParts.length > 0
            ? `[傳送了 ${imageParts.length} 張圖片] ${prompt || ''}`
            : (prompt || '圖片');

        updateUserHistory(userId, 'user', historyText);
        updateUserHistory(userId, 'model', response);

        return response;
    } catch (error) {
        console.error(`Gemini Error (${MODEL_NAME}):`, error.message);
        throw error;
    }
}

async function getGeminiResponseVoice(userId, prompt) {
    try {
        const mode = selectMode(userId);
        const model = getModel(mode, true);
        const history = getUserHistory(userId);

        const chat = model.startChat({
            history,
            generationConfig: { ...GENERATION_CONFIG, maxOutputTokens: 150 },
        });

        const result = await chat.sendMessage([{ text: prompt }]);
        const response = result.response.text().trim();

        updateUserHistory(userId, 'user', prompt);
        updateUserHistory(userId, 'model', response);

        console.log(`[Voice AI] ${userId}: "${prompt}" → "${response}"`);
        return response;
    } catch (error) {
        console.error(`[Voice AI] Gemini Error:`, error.message);
        throw error;
    }
}

async function getShortResponse(userId, message, imageParts = [], channelId = null, displayName = 'User', mentionedUserIds = []) {
    try {
        const recentMessages = getChannelBufferMessages(channelId);
        const { finalMode, injectedRule } = determineGroupStrategy(userId, mentionedUserIds, recentMessages);
        
        const model = getModel(finalMode);
        const history = getUserHistory(userId);

        const shortPrompt = imageParts.length > 0 && !message
            ? `請用大約10~200個字回應或吐槽這張圖片`
            : `請用大約10~200字回應或吐槽訊息：「${message}」`;

        let finalPrompt = shortPrompt;
        if (channelId) {
            const bufferText = getChannelBufferText(channelId);
            finalPrompt = `${injectedRule}\n\n${bufferText}\n\n【當前訊息】\n[${displayName}] 說：${shortPrompt}`;
        }

        const chat = model.startChat({
            history,
            generationConfig: { ...GENERATION_CONFIG, maxOutputTokens: 300 },
        });

        const messageParts = [];
        for (const img of imageParts) {
            messageParts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
        }
        messageParts.push({ text: finalPrompt });

        const result = await chat.sendMessage(messageParts);
        return result.response.text().trim();
    } catch (error) {
        console.error(`Short Response Error:`, error.message);
        return null;
    }
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

// ════════════════════════════════════════════════════════
//  Slash Command 定義
// ════════════════════════════════════════════════════════

const slashCommands = [
    {
        data: new SlashCommandBuilder()
            .setName('ai')
            .setDescription('詢問 AI 問題')
            .addStringOption(opt =>
                opt.setName('question')
                    .setDescription('你想問的問題')
                    .setRequired(true)
            )
            .addAttachmentOption(opt =>
                opt.setName('image')
                    .setDescription('附上圖片（選填）')
                    .setRequired(false)
            ),

        async execute(interaction) {
            if (!process.env.GEMINI_API_KEY) {
                return interaction.reply({ content: '❌ 未設定 API Key', ephemeral: true });
            }

            const userId = interaction.user.id;
            const channelId = interaction.channelId;
            const guildId = interaction.guildId;
            const displayName = interaction.member?.displayName || interaction.user.username;
            const question = interaction.options.getString('question');
            const attachment = interaction.options.getAttachment('image');

            const recentMessages = getChannelBufferMessages(channelId);
            const { finalMode } = determineGroupStrategy(userId, [], recentMessages);
            const modeModule = MODE_MAP[finalMode];
            const thinkingText = modeModule.getThinkingMessage();

            await interaction.reply({ content: thinkingText });

            try {
                const imageParts = [];
                if (attachment) {
                    const imgData = await fetchImageAsBase64(attachment);
                    if (imgData) imageParts.push(imgData);
                }

                const answer = await getGeminiResponse(userId, question, imageParts, channelId, displayName, []);
                
                addChannelMessage(channelId, interaction.client.user.id, 'Bot', answer);

                const chunks = splitMessage(answer);

                await interaction.editReply({ content: chunks[0] });
                for (let i = 1; i < chunks.length; i++) {
                    await interaction.followUp({ content: chunks[i] });
                }

                await speakWithTTS(interaction, answer, guildId);

            } catch (error) {
                const errorMsg = modeModule.getErrorMessage(error);
                await interaction.editReply({ content: errorMsg });
            }
        }
    },
    {
        data: new SlashCommandBuilder()
            .setName('clearai')
            .setDescription('清除你與 AI 的對話記憶'),

        async execute(interaction) {
            const userId = interaction.user.id;
            const mode = selectMode(userId);
            const modeModule = MODE_MAP[mode];
            const clearMsg = modeModule.getClearMemoryMessage();

            clearUserHistory(userId);
            await interaction.reply({ content: clearMsg });
        }
    },
    {
        data: new SlashCommandBuilder()
            .setName('aitts')
            .setDescription('切換 AI 回覆是否自動朗讀（語音頻道）'),

        async execute(interaction) {
            const guildId = interaction.guildId;
            if (!guildId) {
                return interaction.reply({ content: '❌ 此指令只能在伺服器中使用', ephemeral: true });
            }

            const current = isAITTSEnabled(guildId);
            aiTTSEnabled.set(guildId, !current);
            const status = !current ? '🔊 已開啟' : '🔇 已關閉';
            await interaction.reply({ content: `${status} AI 回覆朗讀功能` });
        }
    },
];

// ════════════════════════════════════════════════════════
//  setupAICommands：同時掛載 Slash + 保留事件監聽
// ════════════════════════════════════════════════════════

function setupAICommands(client) {

    for (const cmd of slashCommands) {
        client.commands.set(cmd.data.name, cmd);
    }

    client.on('messageCreate', async message => {
        if (message.author.bot) return;

        const content = message.content?.trim() || '';
        const hasAttachment = message.attachments.size > 0;
        
        const userId = message.author.id;
        const channelId = message.channel.id;
        const displayName = message.member?.displayName || message.author.username;

        if (content || hasAttachment) {
            const logText = content || '[圖片/檔案]';
            addChannelMessage(channelId, userId, displayName, logText);
        }

        if (!content && !hasAttachment) return;

        const guildId = message.guild?.id;
        const isMentioned = message.mentions.has(client.user);
        const mentionedUserIds = message.mentions.users.filter(u => !u.bot).map(u => u.id);

        if (isMentioned) {
            let question = content.replace(/<@!?\d+>/g, '').trim();
            if (!question && !hasAttachment) return;
            if (!process.env.GEMINI_API_KEY) return message.channel.send('❌ 未設定 API Key');

            let thinkingMsg = null;
            try {
                const recentMessages = getChannelBufferMessages(channelId);
                const { finalMode } = determineGroupStrategy(userId, mentionedUserIds, recentMessages);
                const modeModule = MODE_MAP[finalMode];
                
                thinkingMsg = await message.channel.send(modeModule.getThinkingMessage());

                const imageParts = [];
                if (hasAttachment) {
                    for (const [, attachment] of message.attachments) {
                        const imgData = await fetchImageAsBase64(attachment);
                        if (imgData) imageParts.push(imgData);
                    }
                }

                const answer = await getGeminiResponse(userId, question, imageParts, channelId, displayName, mentionedUserIds);
                
                addChannelMessage(channelId, client.user.id, 'Bot', answer);

                if (thinkingMsg) await thinkingMsg.delete().catch(() => {});

                const chunks = splitMessage(answer);
                for (const chunk of chunks) {
                    await message.channel.send(chunk);
                }

                await speakWithTTS(message, answer, guildId);

            } catch (error) {
                if (thinkingMsg) await thinkingMsg.delete().catch(() => {});
                const mode = selectMode(userId);
                const modeModule = MODE_MAP[mode];
                message.channel.send(modeModule.getErrorMessage(error));
            }

        } else {
            if (!process.env.GEMINI_API_KEY) return;

            const cleanedContent = content
                .replace(/<@!?\d+>/g, '')
                .replace(/<@&\d+>/g, '')
                .replace(/<#\d+>/g, '')
                .trim();

            if (!cleanedContent && !hasAttachment) return;

            const urlPattern = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi;
            if (urlPattern.test(cleanedContent)) return;
            if (/^!(gugu|m|stt)/.test(cleanedContent)) return;

            if (Math.random() < RANDOM_REPLY_CHANCE) {
                try {
                    const imageParts = [];
                    if (hasAttachment) {
                        for (const [, attachment] of message.attachments) {
                            const imgData = await fetchImageAsBase64(attachment);
                            if (imgData) imageParts.push(imgData);
                        }
                    }

                    const shortReply = await getShortResponse(userId, cleanedContent, imageParts, channelId, displayName, mentionedUserIds);
                    if (shortReply) {
                        addChannelMessage(channelId, client.user.id, 'Bot', shortReply);
                        
                        await message.channel.send(shortReply);
                        await speakWithTTS(message, shortReply, guildId);
                    }
                } catch (error) {
                    console.error('Random reply error:', error.message);
                }
            }
        }
    });
}

module.exports = { setupAICommands, getGeminiResponse, getGeminiResponseVoice };