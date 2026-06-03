const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const {
    selectMode,
    getModeName,
    setUserMode,
    getUserModeOverride,
    AVAILABLE_MODES,
} = require('./modeSelector');

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
    processImageUrls,
    processEmbeds,
    hasMissingSignature,
    withTyping, speakWithTTS, splitMessage,
} = require('./aiUtils');

const {
    DEFAULT_CHANCE,
    getReplyChance,
    setReplyChance,
    resetReplyChance,
    isChannelDisabled,
    toggleChannel,
} = require('./aiChance');

const SETMODE_ALLOWED_USER_ID = '598054316510806017';

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
                console.error('❌ 未設定 API Key');
                await interaction.deferReply();
                return interaction.deleteReply().catch(() => {});
            }

            const userId     = interaction.user.id;
            const userName   = interaction.user.username;
            const guildId    = interaction.guildId;
            const botId      = interaction.client.user.id;
            const attachment = interaction.options.getAttachment('image');
            const mode       = getUserMode(userId, interaction.options.getString('question'));

            await interaction.deferReply();

            try {
                const rawQuestion = interaction.options.getString('question');
                const { cleanedText: question, emojiParts } = await processCustomEmojis(rawQuestion);

                const urlImagePartsRaw = await processImageUrls(question);
                const urlImageParts = urlImagePartsRaw.map(part => {
                    if (part.type === 'missing_signature') {
                        return {
                            type: 'text',
                            text: '[系統提示：使用者傳送的 Discord 圖片網址缺少了安全簽名參數(?ex=...&is=...)，導致權限不足無法讀取。請直接吐槽使用者複製連結時把後面的參數弄丟了，叫他重新上傳圖片或給完整的連結。]'
                        };
                    }
                    return part;
                });

                let attachmentParts = [];
                if (attachment)
                    attachmentParts = await processAttachments(new Map([[attachment.id, attachment]]));

                const imageParts = [...emojiParts, ...urlImageParts, ...attachmentParts];

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
                // 發生錯誤時不回覆使用者，僅在後台記錄，並刪除思考中的狀態
                console.error('Slash command /ai error:', error.message);
                await interaction.deleteReply().catch(() => {});
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
                return interaction.reply({ content: '❌ 此指令只能在伺服器中使用', flags: MessageFlags.Ephemeral });

            const current = isAITTSEnabled(guildId);
            setAITTSEnabled(guildId, !current);
            const status = !current ? '🔊 已開啟' : '🔇 已關閉';
            await interaction.reply({ content: `${status} AI 回覆朗讀功能` });
        }
    },

    // ── /setmode ──
    {
        data: new SlashCommandBuilder()
            .setName('setmode')
            .setDescription('設定指定使用者的 AI 人格模式')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .setDMPermission(false)
            .addUserOption(opt =>
                opt.setName('target')
                    .setDescription('要設定的使用者（不填則設定自己）')
                    .setRequired(false)
            )
            .addStringOption(opt =>
                opt.setName('mode')
                    .setDescription('模式名稱（不填則重置為預設）')
                    .setRequired(false)
            ),

        async execute(interaction) {
            if (interaction.user.id !== SETMODE_ALLOWED_USER_ID) {
                return interaction.reply({
                    content: '❌ 你沒有權限使用此指令。',
                    flags: MessageFlags.Ephemeral,
                });
            }

            const targetUser = interaction.options.getUser('target') ?? interaction.user;
            const selected   = interaction.options.getString('mode')?.trim().toLowerCase() ?? null;
            const targetId   = targetUser.id;

            if (!selected) {
                setUserMode(targetId, null);
                const defaultMode = selectMode(targetId, '');
                return interaction.reply({
                    content: `🔄 已重置 **${targetUser.username}** 的模式為預設：**${getModeName(defaultMode)}**`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const matched = AVAILABLE_MODES.find(m => m.toLowerCase() === selected);
            if (!matched) {
                return interaction.reply({
                    content: `❌ 無效的模式名稱：\`${selected}\``,
                    flags: MessageFlags.Ephemeral,
                });
            }

            setUserMode(targetId, matched);
            return interaction.reply({
                content: `✅ 已將 **${targetUser.username}** 的 AI 模式設為：**${getModeName(matched)}**`,
                flags: MessageFlags.Ephemeral,
            });
        }
    },

    // ── /setchance ──
    {
        data: new SlashCommandBuilder()
            .setName('setchance')
            .setDescription('設定本伺服器的 AI 隨機回覆機率')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .setDMPermission(false)
            .addNumberOption(opt =>
                opt.setName('chance')
                    .setDescription(`機率 0~100（%），不填則重置為預設值 ${(DEFAULT_CHANCE * 100).toFixed(0)}%`)
                    .setMinValue(0)
                    .setMaxValue(100)
                    .setRequired(false)
            ),

        async execute(interaction) {
            const guildId = interaction.guildId;
            if (!guildId) {
                return interaction.reply({
                    content: '❌ 此指令只能在伺服器中使用',
                    flags: MessageFlags.Ephemeral,
                });
            }

            const raw = interaction.options.getNumber('chance');

            if (raw === null) {
                const defaultChance = resetReplyChance(guildId);
                return interaction.reply({
                    content: `🔄 已重置本伺服器的隨機回覆機率為預設值：**${(defaultChance * 100).toFixed(1)}%**`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const chance = raw / 100;
            const result = setReplyChance(guildId, chance);

            if (!result.success) {
                return interaction.reply({
                    content: `❌ 設定失敗：${result.error}`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const display = (result.chance * 100).toFixed(1);

            let hint = '';
            if (result.chance === 0)      hint = '\n> ⚠️ 機率為 0%，AI 將不會主動隨機回覆。';
            else if (result.chance === 1) hint = '\n> ⚠️ 機率為 100%，AI 將對每則訊息都隨機回覆。';
            else if (result.chance > 0.5) hint = '\n> ⚠️ 機率偏高，AI 可能會非常頻繁地回覆。';

            return interaction.reply({
                content: `✅ 已將本伺服器的 AI 隨機回覆機率設為 **${display}%**${hint}`,
                flags: MessageFlags.Ephemeral,
            });
        }
    },

    // ── /togglechance ──
    {
        data: new SlashCommandBuilder()
            .setName('togglechance')
            .setDescription('切換本頻道的 AI 隨機回覆開關（不影響其他頻道）')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .setDMPermission(false),

        async execute(interaction) {
            const guildId   = interaction.guildId;
            const channelId = interaction.channelId;

            if (!guildId) {
                return interaction.reply({
                    content: '❌ 此指令只能在伺服器中使用',
                    flags: MessageFlags.Ephemeral,
                });
            }

            const { disabled } = toggleChannel(channelId);
            const channelMention = `<#${channelId}>`;

            return interaction.reply({
                content: disabled
                    ? `🔕 已關閉 ${channelMention} 的 AI 隨機回覆（@ 提及仍有效）`
                    : `🔔 已開啟 ${channelMention} 的 AI 隨機回覆`,
                flags: MessageFlags.Ephemeral,
            });
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

        const hasLikelyImageLink = /(https?:\/\/[^\s)\]>]+.*\.(png|jpg|jpeg|webp|heic|heif|gif)(\?.*)?)|( cdn\.discordapp\.com\/attachments\/)/i.test(content);
        if (!content && !hasAttachment && !hasLikelyImageLink) return;

        const userId    = message.author.id;
        const userName  = message.author.username;
        const guildId   = message.guild?.id;
        const channelId = message.channel.id;
        const botId     = client.user.id;
        const channel   = message.channel;
        const messageId = message.id;
        const isMentioned = message.mentions.has(client.user);

        const mentionedUsers = message.mentions.users;
        const mentionedRoles = message.mentions.roles;
        const hasOtherMention =
            mentionedUsers.some(u => u.id !== botId) ||
            mentionedRoles.size > 0;

        const hasReference = !!message.reference?.messageId;

        if (hasOtherMention && !hasReference) return;

        // ── @ 提及（頻道停用不影響此區塊）──
        if (isMentioned) {
            const rawQuestion = content.replace(/<@!?\d+>/g, '').trim();

            if (!rawQuestion && !hasAttachment && !hasLikelyImageLink) {
                if (!process.env.GEMINI_API_KEY) return;
                try {
                    const mode = getUserMode(userId, '');
                    const greetPrompt = '使用者只 @ 了你，沒有說任何話。用 10 字以內回應。';
                    const answer = await withTyping(message.channel, () =>
                        getGeminiResponse(userId, greetPrompt, [], channel, messageId, botId, null, mode)
                    );
                    const sentMsg = await message.channel.send(answer);
                    recordBotMessageContext(sentMsg.id, mode, userId, userName);
                    await speakWithTTS(message, answer, guildId);
                } catch (error) {
                    console.error('Greet reply error:', error.message);
                }
                return;
            }

            if (!process.env.GEMINI_API_KEY) {
                console.error('❌ 未設定 API Key');
                return;
            }

            try {
                const mode = getUserMode(userId, rawQuestion || '圖片');

                const { cleanedText: question, emojiParts } = await processCustomEmojis(rawQuestion);

                const embedParts = await processEmbeds(message.embeds);
                const urlImagePartsRaw = await processImageUrls(question);

                const urlImageParts = [];
                for (const part of urlImagePartsRaw) {
                    if (part.type === 'missing_signature') {
                        if (embedParts.length > 0) {
                            continue;
                        } else {
                            urlImageParts.push({
                                type: 'text',
                                text: '[系統提示：使用者傳送的 Discord 圖片網址缺少了安全簽名參數(?ex=...&is=...)，導致權限不足無法讀取。請直接吐槽使用者複製連結時把後面的參數弄丟了，叫他重新上傳圖片或給完整的連結。]'
                            });
                        }
                    } else {
                        urlImageParts.push(part);
                    }
                }

                const attachmentParts = await processAttachments(message.attachments);
                const imageParts = [...emojiParts, ...urlImageParts, ...embedParts, ...attachmentParts];

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
                // 發生錯誤時不回覆使用者，僅在後台記錄
                console.error('Mention reply error:', error.message);
            }

        // ── 隨機回覆 ──
        } else {
            if (!process.env.GEMINI_API_KEY) return;

            if (hasReference) {
                let isReplyingToOther = false;
                
                if (message.mentions.repliedUser) {
                    isReplyingToOther = message.mentions.repliedUser.id !== botId;
                } else {
                    const refMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
                    if (refMsg && refMsg.author.id !== botId) {
                        isReplyingToOther = true;
                    }
                }

                if (isReplyingToOther) {
                    return; 
                }
            }

            if (isChannelDisabled(channelId)) return;

            const rawCleaned = content
                .replace(/<@!?\d+>/g, '')
                .replace(/<@&\d+>/g, '')
                .replace(/<#\d+>/g, '')
                .trim();

            if (hasMissingSignature(rawCleaned)) {
                console.log(`[Random Reply] 偵測到缺少簽名的 Discord 網址，已過濾隨機回覆。`);
                return;
            }

            if (!rawCleaned && !hasAttachment) return;

            if (/(https?:\/\/[^\s)\]>]+)|(www\.[^\s)\]>]+)/gi.test(rawCleaned)) {
                if (!hasLikelyImageLink) return;
            }

            if (/^!(gugu|m|stt)/.test(rawCleaned)) return;

            const chance = getReplyChance(guildId);
            if (Math.random() < chance) {
                try {
                    const { cleanedText: cleanedContent, emojiParts } = await processCustomEmojis(rawCleaned);
                    const urlImageParts = await processImageUrls(cleanedContent);
                    const mode = getUserMode(userId, cleanedContent);
                    const attachmentParts = await processAttachments(message.attachments);
                    const imageParts = [...emojiParts, ...urlImageParts, ...attachmentParts];

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
