const { SlashCommandBuilder } = require('discord.js');
const { selectMode } = require('./modeSelector');

const {
    MODE_MAP,
    getUserMode,
    getGeminiResponse,
    getGeminiResponseVoice,
    getShortResponse,
} = require('./aiCore');

const {
    clearUserMemory,
    isAITTSEnabled, setAITTSEnabled,
    recordBotMessageContext,
    processAttachments,
    processCustomEmojis,
    withTyping, speakWithTTS, splitMessage,
} = require('./aiUtils');

const RANDOM_REPLY_CHANCE = 0.15;

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
            if (!process.env.GEMINI_API_KEY)
                return interaction.reply({ content: '❌ 未設定 API Key', ephemeral: true });

            const userId   = interaction.user.id;
            const userName = interaction.user.username;
            const guildId  = interaction.guildId;
            const botId    = interaction.client.user.id;
            const attachment = interaction.options.getAttachment('image');
            const mode     = getUserMode(userId, interaction.options.getString('question'));
            const modeModule = MODE_MAP[mode];

            await interaction.deferReply();

            try {
                // 處理自訂 Emoji（slash command 的 question 欄位也可能含 emoji）
                const rawQuestion = interaction.options.getString('question');
                const { cleanedText: question, emojiParts } = await processCustomEmojis(rawQuestion);

                let attachmentParts = [];
                if (attachment)
                    attachmentParts = await processAttachments(new Map([[attachment.id, attachment]]));

                const imageParts = [...emojiParts, ...attachmentParts];

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
                await interaction.editReply({ content: modeModule.getErrorMessage(error) });
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
            clearUserMemory(userId);
            await interaction.reply({ content: MODE_MAP[mode].getClearMemoryMessage() });
        }
    },

    // ── /aitts ──
    {
        data: new SlashCommandBuilder()
            .setName('aitts')
            .setDescription('切換 AI 回覆是否自動朗讀（語音頻道）'),

        async execute(interaction) {
            const guildId = interaction.guildId;
            if (!guildId)
                return interaction.reply({ content: '❌ 此指令只能在伺服器中使用', ephemeral: true });

            const current = isAITTSEnabled(guildId);
            setAITTSEnabled(guildId, !current);
            const status = !current ? '\U0001F50A 已開啟' : '\U0001F507 已關閉';
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

        const userId   = message.author.id;
        const userName = message.author.username;
        const guildId  = message.guild?.id;
        const botId    = client.user.id;
        const channel  = message.channel;
        const messageId = message.id;
        const isMentioned = message.mentions.has(client.user);

        // ── @ 提及 ──
        if (isMentioned) {
            const rawQuestion = content.replace(/<@!?\d+>/g, '').trim();
            if (!rawQuestion && !hasAttachment) return;
            if (!process.env.GEMINI_API_KEY) return message.channel.send('❌ 未設定 API Key');

            try {
                const mode = getUserMode(userId, rawQuestion || '圖片');

                // 處理自訂 Emoji：取得清理後文字 + emoji 圖片
                const { cleanedText: question, emojiParts } = await processCustomEmojis(rawQuestion);
                const attachmentParts = await processAttachments(message.attachments);
                const imageParts = [...emojiParts, ...attachmentParts];

                const answer = await withTyping(message.channel, () =>
                    getGeminiResponse(userId, question, imageParts, channel, messageId, botId, message, mode)
                );

                const chunks = splitMessage(answer);
                for (const chunk of chunks) {
                    const sentMsg = await message.channel.send(chunk);
                    recordBotMessageContext(sentMsg.id, mode, userId, userName);
                }
                await speakWithTTS(message, answer, guildId);
            } catch (error) {
                const mode = selectMode(userId, content.replace(/<@!?\d+>/g, '').trim() || '圖片');
                message.channel.send(MODE_MAP[mode].getErrorMessage(error));
            }

        // ── 隨機回覆 ──
        } else {
            if (!process.env.GEMINI_API_KEY) return;

            const rawCleaned = content
                .replace(/<@!?\d+>/g, '')
                .replace(/<@&\d+>/g, '')
                .replace(/<#\d+>/g, '')
                .trim();

            if (!rawCleaned && !hasAttachment) return;
            if (/(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi.test(rawCleaned)) return;
            if (/^!(gugu|m|stt)/.test(rawCleaned)) return;

            if (Math.random() < RANDOM_REPLY_CHANCE) {
                try {
                    // 處理自訂 Emoji：取得清理後文字 + emoji 圖片
                    const { cleanedText: cleanedContent, emojiParts } = await processCustomEmojis(rawCleaned);
                    const mode = getUserMode(userId, cleanedContent);
                    const attachmentParts = await processAttachments(message.attachments);
                    const imageParts = [...emojiParts, ...attachmentParts];

                    const shortReply = await withTyping(message.channel, () =>
                        getShortResponse(userId, cleanedContent, imageParts, channel, messageId, botId, message, mode)
                    );

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
