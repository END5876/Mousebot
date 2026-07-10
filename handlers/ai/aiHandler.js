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
    replaceMentions, 
} = require('./aiUtils');

const {
    DEFAULT_CHANCE,
    getReplyChance,
    setReplyChance,
    resetReplyChance,
    isChannelDisabled,
    toggleChannel,
} = require('./aiChance');

const { generateGuguArticle, getGuguErrorMessage } = require('./gugugagaGenerator');

const SETMODE_ALLOWED_USER_ID = '598054316510806017';

// ════════════════════════════════════════════════════════
//  /ai 單一指令，底下掛 ask / clear / tts / mode / chance(group) / gugu
// ════════════════════════════════════════════════════════
const aiCommand = {
    data: new SlashCommandBuilder()
        .setName('ai')
        .setDescription('AI 對話相關功能')

        // ── /ai ask ──
        .addSubcommand(sub =>
            sub.setName('ask')
                .setDescription('詢問 AI 問題')
                .addStringOption(opt =>
                    opt.setName('question').setDescription('你想問的問題').setRequired(true)
                )
                .addAttachmentOption(opt =>
                    opt.setName('image').setDescription('附上圖片（選填）').setRequired(false)
                )
        )

        // ── /ai clear ──
        .addSubcommand(sub =>
            sub.setName('clear')
                .setDescription('清除你與 AI 的對話記憶')
        )

        // ── /ai tts ──
        .addSubcommand(sub =>
            sub.setName('tts')
                .setDescription('切換 AI 回覆是否自動朗讀（語音頻道）')
        )

        // ── /ai mode ──
        .addSubcommand(sub =>
            sub.setName('mode')
                .setDescription('設定指定使用者的 AI 人格模式')
                .addUserOption(opt =>
                    opt.setName('target')
                        .setDescription('要設定的使用者（不填則設定自己）')
                        .setRequired(false)
                )
                .addStringOption(opt =>
                    opt.setName('mode')
                        .setDescription('模式名稱（不填則重置為預設）')
                        .setRequired(false)
                )
        )

        // ── /ai chance set / toggle（子指令群組） ──
        .addSubcommandGroup(group =>
            group.setName('chance')
                .setDescription('AI 隨機回覆機率設定')
                .addSubcommand(sub =>
                    sub.setName('set')
                        .setDescription('設定本伺服器的 AI 隨機回覆機率')
                        .addNumberOption(opt =>
                            opt.setName('chance')
                                .setDescription(`機率 0~100（%），不填則重置為預設值 ${(DEFAULT_CHANCE * 100).toFixed(0)}%`)
                                .setMinValue(0)
                                .setMaxValue(100)
                                .setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('toggle')
                        .setDescription('切換本頻道的 AI 隨機回覆開關（不影響其他頻道）')
                )
        )

        // ── /ai gugu ──
        .addSubcommand(sub =>
            sub.setName('gugu')
                .setDescription('生成一篇咕咕嘎嘎體文章')
                .addStringOption(opt =>
                    opt.setName('topic')
                        .setDescription('文章主題（例如：上班、貓咪、宇宙）')
                        .setRequired(true)
                )
        )

        .setDefaultMemberPermissions(null), // 個別子指令權限在 execute() 內手動判斷

    async execute(interaction) {
        const sub   = interaction.options.getSubcommand();
        const group = interaction.options.getSubcommandGroup(false);

        if (group === 'chance') {
            return handleChanceSet(interaction);
        }

        switch (sub) {
            case 'ask':   return handleAsk(interaction);
            case 'clear': return handleClear(interaction);
            case 'tts':   return handleTTS(interaction);
            case 'mode':  return handleMode(interaction);
            case 'gugu':  return handleGugu(interaction);
        }
    }
};

// ── /ai ask ──────────────────────────────────────────────
async function handleAsk(interaction) {
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

        // ✅ 補上 interaction.client，讓 processImageUrls 內部可嘗試修復缺簽名網址
        const urlImagePartsRaw = await processImageUrls(question, interaction.client);
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
        console.error('Slash command /ai error:', error.message);
        await interaction.deleteReply().catch(() => {});
    }
}

// ── /ai clear ────────────────────────────────────────────
async function handleClear(interaction) {
    const userId = interaction.user.id;
    const mode = selectMode(userId, '');
    clearUserMemory(userId);
    await interaction.reply({ content: MODE_MAP[mode].getClearMemoryMessage() });
}

// ── /ai tts ──────────────────────────────────────────────
async function handleTTS(interaction) {
    const guildId = interaction.guildId;
    if (!guildId)
        return interaction.reply({ content: '❌ 此指令只能在伺服器中使用', flags: MessageFlags.Ephemeral });

    const current = isAITTSEnabled(guildId);
    setAITTSEnabled(guildId, !current);
    const status = !current ? '🔊 已開啟' : '🔇 已關閉';
    await interaction.reply({ content: `${status} AI 回覆朗讀功能` });
}

// ── /ai mode（僅限 SETMODE_ALLOWED_USER_ID） ────────────
async function handleMode(interaction) {
    if (!interaction.guildId) {
        return interaction.reply({
            content: '❌ 此指令只能在伺服器中使用',
            flags: MessageFlags.Ephemeral,
        });
    }

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

// ── 權限檢查小工具：/ai chance set / toggle 僅限管理員 ──
// （子指令群組無法個別套用 setDefaultMemberPermissions，改為手動檢查）
function isAdmin(interaction) {
    return interaction.guild && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

// ── /ai chance set / toggle ─────────────────────────────
async function handleChanceSet(interaction) {
    const guildId = interaction.guildId;
    if (!guildId) {
        return interaction.reply({
            content: '❌ 此指令只能在伺服器中使用',
            flags: MessageFlags.Ephemeral,
        });
    }

    if (!isAdmin(interaction)) {
        return interaction.reply({
            content: '❌ 你沒有權限使用此指令。',
            flags: MessageFlags.Ephemeral,
        });
    }

    const chanceSub = interaction.options.getSubcommand();

    if (chanceSub === 'toggle') {
        const channelId = interaction.channelId;
        const { disabled } = toggleChannel(channelId);
        const channelMention = `<#${channelId}>`;

        return interaction.reply({
            content: disabled
                ? `🔕 已關閉 ${channelMention} 的 AI 隨機回覆（@ 提及仍有效）`
                : `🔔 已開啟 ${channelMention} 的 AI 隨機回覆`,
            flags: MessageFlags.Ephemeral,
        });
    }

    // chanceSub === 'set'
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

// ── /ai gugu ─────────────────────────────────────────────
async function handleGugu(interaction) {
    const topic = interaction.options.getString('topic');

    await interaction.reply({ content: '⏳ 我操了老鐵...' });

    try {
        const article = await generateGuguArticle(topic);
        await interaction.editReply({ content: article });
    } catch (error) {
        console.error('生成咕咕嘎嘎文章時發生錯誤:', error);
        await interaction.editReply({ content: getGuguErrorMessage(error) });
    }
}

// ════════════════════════════════════════════════════════
//  setupAICommands
// ════════════════════════════════════════════════════════
function setupAICommands(client) {
    client.commands.set(aiCommand.data.name, aiCommand);

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

        if (hasOtherMention && !hasReference && !isMentioned) return;

        // ── @ 提及（頻道停用不影響此區塊）──
        if (isMentioned) {
            // 將提及轉換為名字，並濾掉機器人自己
            const rawQuestion = replaceMentions(message, botId);

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
                // ✅ 補上 client，讓 processImageUrls 內部可嘗試修復缺簽名網址
                const urlImagePartsRaw = await processImageUrls(question, client);

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

            //  將提及轉換為名字
            const rawCleaned = replaceMentions(message, botId);

            if (!rawCleaned && !hasAttachment) return;

            if (/(https?:\/\/[^\s)\]>]+)|(www\.[^\s)\]>]+)/gi.test(rawCleaned)) {
                if (!hasLikelyImageLink) return;
            }

            if (/^!(gugu|m|stt)/.test(rawCleaned)) return;

            const chance = getReplyChance(guildId);
            if (Math.random() < chance) {
                try {
                    const { cleanedText: cleanedContent, emojiParts } = await processCustomEmojis(rawCleaned);
                    // ✅ 補上 client，讓 processImageUrls 內部可嘗試修復缺簽名網址
                    const urlImageParts = await processImageUrls(cleanedContent, client);

                    // ⚠️ 修復失敗（兩層策略都無法取得圖片）時，保守放棄本次隨機回覆
                    // 原因：隨機回覆屬於「被動觸發」，讓 AI 主動吐槽使用者連結壞掉
                    //       在這個情境下會顯得突兀，故選擇安靜跳過，而不是像
                    //       /ai ask 或 @ 提及那樣讓 AI 主動提出吐槽文字。
                    if (urlImageParts.some(part => part.type === 'missing_signature')) {
                        console.log(`[Random Reply] 圖片修復失敗，已放棄本次隨機回覆。`);
                        return;
                    }

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
