const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { SlashCommandBuilder } = require('discord.js');
const { GENERATION_CONFIG } = require('../../config/aiSettings');
const { selectMode, getModeName } = require('./modeSelector');
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
const HISTORY_FETCH_LIMIT = 30;
const HISTORY_PAIR_LIMIT = 10;
const HISTORY_TIME_LIMIT_MS = 10 * 60 * 1000;

// 初始化 API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- AI TTS 開關（每個 Guild 獨立）---
const aiTTSEnabled = new Map();

// --- 使用者記憶清除時間戳 ---
const memoryClearedAt = new Map();

// 圖片快取
const imageCache = new Map();
const IMAGE_CACHE_TTL_MS = 10 * 60 * 1000;

// 差別待遇快取
const botMessageCache = new Map();
const MAX_MODE_CACHE_SIZE = 1000;

// 頻道歷史快取
const historyCache = new Map();
const HISTORY_CACHE_TTL_MS = 30 * 1000; // 快取 30 秒

function recordBotMessageContext(messageId, mode, userId, userName) {
    if (!messageId || !mode) return;
    if (botMessageCache.size >= MAX_MODE_CACHE_SIZE) {
        const firstKey = botMessageCache.keys().next().value;
        botMessageCache.delete(firstKey);
    }
    botMessageCache.set(messageId, { mode, userId, userName });
}

function isAITTSEnabled(guildId) {
    return aiTTSEnabled.get(guildId) ?? true;
}

function clearUserMemory(userId) {
    memoryClearedAt.set(userId, Date.now());
    console.log(`[Memory] 已清除使用者 ${userId} 的對話記憶`);
}

function getMemoryClearTime(userId) {
    return memoryClearedAt.get(userId) ?? 0;
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

// ════════════════════════════════════════════════════════
//  取得模式的人格描述（優先用 shortDescription，fallback 截取 prompt 前 150 字）
// ════════════════════════════════════════════════════════
function getModeDescription(mode) {
    const modeModule = MODE_MAP[mode];
    if (!modeModule) return '（未知模式）';
    if (modeModule.shortDescription) return modeModule.shortDescription;

    // fallback：從 system prompt 截取前 150 字
    const prompt = getSystemPrompt(mode);
    if (!prompt) return '（無法取得描述）';
    const trimmed = prompt.replace(/\n/g, ' ').trim();
    return trimmed.length > 150 ? trimmed.slice(0, 150) + '...' : trimmed;
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

// ════════════════════════════════════════════════════════
//  帶快取的圖片下載函式
// ════════════════════════════════════════════════════════
async function fetchImageAsBase64(attachment) {
    const sizeLimit = MAX_IMAGE_SIZE_MB * 1024 * 1024;
    if (attachment.size > sizeLimit) return null;

    const supportedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];
    const mimeType = attachment.contentType?.split(';')[0] || 'image/jpeg';
    if (!supportedTypes.includes(mimeType)) return null;

    const cached = imageCache.get(attachment.url);
    if (cached && (Date.now() - cached.cachedAt) < IMAGE_CACHE_TTL_MS) {
        console.log(`[Image] 快取命中：${attachment.url.slice(0, 60)}...`);
        return { base64: cached.base64, mimeType: cached.mimeType };
    }

    try {
        const response = await fetch(attachment.url);
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');

        imageCache.set(attachment.url, { base64, mimeType, cachedAt: Date.now() });
        console.log(`[Image] 已下載並快取：${attachment.url.slice(0, 60)}...`);

        return { base64, mimeType };
    } catch (err) {
        console.error(`[Image] 下載圖片失敗：`, err.message);
        return null;
    }
}

// ════════════════════════════════════════════════════════
//  定期清除過期快取
// ════════════════════════════════════════════════════════
setInterval(() => {
    const now = Date.now();
    let cleared = 0;
    for (const [url, entry] of imageCache.entries()) {
        if (now - entry.cachedAt >= IMAGE_CACHE_TTL_MS) {
            imageCache.delete(url);
            cleared++;
        }
    }
    if (cleared > 0) console.log(`[Image Cache] 已清除 ${cleared} 筆過期快取`);
}, IMAGE_CACHE_TTL_MS);

// 定期清除過期的歷史快取
setInterval(() => {
    const now = Date.now();
    let cleared = 0;
    for (const [channelId, entry] of historyCache.entries()) {
        if (now - entry.cachedAt >= HISTORY_CACHE_TTL_MS) {
            historyCache.delete(channelId);
            cleared++;
        }
    }
    if (cleared > 0) console.log(`[History Cache] 已清除 ${cleared} 個過期頻道快取`);
}, HISTORY_CACHE_TTL_MS);

// ════════════════════════════════════════════════════════
//  共用函式：將 attachments 轉成 imageParts
// ════════════════════════════════════════════════════════
async function processAttachments(attachments) {
    const imageParts = [];
    if (!attachments || attachments.size === 0) return imageParts;

    for (const [, attachment] of attachments) {
        const imgData = await fetchImageAsBase64(attachment);
        if (imgData) {
            imageParts.push({
                mimeType: imgData.mimeType,
                data: imgData.base64
            });
        }
    }
    return imageParts;
}

// ════════════════════════════════════════════════════════
//  合併連續相同 role 的訊息
// ════════════════════════════════════════════════════════
function mergeConsecutiveRoles(history) {
    if (!history || history.length === 0) return [];
    const merged = [];
    let current = { ...history[0] };

    for (let i = 1; i < history.length; i++) {
        const next = history[i];
        if (next.role === current.role) {
            current.parts = [...current.parts, ...next.parts];
        } else {
            merged.push(current);
            current = { ...next };
        }
    }
    merged.push(current);
    return merged;
}

// ════════════════════════════════════════════════════════
//  判斷 Bot 訊息是否屬於指定使用者的對話
// ════════════════════════════════════════════════════════
function isBotReplyToUser(msg, userId, fetchedMessages) {
    if (msg.reference?.messageId) {
        const refMsg = fetchedMessages.get(msg.reference.messageId);
        if (refMsg && refMsg.author.id === userId) return true;
        if (!refMsg || refMsg.author.id !== userId) return false;
    }
    return true;
}

// ════════════════════════════════════════════════════════
//  從頻道抓取使用者 + Bot 的對話紀錄（已加入快取）
// ════════════════════════════════════════════════════════
async function fetchUserChannelHistory(channel, userId, currentMessageId, botId) {
    try {
        const channelId = channel.id;
        const now = Date.now();

        // 檢查歷史快取
        let fetched;
        const cached = historyCache.get(channelId);
        if (cached && (now - cached.cachedAt) < HISTORY_CACHE_TTL_MS) {
            console.log(`[History Cache] 命中快取：${channelId}`);
            fetched = cached.messages;
        } else {
            fetched = await channel.messages.fetch({ limit: HISTORY_FETCH_LIMIT });
            historyCache.set(channelId, { messages: fetched, cachedAt: now });
            console.log(`[History Cache] 已更新快取：${channelId}`);
        }

        const currentMsg = fetched.get(currentMessageId);
        const currentTimestamp = currentMsg?.createdTimestamp ?? Date.now();
        const clearTime = getMemoryClearTime(userId);

        let relevantMessages = fetched
            .filter(msg => {
                if (msg.id === currentMessageId) return false;
                if ((currentTimestamp - msg.createdTimestamp) > HISTORY_TIME_LIMIT_MS) return false;
                if (msg.createdTimestamp <= clearTime) return false;
                if (!msg.content?.trim().length && msg.attachments.size === 0) return false;

                if (msg.author.id === userId) return true;
                if (msg.author.id === botId) {
                    return isBotReplyToUser(msg, userId, fetched);
                }
                return false;
            })
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        while (relevantMessages.size > 0) {
            const first = relevantMessages.first();
            if (first.author.id === botId) {
                relevantMessages = relevantMessages.filter(m => m.id !== first.id);
            } else {
                break;
            }
        }

        relevantMessages = relevantMessages.last(HISTORY_PAIR_LIMIT);

        const history = [];
        for (const msg of relevantMessages.values()) {
            const parts = [];

            if (msg.attachments.size > 0) {
                const imgParts = await processAttachments(msg.attachments);
                imgParts.forEach(img => {
                    parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
                });
            }

            if (msg.content?.trim().length > 0) {
                parts.push({ text: msg.content.trim() });
            }

            if (parts.length === 0) {
                parts.push({ text: '[使用者傳了一張無法讀取的圖片]' });
            }

            history.push({
                role: msg.author.id === botId ? 'model' : 'user',
                parts
            });
        }

        let finalHistory = mergeConsecutiveRoles(history);

        while (finalHistory.length > 0 && finalHistory[0].role === 'model') {
            finalHistory.shift();
        }

        console.log(`[History] 載入 ${finalHistory.length} 筆對話紀錄`);
        return finalHistory;

    } catch (err) {
        console.error('[History] 抓取頻道歷史失敗：', err.message);
        return [];
    }
}

// ════════════════════════════════════════════════════════
//  取得引用訊息並建立帶有「差別待遇」邏輯的 Prompt
// ════════════════════════════════════════════════════════
async function fetchReferencedMessage(message) {
    if (!message.reference?.messageId) return null;
    try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        return refMsg ?? null;
    } catch {
        return null;
    }
}

async function buildMessagePartsWithReference(message, question, imageParts, botId, currentMode, currentUserId) {
    const parts = [];
    const refMsg = await fetchReferencedMessage(message);

    if (refMsg) {
        const refAuthor = refMsg.author.username;
        const refContent = refMsg.content?.trim();
        const isSelf = refMsg.author.id === botId;
        let refText = '';

        if (isSelf) {
            const cachedContext = botMessageCache.get(refMsg.id);
            const currentModeName = getModeName(currentMode) || currentMode;

            if (cachedContext) {
                const { mode: refMode, userId: refTargetId, userName: refTargetName } = cachedContext;
                const refModeName = getModeName(refMode) || refMode;

                if (refTargetId !== currentUserId) {
                    // ── ① 跨使用者引用：附上 refMode 的人格描述 ──
                    const refModeDesc = getModeDescription(refMode);
                    refText = `（系統提示：當前使用者回覆了你之前對另一位專屬用戶「${refTargetName}」說的話。`
                            + `\n你當時對 ${refTargetName} 的人格是「${refModeName}」，其人格描述為：${refModeDesc}`
                            + `\n你當時說的話是：「${refContent}」）`
                            + `\n（請注意：你對不同人有不同的態度。請用你現在對待【當前使用者】的專屬態度「${currentModeName}」來回應他，可以展現出你的差別待遇）\n`;

                } else if (refMode !== currentMode) {
                    // ── ② 同人不同模式：附上舊模式的人格描述，強調現在已切換 ──
                    const refModeDesc = getModeDescription(refMode);
                    refText = `（系統提示：使用者回覆了你之前對他說的話。`
                            + `\n你當時的人格是「${refModeName}」，其人格描述為：${refModeDesc}`
                            + `\n你當時說的話是：「${refContent}」`
                            + `\n但你現在對他的人格已切換為「${currentModeName}」，請用現在的態度回應他）\n`;

                } else {
                    // ── ③ 普通引用：同人同模式，不需要額外描述 ──
                    refText = `（系統提示：使用者回覆了你之前對他說的話：`;
                    if (refContent) refText += `「${refContent}」`;
                    refText += `）\n`;
                }
            } else {
                // 快取遺失 fallback
                refText = `（系統提示：使用者回覆了你之前說過的話：`;
                if (refContent) refText += `「${refContent}」`;
                refText += `）\n`;
            }
        } else {
            // 引用的是其他人的訊息
            refText = `（系統提示：使用者回覆了 ${refAuthor} 說的話：`;
            if (refContent) refText += `「${refContent}」`;
            refText += `）\n`;
        }

        if (refMsg.attachments.size > 0) {
            const refImageParts = await processAttachments(refMsg.attachments);
            refImageParts.forEach(img => parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } }));
            refText += refContent ? ' [附帶圖片]' : ' [一張圖片]';
        }

        parts.push({ text: refText });
    }

    imageParts.forEach(img => parts.push({ inlineData: img }));
    parts.push({ text: question || '請吐槽這張圖片' });

    return parts;
}

// ════════════════════════════════════════════════════════
//  工具函式
// ════════════════════════════════════════════════════════
function getUserMode(userId, message) {
    const mode = selectMode(userId, message);
    console.log(`[Mode] User ${userId} -> ${getModeName(mode)}`);
    return mode;
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

// ════════════════════════════════════════════════════════
//  核心 AI 邏輯
// ════════════════════════════════════════════════════════
async function getGeminiResponse(userId, prompt, imageParts = [], channel = null, messageId = null, botId = null, message = null, mode = null) {
    try {
        if (!mode) mode = getUserMode(userId, prompt);
        const model = getModel(mode);

        const history = channel
            ? await fetchUserChannelHistory(channel, userId, messageId, botId)
            : [];

        const chat = model.startChat({ history, generationConfig: GENERATION_CONFIG });

        const messageParts = message
            ? await buildMessagePartsWithReference(message, prompt, imageParts, botId, mode, userId)
            : [
                ...imageParts.map(img => ({ inlineData: img })),
                { text: prompt || '請吐槽這張圖片' }
            ];

        const result = await chat.sendMessage(messageParts);
        return result.response.text();
    } catch (error) {
        console.error(`Gemini Error (${MODEL_NAME}):`, error.message);
        throw error;
    }
}

async function getGeminiResponseVoice(userId, prompt, channel = null, messageId = null, botId = null, mode = null) {
    try {
        if (!mode) mode = getUserMode(userId, prompt);
        const model = getModel(mode, true);

        const history = channel
            ? await fetchUserChannelHistory(channel, userId, messageId, botId)
            : [];

        const chat = model.startChat({
            history,
            generationConfig: { ...GENERATION_CONFIG, maxOutputTokens: 150 },
        });

        const result = await chat.sendMessage([{ text: prompt }]);
        const response = result.response.text().trim();

        console.log(`[Voice AI] ${userId}: "${prompt}" → "${response}"`);
        return response;
    } catch (error) {
        console.error(`[Voice AI] Gemini Error:`, error.message);
        throw error;
    }
}

async function getShortResponse(userId, promptText, imageParts = [], channel = null, messageId = null, botId = null, message = null, mode = null) {
    try {
        if (!mode) mode = getUserMode(userId, promptText);
        const model = getModel(mode);

        const history = channel
            ? await fetchUserChannelHistory(channel, userId, messageId, botId)
            : [];

        const shortPrompt = imageParts.length > 0 && !promptText
            ? `請用大約10~200個字回應或吐槽這張圖片`
            : `請用大約10~200字回應或吐槽訊息：「${promptText}」`;

        const chat = model.startChat({
            history,
            generationConfig: { ...GENERATION_CONFIG, maxOutputTokens: 300 },
        });

        const messageParts = message
            ? await buildMessagePartsWithReference(message, shortPrompt, imageParts, botId, mode, userId)
            : [
                ...imageParts.map(img => ({ inlineData: img })),
                { text: shortPrompt }
            ];

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
    let remaining = text;
    while (remaining.length > 0) {
        let chunk = remaining.slice(0, maxLength);
        const lastNewLine = chunk.lastIndexOf('\n');
        if (lastNewLine > maxLength * 0.8) {
            chunk = remaining.slice(0, lastNewLine);
            remaining = remaining.slice(lastNewLine + 1);
        } else {
            remaining = remaining.slice(maxLength);
        }
        chunks.push(chunk);
    }
    return chunks;
}

// ════════════════════════════════════════════════════════
//  Slash Command 定義
// ════════════════════════════════════════════════════════
const slashCommands = [
    // ── /ai ──
    {
        data: new SlashCommandBuilder()
            .setName('ai')
            .setDescription('詢問 AI 問題')
            .addStringOption(opt =>
                opt.setName('question').setDescription('你想問的問題').setRequired(true)
            )
            .addAttachmentOption(opt =>
                opt.setName('image').setDescription('附上圖片（選填）').setRequired(false)
            ),

        async execute(interaction) {
            if (!process.env.GEMINI_API_KEY) {
                return interaction.reply({ content: '❌ 未設定 API Key', ephemeral: true });
            }

            const userId = interaction.user.id;
            const userName = interaction.user.username;
            const guildId = interaction.guildId;
            const botId = interaction.client.user.id;
            const question = interaction.options.getString('question');
            const attachment = interaction.options.getAttachment('image');

            const mode = getUserMode(userId, question);
            const modeModule = MODE_MAP[mode];
            const thinkingText = modeModule.getThinkingMessage();

            await interaction.reply({ content: thinkingText });

            try {
                let imageParts = [];
                if (attachment) {
                    imageParts = await processAttachments(new Map([[attachment.id, attachment]]));
                }

                const answer = await getGeminiResponse(userId, question, imageParts, interaction.channel, interaction.id, botId, null, mode);
                const chunks = splitMessage(answer);

                await interaction.editReply({ content: chunks[0] });
                const replyMsg = await interaction.fetchReply();
                recordBotMessageContext(replyMsg.id, mode, userId, userName);

                for (let i = 1; i < chunks.length; i++) {
                    const followUpMsg = await interaction.followUp({ content: chunks[i], fetchReply: true });
                    recordBotMessageContext(followUpMsg.id, mode, userId, userName);
                }

                await speakWithTTS(interaction, answer, guildId);
            } catch (error) {
                const errorMsg = modeModule.getErrorMessage(error);
                await interaction.editReply({ content: errorMsg });
            }
        }
    },

    // ── /clearai ──
    {
        data: new SlashCommandBuilder()
            .setName('clearai')
            .setDescription('清除你與 AI 的對話記憶'),

        async execute(interaction) {
            const userId = interaction.user.id;
            const mode = selectMode(userId, '');
            const modeModule = MODE_MAP[mode];

            clearUserMemory(userId);

            const clearMsg = modeModule.getClearMemoryMessage();
            await interaction.reply({ content: clearMsg });
        }
    },

    // ── /aitts ──
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
//  setupAICommands
// ════════════════════════════════════════════════════════
function setupAICommands(client) {
    for (const cmd of slashCommands) {
        client.commands.set(cmd.data.name, cmd);
    }

    client.on('messageCreate', async message => {
        if (message.author.bot) return;

        const hasAttachment = message.attachments.size > 0;
        const content = message.content?.trim() || '';
        if (!content && !hasAttachment) return;

        const userId = message.author.id;
        const userName = message.author.username;
        const guildId = message.guild?.id;
        const botId = client.user.id;
        const channel = message.channel;
        const messageId = message.id;
        const isMentioned = message.mentions.has(client.user);

        if (isMentioned) {
            let question = content.replace(/<@!?\d+>/g, '').trim();
            if (!question && !hasAttachment) return;
            if (!process.env.GEMINI_API_KEY) return message.channel.send('❌ 未設定 API Key');

            let thinkingMsg = null;
            try {
                const mode = getUserMode(userId, question || '圖片');
                const modeModule = MODE_MAP[mode];
                thinkingMsg = await message.channel.send(modeModule.getThinkingMessage());

                const imageParts = await processAttachments(message.attachments);

                const answer = await getGeminiResponse(userId, question, imageParts, channel, messageId, botId, message, mode);
                if (thinkingMsg) await thinkingMsg.delete().catch(() => {});

                const chunks = splitMessage(answer);
                for (const chunk of chunks) {
                    const sentMsg = await message.channel.send(chunk);
                    recordBotMessageContext(sentMsg.id, mode, userId, userName);
                }

                await speakWithTTS(message, answer, guildId);
            } catch (error) {
                if (thinkingMsg) await thinkingMsg.delete().catch(() => {});
                const mode = selectMode(userId, question || '圖片');
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
                    const mode = getUserMode(userId, cleanedContent);
                    const imageParts = await processAttachments(message.attachments);

                    const shortReply = await getShortResponse(userId, cleanedContent, imageParts, channel, messageId, botId, message, mode);
                    if (shortReply) {
                        const sentMsg = await message.channel.send(shortReply);
                        recordBotMessageContext(sentMsg.id, mode, userId, userName);
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