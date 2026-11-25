// handlers/ai/aiPersonaCommands.js（MouseBot 與 mousebot-lite 共用，兩邊內容相同）
// /ai mode、prompt、scope 的處理（鎖定範圍時沒有這些子指令）。

const { MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const promptStore = require('./promptStore');
const { isOwner } = require('../../utils/config');
const logger = require('../../utils/logger');
const { isAdmin } = require('./aiCommands');

// 只在不鎖定時用到（多人格／單一人格切換、/ai mode）；鎖定時不載入，也不讀寫 aiScope.json、userModes.json
const aiScope = () => require('./aiScope');
const modeSelector = () => require('./modeSelector');

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

module.exports = {
  handleMode,
  handlePromptEdit,
  handleScopeShow,
  handleScopeSet,
  handleScopeReset,
};
