const { SlashCommandBuilder } = require('discord.js');
const { selectMode } = require('./modeSelector');

const {
    MODE_MAP, getUserMode,
    getGeminiResponse, getGeminiResponseVoice, getShortResponse,
} = require('./aiCore');

const {
    clearUserMemory, isAITTSEnabled, setAITTSEnabled,
    recordBotMessageContext, processMessageContent, checkRateLimit,
    withTyping, speakWithTTS, splitMessage,
} = require('./aiUtils');

const RANDOM_REPLY_CHANCE = 0.15; // 隨機回覆機率

// ════════════════════════════════════════════════════════
//  Slash Command 定義
// ════════════════════════════════════════════════════════
const slashCommands = [
    {
        data: new SlashCommandBuilder()
            .setName('ai')
            .setDescription('詢問 AI 問題')
            .addStringOption(opt => opt.setName('question').setDescription('你想問的問題').setRequired(true))
            .addAttachmentOption(opt => opt.setName('image').setDescription('附上圖片（選填）').setRequired(false)),

        async execute(interaction) {
            const userId   = interaction.user.id;
            const userName = interaction.user.username;
            const guildId  = interaction.guildId;
            const botId    = interaction.client.user.id;
            const mode     = getUserMode(userId, interaction.options.getString('question'));
            const modeModule = MODE_MAP[mode];

            if (!checkRateLimit(userId)) {
                return interaction.reply({ content: '⚠️ 你的請求太頻繁了，請稍後再試！', ephemeral: true });
            }

            await interaction.deferReply();

            try {
                const rawQuestion = interaction.options.getString('question');
                const attachments = interaction.options.getAttachment('image') 
                    ? new Map([[interaction.options.getAttachment('image').id, interaction.options.getAttachment('image')]])
                    : null;
                
                // 呼叫統一的訊息處理函式
                const { cleanedText: question, imageParts } = await processMessageContent(rawQuestion, attachments);

                const answer = await getGeminiResponse(userId, question, imageParts, interaction.channel, interaction.id, botId, null, mode);
                const chunks = splitMessage(answer);

                const replyMsg = await interaction.editReply({ content: chunks[0] });
                recordBotMessageContext(replyMsg.id, mode, userId, userName);

                for (let i = 1; i < chunks.length; i++) {
                    const followUpMsg = await interaction.followUp({ content: chunks[i], fetchReply: true });
                    recordBotMessageContext(followUpMsg.id, mode, userId, userName);
                }

                await speakWithTTS(interaction, answer, guildId);
            } catch (error) {
                await interaction.editReply({ content: modeModule.getErrorMessage(error) });
            }
        }
    },
    {
        data: new SlashCommandBuilder()
            .setName('clearai')
            .setDescription('清除你與 AI 的對話記憶'),
        async execute(interaction) {
            const userId = interaction.user.id;
            clearUserMemory(userId);
            await interaction.reply({ content: MODE_MAP[selectMode(userId, '')].getClearMemoryMessage() });
        }
    },
    {
        data: new SlashCommandBuilder()
            .setName('aitts')
            .setDescription('切換 AI 回覆是否自動朗讀（語音頻道）'),
        async execute(interaction) {
            const guildId = interaction.guildId;
            if (!guildId) return interaction.reply({ content: '❌ 此指令只能在伺服器中使用', ephemeral: true });
            const current = isAITTSEnabled(guildId);
            setAITTSEnabled(guildId, !current);
            await interaction.reply({ content: `${!current ? '🔊 已開啟' : '🔇 已關閉'} AI 回覆朗讀功能` });
        }
    }
];

// ════════════════════════════════════════════════════════
//  事件處理邏輯分離
// ════════════════════════════════════════════════════════
async function handleMentionMessage(message, client, context) {
    const { userId, userName, guildId, botId, channel, content, hasAttachment } = context;
    const rawQuestion = content.replace(/<@!?\d+>/g, '').trim();

    // 只有 @機器人，無文字且無附件
    if (!rawQuestion && !hasAttachment) {
        try {
            const mode = getUserMode(userId, '');
            const greetPrompt = '使用者只 @ 了你，沒有說任何話。請根據你的人格設定，用 10 字以內回應「怎麼了」的意思。';
            const answer = await withTyping(channel, () => getGeminiResponse(userId, greetPrompt, [], channel, message.id, botId, null, mode));
            const sentMsg = await channel.send(answer);
            recordBotMessageContext(sentMsg.id, mode, userId, userName);
            await speakWithTTS(message, answer, guildId);
        } catch (error) {
            console.error('Greet reply error:', error.message);
        }
        return;
    }

    try {
        const mode = getUserMode(userId, rawQuestion || '圖片');
        
        // 提及情況下，正常處理所有網址與圖片
        const { cleanedText: question, imageParts } = await processMessageContent(rawQuestion, message.attachments);

        const answer = await withTyping(channel, () => getGeminiResponse(userId, question, imageParts, channel, message.id, botId, message, mode));
        const chunks = splitMessage(answer);
        
        for (const chunk of chunks) {
            const sentMsg = await channel.send(chunk);
            recordBotMessageContext(sentMsg.id, mode, userId, userName);
        }
        await speakWithTTS(message, answer, guildId);
    } catch (error) {
        const mode = selectMode(userId, rawQuestion || '圖片');
        await channel.send(MODE_MAP[mode].getErrorMessage(error));
    }
}

async function handleRandomReply(message, client, context) {
    const { userId, userName, guildId, botId, channel, content, hasAttachment } = context;
    
    const rawCleaned = content.replace(/<@!?\d+>/g, '').replace(/<@&\d+>/g, '').replace(/<#\d+>/g, '').trim();
    if (!rawCleaned && !hasAttachment) return;
    if (/^!(gugu|m|stt)/.test(rawCleaned)) return;

    // 【新增過濾】：在隨機回覆情況下，若訊息包含任何網址，則直接忽略不處理
    if (/(https?:\/\/[^\s]+)/.test(rawCleaned)) {
        return; 
    }

    // 1. 先進行單一的隨機機率判定
    if (Math.random() < RANDOM_REPLY_CHANCE) {
        // 2. 確定觸發後，才檢查速率限制
        if (!checkRateLimit(userId)) {
            return; 
        }

        try {
            // 由於上面已經排除了包含網址的訊息，這裡的 processMessageContent 不會再觸發網址下載
            const { cleanedText: cleanedContent, imageParts } = await processMessageContent(rawCleaned, message.attachments);
            const mode = getUserMode(userId, cleanedContent);

            const shortReply = await withTyping(channel, () => getShortResponse(userId, cleanedContent, imageParts, channel, message.id, botId, message, mode));
            
            if (shortReply) {
                const sentMsg = await channel.send(shortReply);
                recordBotMessageContext(sentMsg.id, mode, userId, userName);
                await speakWithTTS(message, shortReply, guildId);
            }
        } catch (error) {
            console.error('Random reply error:', error.message);
        }
    }
}

// ════════════════════════════════════════════════════════
//  主程式進入點
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

        const context = {
            userId: message.author.id,
            userName: message.author.username,
            guildId: message.guild?.id,
            botId: client.user.id,
            channel: message.channel,
            content,
            hasAttachment
        };

        const isMentioned = message.mentions.has(client.user);
        const hasOtherMention = message.mentions.users.some(u => u.id !== context.botId) || message.mentions.roles.size > 0;

        if (hasOtherMention) return;

        // 處理直接提及機器人的情況
        if (isMentioned) {
            if (!checkRateLimit(context.userId)) {
                message.channel.send('⚠️ 你的請求太頻繁了，請稍後再試！')
                    .then(m => setTimeout(() => m.delete().catch(()=>{}), 5000));
                return;
            }
            await handleMentionMessage(message, client, context);
        } else {
            // 隨機回覆
            await handleRandomReply(message, client, context);
        }
    });
}

module.exports = { setupAICommands, getGeminiResponse, getGeminiResponseVoice };