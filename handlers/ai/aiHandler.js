const {
    SlashCommandBuilder, MessageFlags, PermissionFlagsBits,
    ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
} = require('discord.js');
const {
    selectMode,
    getModeName,
    setUserMode,
    getAvailableModes,
} = require('./modeSelector');
const promptStore = require('./promptStore');

const {
    getUserMode,
    getGeminiResponse,
    getGeminiResponseVoice,
    getShortResponse,
    isEmptyResponseError,
    EMPTY_RESPONSE_MESSAGE,
} = require('./aiCore');
const { contextFrom: toolContextFrom } = require('./tools');

const {
    clearUserMemory, clearUserInChannel, clearChannelMemory,
    isAITTSEnabled, setAITTSEnabled,
    recordBotMessageContext,
    processAttachments,
    processCustomEmojis,
    processImageUrls,
    processEmbeds,
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

const {
    getScope,
    getScopeForChannel,
    setGuildScope,
    setChannelScope,
    getGuildEntry,
    getChannelEntry,
    isPersonaAllowedInSingle,
} = require('./aiScope');

const { generateGuguArticle, getGuguErrorMessage } = require('./gugugagaGenerator');
const bootSummary = require('../../utils/bootSummary');
const { isOwner } = require('../../utils/config');
const { hasCustomResponse } = require('../responseHandler');
const { isQuotaError, quotaMessage, describeLimits } = require('./aiQuota');
const { MODEL_NAME } = require('./geminiClient');
const { ENABLED_GUILD_IDS: SEARCH_GUILD_IDS } = require('./searchGrounding');
const logger = require('../../utils/logger');

// 每則訊息都會跑一次的正規表示式：原本 `[^\s)\]>]+.*\.` 的兩段貪婪量詞在長訊息上會
// 造成 O(n²) 回溯；改成單段非空白匹配，語意相同（網址中任一處出現圖片副檔名）。
const LIKELY_IMAGE_LINK_RE = /https?:\/\/\S+\.(?:png|jpe?g|webp|heic|heif|gif)(?:\?\S*)?|cdn\.discordapp\.com\/attachments\//i;


// 被 AI 額度擋下時回覆一則提示，數秒後自動刪除，避免連續觸發時洗版
const QUOTA_NOTICE_TTL_MS = 10 * 1000;
async function replyQuotaNotice(message, error) {
    const sent = await message.reply({ content: quotaMessage(error), allowedMentions: { repliedUser: false } }).catch(() => null);
    if (sent) setTimeout(() => sent.delete().catch(() => {}), QUOTA_NOTICE_TTL_MS).unref?.();
}

// 模型沒有產生文字時至少回一句，不要讓使用者 @ 了卻毫無反應
async function replyEmptyNotice(message) {
    await message.reply({ content: EMPTY_RESPONSE_MESSAGE, allowedMentions: { repliedUser: false } }).catch(() => {});
}

// ════════════════════════════════════════════════════════
//  /ai 單一指令，底下掛 ask / clear / tts / mode / prompt(group) / chance(group) / scope(group) / gugu
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
                .addBooleanOption(opt =>
                    opt.setName('scope')
                        .setDescription('單一人格頻道：清除整個頻道的對話記憶（僅限管理員）')
                        .setRequired(false)
                )
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

        // ── /ai prompt edit（子指令群組，僅限擁有者） ──
        .addSubcommandGroup(group =>
            group.setName('prompt')
                .setDescription('AI 模式設定')
                .addSubcommand(sub =>
                    sub.setName('edit')
                        .setDescription('編輯 AI 模式')
                        .addStringOption(opt =>
                            opt.setName('mode')
                                .setDescription('模式名稱')
                                .setRequired(true)
                        )
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

        // ── /ai scope show / set / reset（子指令群組；show 所有人可用，其餘僅限管理員） ──
        .addSubcommandGroup(group =>
            group.setName('scope')
                .setDescription('AI 範圍：多人格（每人各自的人格）或單一人格（大家共用同一個人格）')
                .addSubcommand(sub =>
                    sub.setName('show')
                        .setDescription('查看這裡目前的 AI 範圍設定')
                )
                .addSubcommand(sub =>
                    sub.setName('set')
                        .setDescription('設定本伺服器（或本頻道）的 AI 範圍')
                        .addStringOption(opt =>
                            opt.setName('kind')
                                .setDescription('多人格或單一人格')
                                .setRequired(true)
                                .addChoices(
                                    { name: '多人格（每人各自的人格）', value: 'multi' },
                                    { name: '單一人格（大家共用同一個人格）', value: 'single' },
                                )
                        )
                        .addStringOption(opt =>
                            opt.setName('persona')
                                .setDescription('單一人格時使用的人格代號（kind 為 single 時必填）')
                                .setRequired(false)
                        )
                        .addBooleanOption(opt =>
                            opt.setName('channel')
                                .setDescription('只套用到目前這個頻道（預設 false＝整個伺服器）')
                                .setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('reset')
                        .setDescription('移除本伺服器（或本頻道）的 AI 範圍設定，回到上一層的設定')
                        .addBooleanOption(opt =>
                            opt.setName('channel')
                                .setDescription('只重置目前這個頻道的覆寫（預設 false＝整個伺服器）')
                                .setRequired(false)
                        )
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
        if (group === 'prompt') {
            return handlePromptEdit(interaction);
        }
        if (group === 'scope') {
            if (sub === 'show')  return handleScopeShow(interaction);
            if (sub === 'set')   return handleScopeSet(interaction);
            if (sub === 'reset') return handleScopeReset(interaction);
            return;
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
        logger.error('AI', '未設定 GEMINI_API_KEY');
        return interaction.reply({ content: '❌ AI 功能未啟用。', flags: MessageFlags.Ephemeral });
    }

    const userId     = interaction.user.id;
    const userName   = interaction.user.username;
    const guildId    = interaction.guildId;
    const botId      = interaction.client.user.id;
    const attachment = interaction.options.getAttachment('image');
    // 範圍只在這裡解析一次，人格、歷史與訊息紀錄都用同一份
    const scope      = getScopeForChannel(interaction.channel, guildId);
    const mode       = getUserMode(userId, scope);
    // askText 只有群組歷史（單一人格）會用到；多人格不把問題原文寫進磁碟
    const logExtra   = { kind: scope.kind, scopeKey: scope.scopeKey, askText: scope.kind === 'single' ? interaction.options.getString('question') : null };
    const labelName  = `${interaction.member?.displayName ?? interaction.user.globalName ?? userName} (@${userName})`;

    await interaction.deferReply();

    try {
        const rawQuestion = interaction.options.getString('question');

        // emoji → 網址圖片（需要清理後的文字）與附件下載彼此獨立，並行處理
        const [{ cleanedText: question, emojiParts, urlImagePartsRaw }, attachmentParts] = await Promise.all([
            processCustomEmojis(rawQuestion).then(async ({ cleanedText, emojiParts }) => ({
                cleanedText,
                emojiParts,
                // ✅ 補上 interaction.client，讓 processImageUrls 內部可嘗試修復缺簽名網址
                urlImagePartsRaw: await processImageUrls(cleanedText, interaction.client, { guildId: interaction.guildId, userId: interaction.user.id }),
            })),
            attachment ? processAttachments(new Map([[attachment.id, attachment]])) : [],
        ]);

        const urlImageParts = urlImagePartsRaw.map(part => {
            if (part.type === 'missing_signature') {
                return {
                    type: 'text',
                    text: '[系統提示：使用者傳送的 Discord 圖片網址缺少了安全簽名參數(?ex=...&is=...)，導致權限不足無法讀取。請直接吐槽使用者複製連結時把後面的參數弄丟了，叫他重新上傳圖片或給完整的連結。]'
                };
            }
            return part;
        });

        const imageParts = [...emojiParts, ...urlImageParts, ...attachmentParts];

        const toolCtx = toolContextFrom('text', {
            guild: interaction.guild, member: interaction.member, channel: interaction.channel, userId,
        });
        const { text: answer, chunks, skipTTS } = await getGeminiResponse(userId, question, imageParts, interaction.channel, interaction.id, botId, null, mode, toolCtx, { scope, userName: labelName });

        const replyMsg = await interaction.editReply({ content: chunks[0] });
        recordBotMessageContext(replyMsg.id, mode, userId, userName, logExtra);

        for (let i = 1; i < chunks.length; i++) {
            const followUpMsg = await interaction.followUp({ content: chunks[i], fetchReply: true });
            recordBotMessageContext(followUpMsg.id, mode, userId, userName, logExtra);
        }

        if (!skipTTS) await speakWithTTS(interaction, answer, guildId);
    } catch (error) {
        if (isQuotaError(error)) {
            await interaction.editReply({ content: quotaMessage(error) }).catch(() => {});
            return;
        }
        if (isEmptyResponseError(error)) {
            await interaction.editReply({ content: EMPTY_RESPONSE_MESSAGE }).catch(() => {});
            return;
        }
        logger.error('AI', `/ai ask 錯誤：${error.message}`);
        await interaction.deleteReply().catch(() => {});
    }
}

// ── /ai clear ────────────────────────────────────────────
async function handleClear(interaction) {
    const userId = interaction.user.id;
    const scope = getScopeForChannel(interaction.channel, interaction.guildId);
    const mode = getUserMode(userId, scope);
    const wantScope = interaction.options.getBoolean('scope') ?? false;
    const baseMessage = promptStore.getMode(mode)?.clearMemoryMessage ?? '🧠 已清除你的對話記憶。';

    if (scope.kind !== 'single') {
        // 多人格：清這個使用者的對話記憶（跨頻道，持久化）
        clearUserMemory(userId);
        const note = wantScope ? '\n> ℹ️ 這裡是多人格模式，`scope` 選項只在單一人格頻道有效，已照常清除你自己的記憶。' : '';
        return interaction.reply({ content: baseMessage + note });
    }

    // 單一人格是群聊：群組歷史是依頻道抓的，所以清除也以這個頻道（討論串就是討論串本身）為單位
    const channelId = interaction.channelId;
    if (wantScope) {
        if (!isAdmin(interaction) && !isOwner(userId)) {
            return interaction.reply({ content: '❌ 清除整個頻道的對話記憶需要管理員權限。', flags: MessageFlags.Ephemeral });
        }
        clearChannelMemory(channelId);
        return interaction.reply({ content: `${baseMessage}\n> 已清除**這個頻道所有人**的對話記憶（單一人格：${getModeName(scope.persona)}）。` });
    }
    // 一般成員只讓自己的發言退出這個頻道的群組歷史；措辭不能像是整個頻道都清掉了
    clearUserInChannel(channelId, userId);
    await interaction.reply({ content: `${baseMessage}\n> 這裡是單一人格模式，只清除了**你自己**在這個頻道的對話記憶，其他人的不受影響。` });
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

    if (!isOwner(interaction.user.id)) {
        return interaction.reply({
            content: '❌ 你沒有權限使用此指令。',
            flags: MessageFlags.Ephemeral,
        });
    }

    const targetUser = interaction.options.getUser('target') ?? interaction.user;
    const selected   = interaction.options.getString('mode')?.trim().toLowerCase() ?? null;
    const targetId   = targetUser.id;

    // 單一人格的地方照樣寫入個人設定，但要提醒在這裡不會生效
    const scope = getScopeForChannel(interaction.channel, interaction.guildId);
    const singleNote = scope.kind === 'single'
        ? `\n> ℹ️ 此處為單一人格模式（${getModeName(scope.persona)}），個人設定只在多人格的地方生效。`
        : '';

    if (!selected) {
        setUserMode(targetId, null);
        // 顯示的是多人格時的預設（selectMode 不看範圍）
        const defaultMode = selectMode(targetId);
        return interaction.reply({
            content: `🔄 已重置 **${targetUser.username}** 的模式為預設：**${getModeName(defaultMode)}**${singleNote}`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const matched = getAvailableModes().find(m => m.toLowerCase() === selected);
    if (!matched) {
        return interaction.reply({
            content: `❌ 無效的模式名稱：\`${selected}\``,
            flags: MessageFlags.Ephemeral,
        });
    }

    setUserMode(targetId, matched);
    return interaction.reply({
        content: `✅ 已將 **${targetUser.username}** 的 AI 模式設為：**${getModeName(matched)}**${singleNote}`,
        flags: MessageFlags.Ephemeral,
    });
}

// ── /ai prompt edit（僅限 OWNER_USER_ID） ────────────────
// 以 Modal 編輯 data/prompts/ 底下的檔案，存檔後立即生效（promptStore 會重新載入）。
// Discord TextInput 上限 4000 字，超過的 prompt 請直接改檔案。
const PROMPT_MODAL_MAX        = 4000;
const PROMPT_MODAL_TIMEOUT_MS = 15 * 60 * 1000;
// 與管理面板（admin/api/prompts.js）的長度上限一致
const MODE_NAME_MAX           = 100;
const CLEAR_MESSAGE_MAX       = 500;

// 預填值超過 max_length 時 Discord 會整個拒絕 Modal；過長就不預填（留空送出時 saveMode 會保留原值）
function setPrefill(input, value, max) {
    if (!value) return;
    if (value.length <= max) input.setValue(value);
    else input.setPlaceholder(`目前的值有 ${value.length} 字，超過 ${max} 字未帶入；留空即保持不變`);
}

async function handlePromptEdit(interaction) {
    if (!isOwner(interaction.user.id)) {
        return interaction.reply({
            content: '❌ 你沒有權限使用此指令。',
            flags: MessageFlags.Ephemeral,
        });
    }

    const target   = interaction.options.getString('mode').trim();
    const isShared = promptStore.SHARED_KEYS.includes(target);

    if (!isShared && !promptStore.MODE_KEY_RE.test(target)) {
        return interaction.reply({
            content: `❌ 模式代號只能使用英數、底線、連字號（1~32 字）：\`${target}\``,
            flags: MessageFlags.Ephemeral,
        });
    }

    const existing      = isShared ? null : promptStore.getMode(target);
    const currentPrompt = isShared ? promptStore.getShared(target) : (existing?.prompt ?? '');

    if (currentPrompt.length > PROMPT_MODAL_MAX) {
        return interaction.reply({
            content: `❌ \`${target}\` 的 prompt 有 ${currentPrompt.length} 字，超過 Discord 輸入框上限 ${PROMPT_MODAL_MAX} 字，請直接編輯 data/prompts/ 底下的檔案（存檔後自動生效）。`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const modalId = `aiprompt_edit:${interaction.id}`;
    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle(`編輯 prompt：${target}${existing || isShared ? '' : '（新模式）'}`.slice(0, 45));

    const promptInput = new TextInputBuilder()
        .setCustomId('prompt')
        .setLabel('System Prompt')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(PROMPT_MODAL_MAX)
        .setRequired(true);
    if (currentPrompt) promptInput.setValue(currentPrompt);
    modal.addComponents(new ActionRowBuilder().addComponents(promptInput));

    if (!isShared) {
        const nameInput = new TextInputBuilder()
            .setCustomId('name')
            .setLabel('顯示名稱（例如：戀人模式）')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(MODE_NAME_MAX)
            .setRequired(false);
        setPrefill(nameInput, existing?.name, MODE_NAME_MAX);

        const clearInput = new TextInputBuilder()
            .setCustomId('clearMemoryMessage')
            .setLabel('/ai clear 時的回覆訊息')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(CLEAR_MESSAGE_MAX)
            .setRequired(false);
        setPrefill(clearInput, existing?.clearMemoryMessage, CLEAR_MESSAGE_MAX);

        modal.addComponents(
            new ActionRowBuilder().addComponents(nameInput),
            new ActionRowBuilder().addComponents(clearInput),
        );
    }

    await interaction.showModal(modal);

    const submitted = await interaction.awaitModalSubmit({
        filter: i => i.customId === modalId && i.user.id === interaction.user.id,
        time: PROMPT_MODAL_TIMEOUT_MS,
    }).catch(() => null);
    if (!submitted) return; // 逾時或關閉視窗

    try {
        const prompt = submitted.fields.getTextInputValue('prompt');
        if (isShared) {
            promptStore.saveShared(target, prompt);
        } else {
            promptStore.saveMode(target, {
                prompt,
                name:               submitted.fields.getTextInputValue('name'),
                clearMemoryMessage: submitted.fields.getTextInputValue('clearMemoryMessage'),
            });
        }
        logger.info('PromptStore', `${submitted.user.username} 更新了 ${target}`);
        await submitted.reply({
            content: `✅ 已${existing || isShared ? '更新' : '新增'} \`${target}\` 的 prompt（${prompt.trim().length} 字），立即生效。`,
            flags: MessageFlags.Ephemeral,
        });
    } catch (err) {
        logger.error('PromptStore', `寫入失敗：${err.message}`);
        await submitted.reply({
            content: `❌ 儲存失敗：${err.message}`,
            flags: MessageFlags.Ephemeral,
        });
    }
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

// ── /ai scope show / set / reset ────────────────────────
const SCOPE_SOURCE_LABEL = {
    channel: '本頻道的覆寫',
    parent:  '父頻道的覆寫（討論串跟著父頻道）',
    guild:   '伺服器設定',
    default: '預設',
    dm:      '私訊（一律多人格）',
};

function describeScope(scope) {
    const kindText = scope.kind === 'single'
        ? `單一人格：**${getModeName(scope.persona)}**（\`${scope.persona}\`）`
        : '多人格（每個人用自己的人格）';
    return [
        `🎭 目前範圍：${kindText}`,
        `來源：${SCOPE_SOURCE_LABEL[scope.source] ?? scope.source}`,
        scope.scopeKey ? `範圍代號：\`${scope.scopeKey}\`` : null,
    ].filter(Boolean).join('\n');
}

// 共用的前置檢查：只能在伺服器、只限管理員（擁有者一律可用）
async function checkScopeAdmin(interaction) {
    if (!interaction.guildId) {
        await interaction.reply({ content: '❌ 此指令只能在伺服器中使用', flags: MessageFlags.Ephemeral });
        return false;
    }
    if (!isAdmin(interaction) && !isOwner(interaction.user.id)) {
        await interaction.reply({ content: '❌ 你沒有權限使用此指令。', flags: MessageFlags.Ephemeral });
        return false;
    }
    return true;
}

async function handleScopeShow(interaction) {
    const scope = getScopeForChannel(interaction.channel, interaction.guildId);
    const lines = [describeScope(scope)];
    if (interaction.guildId) {
        const g = getGuildEntry(interaction.guildId);
        const c = interaction.channelId ? getChannelEntry(interaction.channelId) : null;
        const fmt = e => (e?.kind === 'single' ? `單一人格 \`${e.persona}\`` : e?.kind === 'multi' ? '多人格' : '未設定');
        lines.push('', `伺服器設定：${fmt(g)}`, `本頻道覆寫：${fmt(c)}`);
    }
    return interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
}

async function handleScopeSet(interaction) {
    if (!await checkScopeAdmin(interaction)) return;

    const personaInput = interaction.options.getString('persona')?.trim().toLowerCase() || null;
    const kind         = interaction.options.getString('kind', true);
    const onChannel    = interaction.options.getBoolean('channel') ?? false;
    const byOwner      = isOwner(interaction.user.id);

    const cfg = { kind };
    if (kind === 'single') {
        if (!personaInput) {
            return interaction.reply({ content: '❌ 單一人格模式必須指定 persona（人格代號）。', flags: MessageFlags.Ephemeral });
        }
        const matched = getAvailableModes().find(m => m.toLowerCase() === personaInput);
        if (!matched) {
            return interaction.reply({ content: `❌ 找不到人格：\`${personaInput}\``, flags: MessageFlags.Ephemeral });
        }
        if (!isPersonaAllowedInSingle(matched, byOwner)) {
            return interaction.reply({
                content: `❌ 「${getModeName(matched)}」不開放設成群組共用的人格（只有擁有者能設定）。`,
                flags: MessageFlags.Ephemeral,
            });
        }
        cfg.persona = matched;
    }

    const guildId   = interaction.guildId;
    const channelId = interaction.channelId;
    // 公開通知要看「被改到的那一層」：頻道設定看本頻道實際生效的範圍，
    // 伺服器設定看伺服器層級（本頻道可能有自己的覆寫，不能拿來判斷）
    const targetScope = () => (onChannel ? getScopeForChannel(interaction.channel, guildId) : getScope(guildId, null));
    const before    = targetScope();
    const result    = onChannel
        ? setChannelScope(channelId, guildId, cfg, interaction.user.id)
        : setGuildScope(guildId, cfg, interaction.user.id);
    if (!result.ok) {
        return interaction.reply({ content: `❌ 設定失敗：${result.error}`, flags: MessageFlags.Ephemeral });
    }

    const after  = getScopeForChannel(interaction.channel, guildId);
    const target = onChannel ? `<#${channelId}>` : '本伺服器';
    const lines  = [`✅ 已更新${target}的 AI 範圍。`, '', describeScope(after)];
    if (!onChannel && (after.source === 'channel' || after.source === 'parent')) {
        lines.push('', '> ℹ️ 這個頻道有自己的覆寫，伺服器設定在這裡不會生效（可用 `/ai scope reset channel:true` 移除）。');
    }

    // 剛切換成單一人格（或換了共用的人格）時公開說明，讓大家知道共用的是哪個人格
    const changedScope      = targetScope();
    const becameSingle = changedScope.kind === 'single' && (
        before.kind !== 'single' || before.scopeKey !== changedScope.scopeKey || before.persona !== changedScope.persona
    );
    if (becameSingle) {
        if (!onChannel && after.scopeKey !== changedScope.scopeKey) {
            lines.push('', `伺服器的共用人格：**${getModeName(changedScope.persona)}**（\`${changedScope.persona}\`）`);
        }
        lines.push(
            '',
            onChannel
                ? '在這裡大家都會跟同一個人格對話，個人的 `/ai mode` 設定只在多人格的地方生效。'
                : '在這個伺服器（沒有自己覆寫的頻道）大家都會跟同一個人格對話，個人的 `/ai mode` 設定只在多人格的地方生效。',
        );
        return interaction.reply({ content: lines.join('\n') });
    }
    return interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
}

async function handleScopeReset(interaction) {
    if (!await checkScopeAdmin(interaction)) return;

    const onChannel = interaction.options.getBoolean('channel') ?? false;
    const guildId   = interaction.guildId;
    const channelId = interaction.channelId;
    const result = onChannel
        ? setChannelScope(channelId, guildId, null, interaction.user.id)
        : setGuildScope(guildId, null, interaction.user.id);
    if (!result.ok) {
        return interaction.reply({ content: `❌ 重置失敗：${result.error}`, flags: MessageFlags.Ephemeral });
    }
    const target = onChannel ? `<#${channelId}> 的覆寫` : '本伺服器的設定';
    const after  = getScopeForChannel(interaction.channel, guildId);
    return interaction.reply({
        content: `${result.changed ? '🔄 已移除' : 'ℹ️ 本來就沒有'}${target}。\n\n${describeScope(after)}`,
        flags: MessageFlags.Ephemeral,
    });
}

// ── /ai gugu ─────────────────────────────────────────────
async function handleGugu(interaction) {
    const topic = interaction.options.getString('topic');

    await interaction.reply({ content: '⏳ 我操了老鐵...' });

    try {
        const article = await generateGuguArticle(topic, interaction.user.id);
        // 主題可能誘導模型寫超長文，超過 2000 字要切開送，否則整篇作廢
        const [first, ...rest] = splitMessage(article);
        await interaction.editReply({ content: first });
        for (const chunk of rest) await interaction.followUp({ content: chunk });
    } catch (error) {
        await interaction.editReply({ content: getGuguErrorMessage(error) });
    }
}

// ════════════════════════════════════════════════════════
//  setupAICommands
// ════════════════════════════════════════════════════════
function setupAICommands(client) {
    client.commands.set(aiCommand.data.name, aiCommand);

    bootSummary.report(
        'AI 對話 (/ai)',
        process.env.GEMINI_API_KEY ? 'ok' : 'off',
        process.env.GEMINI_API_KEY
            ? `Gemini (${MODEL_NAME}) 已連線，${getAvailableModes().length} 種人格模式可用；額度：${describeLimits()}；` +
              `搜尋接地：${SEARCH_GUILD_IDS.size ? `${SEARCH_GUILD_IDS.size} 個伺服器` : '停用'}`
            : '未設定 GEMINI_API_KEY，AI 功能停用'
    );

    client.on('messageCreate', async message => {
        if (message.author.bot) return;

        const hasAttachment = message.attachments.size > 0;
        const content = message.content?.trim() || '';

        const hasLikelyImageLink = LIKELY_IMAGE_LINK_RE.test(content);
        if (!content && !hasAttachment && !hasLikelyImageLink) return;

        const userId    = message.author.id;
        const userName  = message.author.username;
        const guildId   = message.guild?.id;
        const channelId = message.channel.id;
        const botId     = client.user.id;
        const channel   = message.channel;
        const messageId = message.id;
        const mentionedUsers = message.mentions.users;
        const mentionedRoles = message.mentions.roles;
        // 🐛 預設 has() 會把 @everyone/@here 與「Bot 也有的身分組」都算成 @Bot，公告會觸發完整回覆；
        //    只認直接 @Bot（含回覆 Bot 的訊息）與 Bot 自己的整合身分組
        const isMentioned =
            message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true }) ||
            mentionedRoles.some(r => r.tags?.botId === botId);
        const hasOtherMention =
            mentionedUsers.some(u => u.id !== botId) ||
            mentionedRoles.size > 0;

        const hasReference = !!message.reference?.messageId;

        // 範圍只在這裡解析一次（純記憶體查詢），人格、歷史與訊息紀錄都用同一份，
        // 中途被切換也不會前後不一致
        const scope    = getScopeForChannel(channel, guildId);
        const logExtra = { kind: scope.kind, scopeKey: scope.scopeKey };

        if (hasOtherMention && !hasReference && !isMentioned) return;

        // ── @ 提及（頻道停用不影響此區塊）──
        if (isMentioned) {
            // 將提及轉換為名字，並濾掉機器人自己
            const rawQuestion = replaceMentions(message, botId);
            const isEmptyContent = !rawQuestion && !hasAttachment && !hasLikelyImageLink;

            // ════════════════════════════════════════════════════
            //  特殊情形拉出處理：使用者「回覆」了某則訊息，且只 @ 了機器人，
            //  沒有輸入任何文字、沒有附件、也沒有圖片連結。
            //  這種情況下使用者的真實意圖是「要機器人針對被引用的內容
            //  做出反應」，絕不能落入下方「純打招呼」分支——否則
            //  getGeminiResponse 的 message 參數會被傳 null，導致
            //  buildMessagePartsWithReference 完全不會執行，被引用的
            //  內容（文字或圖片）會整個消失，機器人只會回一句答非所問的
            //  空泛話術（例如對著「使用者只 @ 你沒說話」做反應）。
            // ════════════════════════════════════════════════════
            if (isEmptyContent && hasReference) {
                if (!process.env.GEMINI_API_KEY) return;
                try {
                    // 引用說明與「只 @ 沒打字」的提示由 buildMessagePartsWithReference 補上
                    const mode = getUserMode(userId, scope);
                    const { text: answer, chunks } = await withTyping(message.channel, () =>
                        getGeminiResponse(userId, '', [], channel, messageId, botId, message, mode, null, { scope })
                    );
                    for (const chunk of chunks) {
                        const sentMsg = await message.channel.send(chunk);
                        recordBotMessageContext(sentMsg.id, mode, userId, userName, logExtra);
                    }
                    await speakWithTTS(message, answer, guildId);
                } catch (error) {
                    if (isQuotaError(error)) await replyQuotaNotice(message, error);
                    else if (isEmptyResponseError(error)) await replyEmptyNotice(message);
                    else logger.error('AI', `引用 @ 回覆錯誤：${error.message}`);
                }
                return;
            }

            // 純打招呼：沒有引用、沒有文字、沒有附件、沒有圖片連結（原邏輯維持）
            if (isEmptyContent) {
                if (!process.env.GEMINI_API_KEY) return;
                try {
                    const mode = getUserMode(userId, scope);
                    const greetPrompt = '使用者只 @ 了你，沒有說任何話。';
                    const labelName = `${message.member?.displayName ?? message.author.globalName ?? userName} (@${userName})`;
                    const { text: answer, chunks } = await withTyping(message.channel, () =>
                        getGeminiResponse(userId, greetPrompt, [], channel, messageId, botId, null, mode, null, { scope, userName: labelName })
                    );
                    for (const chunk of chunks) {
                        const sentMsg = await message.channel.send(chunk);
                        recordBotMessageContext(sentMsg.id, mode, userId, userName, logExtra);
                    }
                    await speakWithTTS(message, answer, guildId);
                } catch (error) {
                    if (isQuotaError(error)) await replyQuotaNotice(message, error);
                    else if (isEmptyResponseError(error)) await replyEmptyNotice(message);
                    else logger.error('AI', `打招呼回覆錯誤：${error.message}`);
                }
                return;
            }

            if (!process.env.GEMINI_API_KEY) {
                logger.error('AI', '未設定 GEMINI_API_KEY');
                return;
            }

            try {
                const mode = getUserMode(userId, scope);

                // 「正在輸入中」涵蓋圖片下載/壓縮階段，使用者不用乾等
                const { text: answer, chunks, skipTTS } = await withTyping(message.channel, async () => {
                    // emoji → 網址圖片、embed、附件三者彼此獨立，並行處理
                    const [{ question, emojiParts, urlImagePartsRaw }, embedParts, attachmentParts] = await Promise.all([
                        processCustomEmojis(rawQuestion).then(async ({ cleanedText, emojiParts }) => ({
                            question: cleanedText,
                            emojiParts,
                            // ✅ 補上 client，讓 processImageUrls 內部可嘗試修復缺簽名網址
                            urlImagePartsRaw: await processImageUrls(cleanedText, client, { guildId: message.guildId, userId: message.author.id }),
                        })),
                        processEmbeds(message.embeds),
                        processAttachments(message.attachments),
                    ]);

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

                    const imageParts = [...emojiParts, ...urlImageParts, ...embedParts, ...attachmentParts];
                    const toolCtx = toolContextFrom('text', {
                        guild: message.guild, member: message.member, channel: message.channel, userId,
                    });
                    return getGeminiResponse(userId, question, imageParts, channel, messageId, botId, message, mode, toolCtx, { scope });
                });

                for (const chunk of chunks) {
                    const sentMsg = await message.channel.send(chunk);
                    recordBotMessageContext(sentMsg.id, mode, userId, userName, logExtra);
                }

                if (!skipTTS) await speakWithTTS(message, answer, guildId);
            } catch (error) {
                if (isQuotaError(error)) await replyQuotaNotice(message, error);
                else if (isEmptyResponseError(error)) await replyEmptyNotice(message);
                else logger.error('AI', `@ 回覆錯誤：${error.message}`);
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

            // 已觸發自訂匹配回應（/response）的訊息，不再隨機回覆
            if (hasCustomResponse(message.content)) return;

            // 將提及轉換為名字
            const rawCleaned = replaceMentions(message, botId);

            if (!rawCleaned && !hasAttachment) return;

            // 只要訊息含有任何連結（包含圖片連結），隨機回覆一律不回應
            if (/(https?:\/\/[^\s)\]>]+)|(www\.[^\s)\]>]+)/gi.test(rawCleaned)) return;

            if (/^!(gugu|m|stt)/.test(rawCleaned)) return;

            const chance = getReplyChance(guildId);
            if (Math.random() < chance) {
                try {
                    let mode;
                    const shortReply = await withTyping(message.channel, async () => {
                        const [{ cleanedText: cleanedContent, emojiParts }, attachmentParts] = await Promise.all([
                            processCustomEmojis(rawCleaned),
                            processAttachments(message.attachments),
                        ]);

                        mode = getUserMode(userId, scope);
                        const imageParts = [...emojiParts, ...attachmentParts];
                        return getShortResponse(userId, cleanedContent, imageParts, channel, messageId, botId, message, mode, { scope });
                    });

                    if (shortReply) {
                        for (const chunk of shortReply.chunks) {
                            const sentMsg = await message.channel.send(chunk);
                            recordBotMessageContext(sentMsg.id, mode, userId, userName, logExtra);
                        }
                        await speakWithTTS(message, shortReply.text, guildId);
                    }
                } catch (error) {
                    logger.error('AI', `隨機回覆錯誤：${error.message}`);
                }
            }
        }
    });
}

module.exports = { setupAICommands, getGeminiResponse, getGeminiResponseVoice };