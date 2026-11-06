// handlers/ai/aiHandler.js（MouseBot 與 mousebot-lite 共用，兩邊內容相同）
// /ai 指令、@ 提及回覆、隨機插話。能用哪些功能由兩件事決定：
//   - 範圍鎖定（persona.getLock()，AI_SCOPE_LOCK／profile.aiScopeLock）：
//       鎖定時只有單一人格（群聊），沒有 /ai mode、/ai prompt、/ai scope，/ai 只能在伺服器內使用，私訊不回覆
//   - 模組（utils/features.js）：/ai tts 要有 aiTts、/ai gugu 要有 gugu；AI 工具、自訂回應也是有才用
// 沒有設定 GEMINI_API_KEY 時 setupAICommands 不註冊任何東西。
//
// 注意：aiScope、modeSelector 只在不鎖定時才 lazy require；不能在最上層呼叫 features.get()（會循環 require）。

const {
    SlashCommandBuilder, MessageFlags, PermissionFlagsBits, InteractionContextType,
    ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
} = require('discord.js');
const promptStore = require('./promptStore');
const persona = require('./persona');
const { buildPayloads, listMemes, listLibraries, memeTagOfContent, publicBase } = require('./memeStore');

const {
    getUserMode,
    getGeminiResponse,
    getGeminiResponseVoice,
    getShortResponse,
    isEmptyResponseError,
    EMPTY_RESPONSE_MESSAGE,
} = require('./aiCore');

const {
    clearUserMemory, clearUserInChannel, clearChannelMemory,
    recordBotMessageContext,
    processAttachments,
    processCustomEmojis,
    processImageUrls,
    processEmbeds,
    withTyping, splitMessage,
    replaceMentions,
} = require('./aiUtils');

const {
    DEFAULT_CHANCE,
    getReplyChance,
    shouldRandomReply,
    setReplyChance,
    resetReplyChance,
    isChannelDisabled,
    toggleChannel,
} = require('./aiChance');

const bootSummary = require('../../utils/bootSummary');
const { isOwner } = require('../../utils/config');
const features = require('../../utils/features');
const profile = require('../../profile');
const { isAIEnabled, DEFAULT_MODE, DEFAULT_MODE_INVALID, USER_MODE_OVERRIDE_ERRORS } = require('./aiSettings');
const { isQuotaError, quotaMessage, describeLimits } = require('./aiQuota');
const { MODEL_NAME } = require('./geminiClient');
const { ENABLED_GUILD_IDS: SEARCH_GUILD_IDS } = require('./searchGrounding');
const logger = require('../../utils/logger');

// 只在不鎖定時用到（多人格／單一人格切換、/ai mode）；鎖定時不載入，也不讀寫 aiScope.json、userModes.json
const aiScope = () => require('./aiScope');
const modeSelector = () => require('./modeSelector');
// AI 回覆朗讀（handlers/ai/aiTTS）；TTS 模組停用時是 null
const aiTts = () => features.get('aiTts');
// AI 工具的 context；aiTools 停用時是 null（不帶工具）
const toolContextFrom = (...a) => features.get('aiTools')?.contextFrom(...a) ?? null;

// 範圍鎖定：setupAICommands 時讀一次（persona 在模組載入時就算好了）
let lock = null;

// 每則訊息都會跑一次的正規表示式：原本 `[^\s)\]>]+.*\.` 的兩段貪婪量詞在長訊息上會
// 造成 O(n²) 回溯；改成單段非空白匹配，語意相同（網址中任一處出現圖片副檔名）。
const LIKELY_IMAGE_LINK_RE = /https?:\/\/\S+\.(?:png|jpe?g|webp|heic|heif|gif)(?:\?\S*)?|cdn\.discordapp\.com\/attachments\//i;

const MISSING_SIGNATURE_HINT = '[系統提示：使用者傳送的 Discord 圖片網址缺少了安全簽名參數(?ex=...&is=...)，導致權限不足無法讀取。請告訴使用者連結後面的參數不見了，請他重新上傳圖片或貼完整的連結。]';

// 這些前綴開頭的訊息不觸發隨機回覆（profile.randomReplySkipPrefixes；空陣列＝不過濾）
const SKIP_PREFIX_RE = profile.randomReplySkipPrefixes.length
    ? new RegExp(`^!(${profile.randomReplySkipPrefixes.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`)
    : null;

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

// 「顯示名稱 (@username)」：與群組歷史的發言者標籤一致
function labelOf(member, user) {
    return `${member?.displayName ?? user.globalName ?? user.username} (@${user.username})`;
}

// ════════════════════════════════════════════════════════
//  /ai 單一指令，底下掛 ask / clear / tts / mode / prompt(group) / chance(group) / scope(group) / gugu
// ════════════════════════════════════════════════════════
/**
 * 建立 /ai 指令。子指令的加入順序固定（ask、clear、tts、mode、prompt、chance、scope、gugu），
 * 條件相同時指令 JSON 就和以前完全一樣（不一致的話開機會重新 PUT 全域指令）。
 * @param {object} opts
 * @param {object|null} opts.lock  persona.getLock()；鎖定時沒有 mode／prompt／scope，只能在伺服器內使用
 * @param {boolean} opts.tts       aiTts 模組啟用時才有 /ai tts
 * @param {boolean} opts.gugu      gugu 模組啟用時才有 /ai gugu
 */
function buildAiCommand({ lock: locked, tts, gugu }) {
    const builder = new SlashCommandBuilder()
        .setName('ai')
        .setDescription('AI 對話相關功能');

    // 鎖定時群聊歷史以伺服器頻道為單位（精簡版也沒有 DM 的 intent）：只在伺服器內提供
    if (locked) builder.setContexts(InteractionContextType.Guild);

    builder
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
        );

    // ── /ai clear ──
    if (locked) {
        builder.addSubcommand(sub =>
            sub.setName('clear')
                .setDescription('清除你在這個頻道與 AI 的對話記憶')
                .addBooleanOption(opt =>
                    opt.setName('all')
                        .setDescription('清除整個頻道所有人的對話記憶（僅限管理員）')
                        .setRequired(false)
                )
        );
    } else {
        builder.addSubcommand(sub =>
            sub.setName('clear')
                .setDescription('清除你與 AI 的對話記憶')
                .addBooleanOption(opt =>
                    opt.setName('scope')
                        .setDescription('單一人格頻道：清除整個頻道的對話記憶（僅限管理員）')
                        .setRequired(false)
                )
        );
    }

    if (tts) {
        builder
            // ── /ai tts ──
            .addSubcommand(sub =>
                sub.setName('tts')
                    .setDescription('切換 AI 回覆是否自動朗讀（語音頻道）')
            );
    }

    if (!locked) {
        builder
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
            );
    }

    builder
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
        );

    if (!locked) {
        builder
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
            );
    }

    if (gugu) {
        builder
            // ── /ai gugu ──
            .addSubcommand(sub =>
                sub.setName('gugu')
                    .setDescription('生成一篇咕咕嘎嘎體文章')
                    .addStringOption(opt =>
                        opt.setName('topic')
                            .setDescription('文章主題（例如：上班、貓咪、宇宙）')
                            .setRequired(true)
                    )
            );
    }

    builder.setDefaultMemberPermissions(null); // 個別子指令權限在 execute() 內手動判斷
    return builder;
}

const aiCommand = {
    // setupAICommands 依範圍鎖定與模組是否啟用建立
    data: null,

    async execute(interaction) {
        const sub   = interaction.options.getSubcommand();
        const group = interaction.options.getSubcommandGroup(false);

        if (group === 'chance') {
            return handleChanceSet(interaction);
        }
        // 鎖定時沒有註冊 prompt／scope／mode，萬一收到（舊的指令定義）也不處理
        if (group === 'prompt') {
            return lock ? undefined : handlePromptEdit(interaction);
        }
        if (group === 'scope') {
            if (lock) return;
            if (sub === 'show')  return handleScopeShow(interaction);
            if (sub === 'set')   return handleScopeSet(interaction);
            if (sub === 'reset') return handleScopeReset(interaction);
            return;
        }

        switch (sub) {
            case 'ask':   return handleAsk(interaction);
            case 'clear': return handleClear(interaction);
            case 'tts':   return handleTTS(interaction);
            case 'mode':  return lock ? undefined : handleMode(interaction);
            case 'gugu':  return handleGugu(interaction);
        }
    }
};

// ════════════════════════════════════════════════════════
//  送出回覆（含表情包）
// ════════════════════════════════════════════════════════
/**
 * 送出一則；帶表情包附件失敗（沒有「附加檔案」權限、檔案太大…）時改送純文字，不讓圖片拖垮整則回覆。
 * 只有圖（附件或表情包網址）、沒有文字的那則失敗就放棄（回傳 null）。
 */
async function sendWithMemeFallback(send, payload) {
    try {
        return await send(payload);
    } catch (err) {
        if (!payload.files && memeTagOfContent(payload.content) === undefined) throw err;
        logger.warn('Meme', `表情包送出失敗（${err.code ?? ''} ${err.message}），改送純文字`);
        if (!payload.files || !payload.content) return null;
        return send({ content: payload.content });
    }
}

/** 把回覆（文字塊＋表情包）送到訊息所在的頻道，每則都記進 AI 回覆紀錄 */
async function sendChunks(message, { chunks, files }, { mode, scope }) {
    const logExtra = { kind: scope.kind, scopeKey: scope.scopeKey };
    for (const payload of buildPayloads(chunks, files)) {
        const sentMsg = await sendWithMemeFallback(p => message.channel.send(p), payload);
        if (sentMsg) recordBotMessageContext(sentMsg.id, mode, message.author.id, message.author.username, logExtra);
    }
}

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

    if (lock) {
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

// ── /ai mode（僅限 OWNER_USER_ID；鎖定時沒有這個子指令） ──
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

    const { selectMode, getModeName, setUserMode, getAvailableModes } = modeSelector();
    const targetUser = interaction.options.getUser('target') ?? interaction.user;
    const selected   = interaction.options.getString('mode')?.trim().toLowerCase() ?? null;
    const targetId   = targetUser.id;

    // 單一人格的地方照樣寫入個人設定，但要提醒在這裡不會生效
    const scope = aiScope().getScopeForChannel(interaction.channel, interaction.guildId);
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

    if (!isAdmin(interaction) && !(lock && isOwner(interaction.user.id))) {
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

// ── /ai scope show / set / reset（鎖定時沒有這組子指令） ──
const SCOPE_SOURCE_LABEL = {
    channel: '本頻道的覆寫',
    parent:  '父頻道的覆寫（討論串跟著父頻道）',
    guild:   '伺服器設定',
    default: '預設',
    dm:      '私訊（一律多人格）',
};

function describeScope(scope) {
    const kindText = scope.kind === 'single'
        ? `單一人格：**${modeSelector().getModeName(scope.persona)}**（\`${scope.persona}\`）`
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
    const { getScopeForChannel, getGuildEntry, getChannelEntry } = aiScope();
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

    const { getScope, getScopeForChannel, setGuildScope, setChannelScope, isPersonaAllowedInSingle } = aiScope();
    const { getModeName, getAvailableModes } = modeSelector();
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

    const { getScopeForChannel, setGuildScope, setChannelScope } = aiScope();
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

// ── /ai gugu（gugu 模組停用時沒有這個子指令） ─────────────
async function handleGugu(interaction) {
    const gugu = features.get('gugu');
    if (!gugu) return;
    const topic = interaction.options.getString('topic');

    await interaction.reply({ content: '⏳ 我操了老鐵...' });

    try {
        const article = await gugu.generateGuguArticle(topic, interaction.user.id);
        // 主題可能誘導模型寫超長文，超過 2000 字要切開送，否則整篇作廢
        const [first, ...rest] = splitMessage(article);
        await interaction.editReply({ content: first });
        for (const chunk of rest) await interaction.followUp({ content: chunk });
    } catch (error) {
        await interaction.editReply({ content: gugu.getGuguErrorMessage(error) });
    }
}

// ════════════════════════════════════════════════════════
//  訊息處理：@ 提及、隨機插話
// ════════════════════════════════════════════════════════
async function handleMention(message, client, { rawQuestion, hasAttachment, hasLikelyImageLink, scope }) {
    const userId = message.author.id;
    const botId  = client.user.id;
    const mode   = getUserMode(userId, scope);
    const base   = { userId, channel: message.channel, messageId: message.id, botId, message, mode, scope };
    const isEmptyContent = !rawQuestion && !hasAttachment && !hasLikelyImageLink;

    try {
        let result;
        if (isEmptyContent) {
            // 只 @ 沒打字：一律把 message 傳進去。有引用時由 buildMessagePartsWithReference 補上引用內容與提示
            // （使用者真正的意圖是要 Bot 對被引用的內容做反應，不能當成打招呼，否則引用的文字或圖片會整個消失）；
            // 沒引用就是純打招呼，buildMessagePartsWithReference 會標成「只 @ 了你，沒有說任何話」
            result = await withTyping(message.channel, () => getGeminiResponse({ ...base, prompt: '' }));
        } else {
            // 「正在輸入中」涵蓋圖片下載/壓縮階段，使用者不用乾等
            result = await withTyping(message.channel, async () => {
                // emoji → 網址圖片、embed、附件三者彼此獨立，並行處理
                const [{ question, emojiParts, urlImagePartsRaw }, embedParts, attachmentParts] = await Promise.all([
                    processCustomEmojis(rawQuestion).then(async ({ cleanedText, emojiParts }) => ({
                        question: cleanedText,
                        emojiParts,
                        // 傳入 client，讓 processImageUrls 內部可嘗試修復缺簽名網址
                        urlImagePartsRaw: await processImageUrls(cleanedText, client, { guildId: message.guildId, userId }),
                    })),
                    processEmbeds(message.embeds),
                    processAttachments(message.attachments),
                ]);

                // 缺簽名的網址：embed 預覽讀得到就不用提示
                const urlImageParts = urlImagePartsRaw.flatMap(part => {
                    if (part.type !== 'missing_signature') return [part];
                    return embedParts.length > 0 ? [] : [{ type: 'text', text: MISSING_SIGNATURE_HINT }];
                });

                const toolCtx = toolContextFrom('text', {
                    guild: message.guild, member: message.member, channel: message.channel, userId,
                });
                return getGeminiResponse({
                    ...base, prompt: question,
                    imageParts: [...emojiParts, ...urlImageParts, ...embedParts, ...attachmentParts],
                    toolCtx,
                });
            });
        }
        await sendChunks(message, result, { mode, scope });
        if (!result.skipTTS) await aiTts()?.speakWithTTS(message, result.text, message.guild?.id);
    } catch (error) {
        if (isQuotaError(error)) await replyQuotaNotice(message, error);
        else if (isEmptyResponseError(error)) await replyEmptyNotice(message);
        else logger.error('AI', `@ 回覆錯誤：${error.message}`);
    }
}

async function handleRandomReply(message, client, { hasAttachment, hasReference, scope }) {
    const botId = client.user.id;

    // 回覆別人的訊息不插話
    if (hasReference) {
        let isReplyingToOther = false;
        if (message.mentions.repliedUser) {
            isReplyingToOther = message.mentions.repliedUser.id !== botId;
        } else {
            const refMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
            if (refMsg && refMsg.author.id !== botId) isReplyingToOther = true;
        }
        if (isReplyingToOther) return;
    }

    if (isChannelDisabled(message.channel.id)) return;

    // 已觸發自訂匹配回應（/response）的訊息，不再隨機回覆（/response 模組停用或不存在時沒有自訂回應）
    if (features.get('responses')?.hasCustomResponse(message.content) ?? false) return;

    // 將提及轉換為名字
    const rawCleaned = replaceMentions(message, botId);
    if (!rawCleaned && !hasAttachment) return;

    // 只要訊息含有任何連結（包含圖片連結），隨機回覆一律不回應
    if (/(https?:\/\/[^\s)\]>]+)|(www\.[^\s)\]>]+)/i.test(rawCleaned)) return;

    if (SKIP_PREFIX_RE?.test(rawCleaned)) return;

    if (!shouldRandomReply(message.id, getReplyChance(message.guild?.id))) return;

    try {
        let mode;
        const shortReply = await withTyping(message.channel, async () => {
            const [{ cleanedText, emojiParts }, attachmentParts] = await Promise.all([
                processCustomEmojis(rawCleaned),
                processAttachments(message.attachments),
            ]);
            mode = getUserMode(message.author.id, scope);
            return getShortResponse({
                userId: message.author.id, prompt: cleanedText, imageParts: [...emojiParts, ...attachmentParts],
                channel: message.channel, messageId: message.id, botId, message, mode, scope,
            });
        });
        if (shortReply) {
            await sendChunks(message, shortReply, { mode, scope });
            await aiTts()?.speakWithTTS(message, shortReply.text, message.guild?.id);
        }
    } catch (error) {
        logger.error('AI', `隨機回覆錯誤：${error.message}`);
    }
}

// ════════════════════════════════════════════════════════
//  開機摘要
// ════════════════════════════════════════════════════════
// 預設人格與固定人格（AI_DEFAULT_MODE／AI_USER_MODE_OVERRIDES）的設定問題（不鎖定時）
// 只列模式代號，不印使用者 ID
function describePersonaWarnings() {
    const warnings = [];
    if (DEFAULT_MODE_INVALID) warnings.push(`AI_DEFAULT_MODE=${DEFAULT_MODE_INVALID} 不合法，改用 default`);
    if (!promptStore.getMode(DEFAULT_MODE)) {
        warnings.push(`預設人格 data/prompts/modes/${DEFAULT_MODE}.md 不存在，沒選人格的人會沒有人格`);
    }
    const { invalid, duplicates } = USER_MODE_OVERRIDE_ERRORS;
    if (invalid.length) warnings.push(`AI_USER_MODE_OVERRIDES 有 ${invalid.length} 筆格式錯誤`);
    if (duplicates.length) warnings.push(`AI_USER_MODE_OVERRIDES 有 ${duplicates.length} 筆重複的使用者（以後面的為準）`);
    const missing = [...new Set(Object.values(modeSelector().listFixedUserModes()))].filter((m) => !promptStore.getMode(m));
    for (const m of missing) warnings.push(`固定人格 ${m} 不存在，那些人改用 ${DEFAULT_MODE}`);
    return warnings;
}

const MEME_SEND_TEXT = () => (publicBase()
    ? `送網址（${publicBase()}）`
    : '送附件（手機版會拉滿寬度；設 MEME_PUBLIC_URL=https://… 改送網址）');

function reportBootSummary() {
    const searchText = `搜尋接地：${SEARCH_GUILD_IDS.size ? `${SEARCH_GUILD_IDS.size} 個伺服器` : '停用'}`;

    if (lock) {
        // 單一人格：人格檔不存在時用內建的通用人格（warn）；表情包那一列一律顯示
        const key = persona.getPersonaKey();
        const hasFile = persona.hasPersonaFile();
        const personaText = hasFile
            ? `人格：${persona.getPersonaName()}（${key}）`
            : `找不到 data/prompts/modes/${key}.md，使用內建的通用人格`;
        bootSummary.report(
            'AI 對話 (/ai)',
            hasFile ? 'ok' : 'warn',
            `Gemini (${MODEL_NAME}) 單一人格；${personaText}；額度：${describeLimits()}；${searchText}`
        );
        const memeCount = listMemes(key).length;
        bootSummary.report(
            'AI 表情包',
            memeCount ? 'ok' : 'off',
            memeCount
                ? `${memeCount} 張，${MEME_SEND_TEXT()}`
                : `沒有圖庫（data/memes/${key}/），要用請跑 node examples/memes/importNekowhale.js --persona ${key}（見 README「表情包」）`
        );
        return;
    }

    const personaWarnings = describePersonaWarnings();
    bootSummary.report(
        'AI 對話 (/ai)',
        personaWarnings.length ? 'warn' : 'ok',
        `Gemini (${MODEL_NAME}) 已連線，${modeSelector().getAvailableModes().length} 種人格模式可用；額度：${describeLimits()}；` +
        searchText +
        personaWarnings.map((w) => `；${w}`).join('')
    );
    // 多人格時每個人格各自的圖庫；一個都沒有就不顯示這一列
    const libs = listLibraries();
    if (libs.length > 0) {
        bootSummary.report(
            'AI 表情包',
            'ok',
            `${libs.map(l => `${l.key} ${l.count} 張`).join('、')}，${MEME_SEND_TEXT()}`
        );
    }
}

// ════════════════════════════════════════════════════════
//  setupAICommands
// ════════════════════════════════════════════════════════
function setupAICommands(client) {
    // 正常情況下 utils/features.js 在沒有 GEMINI_API_KEY 時就不會呼叫這裡；這是直接呼叫時的防線
    if (!isAIEnabled()) {
        bootSummary.report('AI 對話 (/ai)', 'off', '未設定 GEMINI_API_KEY，AI 功能停用');
        return false;
    }

    lock = persona.getLock();
    aiCommand.data = buildAiCommand({ lock, tts: features.isEnabled('aiTts'), gugu: features.isEnabled('gugu') });
    client.commands.set(aiCommand.data.name, aiCommand);

    reportBootSummary();

    client.on('messageCreate', async message => {
        // 鎖定時群聊歷史以伺服器頻道為單位，私訊不回覆
        if (message.author.bot || (lock && !message.guild)) return;

        const hasAttachment = message.attachments.size > 0;
        const content = message.content?.trim() || '';
        const hasLikelyImageLink = LIKELY_IMAGE_LINK_RE.test(content);
        if (!content && !hasAttachment && !hasLikelyImageLink) return;

        const botId = client.user.id;
        const mentionedRoles = message.mentions.roles;
        // 🐛 預設 has() 會把 @everyone/@here 與「Bot 也有的身分組」都算成 @Bot，公告會觸發完整回覆；
        //    只認直接 @Bot（含回覆 Bot 的訊息）與 Bot 自己的整合身分組
        const isMentioned =
            message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true }) ||
            mentionedRoles.some(r => r.tags?.botId === botId);
        const hasOtherMention =
            message.mentions.users.some(u => u.id !== botId) ||
            mentionedRoles.size > 0;
        const hasReference = !!message.reference?.messageId;

        if (hasOtherMention && !hasReference && !isMentioned) return;

        // 範圍只在這裡解析一次（純記憶體查詢），人格、歷史與訊息紀錄都用同一份，中途被切換也不會前後不一致
        const scope = persona.resolveScope(message.channel, message.guild?.id);

        if (isMentioned) {
            // 將提及轉換為名字，並濾掉機器人自己（頻道停用隨機回覆不影響 @ 提及）
            const rawQuestion = replaceMentions(message, botId);
            await handleMention(message, client, { rawQuestion, hasAttachment, hasLikelyImageLink, scope });
        } else {
            await handleRandomReply(message, client, { hasAttachment, hasReference, scope });
        }
    });

    return true;
}

module.exports = { setupAICommands, isAIEnabled, getGeminiResponse, getGeminiResponseVoice };
