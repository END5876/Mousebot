// handlers/ai/aiCommands.js（MouseBot 與 mousebot-lite 共用，兩邊內容相同）
// /ai ask、clear、tts、chance、gugu 的處理。

const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const persona = require('./persona');
const { buildPayloads } = require('./memeStore');
const { getUserMode, getGeminiResponse, isEmptyResponseError, EMPTY_RESPONSE_MESSAGE } = require('./aiCore');
const {
  clearUserMemory, clearUserInChannel, clearChannelMemory, recordBotMessageContext, processAttachments,
  processCustomEmojis, processImageUrls, splitMessage,
} = require('./aiUtils');
const { setReplyChance, resetReplyChance, toggleChannel } = require('./aiChance');
const { isOwner } = require('../../utils/config');
const features = require('../../utils/features');
const { isQuotaError, quotaMessage } = require('./aiQuota');
const logger = require('../../utils/logger');
const { MISSING_SIGNATURE_HINT, labelOf, sendWithMemeFallback } = require('./aiReply');

const modeSelector = () => require('./modeSelector');
// AI 回覆朗讀（handlers/ai/aiTTS）；TTS 模組停用時是 null
const aiTts = () => features.get('aiTts');
// AI 工具的 context；aiTools 停用時是 null（不帶工具）
const toolContextFrom = (...a) => features.get('aiTools')?.contextFrom(...a) ?? null;
// 範圍鎖定：persona 在模組載入時就算好了，之後不會變
const getLock = () => persona.getLock();

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
    const rawQuestion = interaction.options.getString('question');
    // 範圍只在這裡解析一次，人格、歷史與訊息紀錄都用同一份
    const scope      = persona.resolveScope(interaction.channel, guildId);
    const mode       = getUserMode(userId, scope);
    // askText 只有群組歷史（單一人格）會用到：群組歷史會在這則回覆前面補上問題；多人格不把問題原文寫進磁碟
    const logExtra   = { kind: scope.kind, scopeKey: scope.scopeKey, askText: scope.kind === 'single' ? rawQuestion : null };

    await interaction.deferReply();

    try {
        // emoji → 網址圖片（需要清理後的文字）與附件下載彼此獨立，並行處理
        const [{ cleanedText: question, emojiParts, urlImagePartsRaw }, attachmentParts] = await Promise.all([
            processCustomEmojis(rawQuestion).then(async ({ cleanedText, emojiParts }) => ({
                cleanedText,
                emojiParts,
                // 傳入 client，讓 processImageUrls 內部可嘗試修復缺簽名網址
                urlImagePartsRaw: await processImageUrls(cleanedText, interaction.client, { guildId, userId }),
            })),
            attachment ? processAttachments(new Map([[attachment.id, attachment]])) : [],
        ]);

        const urlImageParts = urlImagePartsRaw.map(part =>
            part.type === 'missing_signature' ? { type: 'text', text: MISSING_SIGNATURE_HINT } : part
        );

        const toolCtx = toolContextFrom('text', {
            guild: interaction.guild, member: interaction.member, channel: interaction.channel, userId,
        });
        const { text: answer, chunks, files, skipTTS } = await getGeminiResponse({
            userId, prompt: question, imageParts: [...emojiParts, ...urlImageParts, ...attachmentParts],
            channel: interaction.channel, messageId: interaction.id, botId,
            mode, scope, userName: labelOf(interaction.member, interaction.user), toolCtx,
        });

        // 表情包附件跟在最後一塊文字上；只有圖時 payloads 只有一個 { files }
        const [first, ...rest] = buildPayloads(chunks, files);
        const replyMsg = await sendWithMemeFallback(p => interaction.editReply(p), first);
        if (!replyMsg) {
            await interaction.deleteReply().catch(() => {});
            return;
        }
        recordBotMessageContext(replyMsg.id, mode, userId, userName, logExtra);

        for (const payload of rest) {
            const followUpMsg = await sendWithMemeFallback(p => interaction.followUp({ ...p, fetchReply: true }), payload);
            if (followUpMsg) recordBotMessageContext(followUpMsg.id, mode, userId, userName, logExtra);
        }

        if (!skipTTS) await aiTts()?.speakWithTTS(interaction, answer, guildId);
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
    const channelId = interaction.channelId;
    const scope = persona.resolveScope(interaction.channel, interaction.guildId);
    const mode = getUserMode(userId, scope);
    const baseMessage = persona.getClearMessage(mode);

    if (getLock()) {
        // 群組歷史是依頻道抓的，所以清除也以這個頻道（討論串就是討論串本身）為單位
        const all = interaction.options.getBoolean('all') ?? false;
        if (all) {
            if (!isAdmin(interaction) && !isOwner(userId)) {
                return interaction.reply({ content: '❌ 清除整個頻道的對話記憶需要管理員權限。', flags: MessageFlags.Ephemeral });
            }
            clearChannelMemory(channelId);
            return interaction.reply({ content: `${baseMessage}\n> 已清除**這個頻道所有人**的對話記憶。` });
        }
        // 一般成員只讓自己的發言退出這個頻道的群組歷史；措辭不能像是整個頻道都清掉了
        clearUserInChannel(channelId, userId);
        return interaction.reply({ content: `${baseMessage}\n> 只清除了**你自己**在這個頻道的對話記憶，其他人的不受影響。` });
    }

    const wantScope = interaction.options.getBoolean('scope') ?? false;

    if (scope.kind !== 'single') {
        // 多人格：清這個使用者的對話記憶（跨頻道，持久化）
        clearUserMemory(userId);
        const note = wantScope ? '\n> ℹ️ 這裡是多人格模式，`scope` 選項只在單一人格頻道有效，已照常清除你自己的記憶。' : '';
        return interaction.reply({ content: baseMessage + note });
    }

    // 單一人格是群聊：群組歷史是依頻道抓的，所以清除也以這個頻道（討論串就是討論串本身）為單位
    if (wantScope) {
        if (!isAdmin(interaction) && !isOwner(userId)) {
            return interaction.reply({ content: '❌ 清除整個頻道的對話記憶需要管理員權限。', flags: MessageFlags.Ephemeral });
        }
        clearChannelMemory(channelId);
        return interaction.reply({ content: `${baseMessage}\n> 已清除**這個頻道所有人**的對話記憶（單一人格：${modeSelector().getModeName(scope.persona)}）。` });
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

    const tts = aiTts();
    if (!tts)
        return interaction.reply({ content: '❌ TTS 功能未啟用', flags: MessageFlags.Ephemeral });

    const current = tts.isAITTSEnabled(guildId);
    tts.setAITTSEnabled(guildId, !current);
    const status = !current ? '🔊 已開啟' : '🔇 已關閉';
    await interaction.reply({ content: `${status} AI 回覆朗讀功能` });
}

// ── 權限檢查小工具 ──────────────────────────────────────
// （子指令群組無法個別套用 setDefaultMemberPermissions，改為手動檢查）
function isAdmin(interaction) {
    return interaction.guild && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

// ── /ai chance set / toggle ─────────────────────────────
// 不鎖定時僅限管理員；鎖定時（精簡版）管理員或擁有者都可以
async function handleChanceSet(interaction) {
    const guildId = interaction.guildId;
    if (!guildId) {
        return interaction.reply({
            content: '❌ 此指令只能在伺服器中使用',
            flags: MessageFlags.Ephemeral,
        });
    }

    if (!isAdmin(interaction) && !(getLock() && isOwner(interaction.user.id))) {
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

// ── /ai gugu（gugu 模組停用時沒有這個子指令） ─────────────
async function handleGugu(interaction) {
    const gugu = features.get('gugu');
    if (!gugu) return;
    const topic = interaction.options.getString('topic');

    await interaction.reply({ content: '⏳ 我操了老鐵...' });

    try {
        const article = await gugu.generateGuguArticle(topic, interaction.user.id, interaction.guildId ?? null);
        // 主題可能誘導模型寫超長文，超過 2000 字要切開送，否則整篇作廢
        const [first, ...rest] = splitMessage(article);
        await interaction.editReply({ content: first });
        for (const chunk of rest) await interaction.followUp({ content: chunk });
    } catch (error) {
        await interaction.editReply({ content: gugu.getGuguErrorMessage(error) });
    }
}

module.exports = {
  isAdmin,
  handleAsk,
  handleClear,
  handleTTS,
  handleChanceSet,
  handleGugu,
};
