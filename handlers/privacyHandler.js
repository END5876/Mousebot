// handlers/privacyHandler.js
// /privacy info｜delete：公開模式（PUBLIC_MODE=1）才註冊，私人版沒有這個指令。
//
// info  ：這隻 Bot 存了使用者的哪些資料、存多久、隱私權政策網址（PRIVACY_POLICY_URL）
// delete：刪除自己的資料，按確認按鈕才執行
//
// 刪除的範圍只有 Bot 本機 data/ 裡「和這個人連在一起」的資料：
//   - AI 人格設定（userModes.json）
//   - AI 回覆紀錄裡回給這個人的部分（aiMessageLog.json，含名稱與 /ai ask 的問題原文）
//   - 每日 token 用量裡這個人的那一份（tokenUsage.json 的 byUser）
//   - 對話記憶：設一個「清除點」，Bot 之後不再把這個時間點以前的訊息當成這個人的對話脈絡
// 對話歷史本身是每次從 Discord 即時讀取，Bot 沒有另外存；分帳、音樂庫是獨立服務，不在這裡處理。
// 這些模組都屬於 ai，所以 ai 沒啟用時對應的項目會略過。

const {
    SlashCommandBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const logger = require('../utils/logger');
const features = require('../utils/features');

const CONFIRM_TTL_MS = 60 * 1000;

function buildCommand() {
    return new SlashCommandBuilder()
        .setName('privacy')
        .setDescription('查看或刪除 Bot 存的你的資料')
        .addSubcommand(sub => sub.setName('info').setDescription('Bot 存了你的哪些資料'))
        .addSubcommand(sub => sub.setName('delete').setDescription('刪除 Bot 存的你的資料'));
}

function infoText() {
    const url = process.env.PRIVACY_POLICY_URL?.trim();
    const lines = [
        '**Bot 存了哪些你的資料**',
        '• AI 人格設定：你用 `/ai mode` 選的人格',
        '• AI 回覆紀錄：Bot 回給你的訊息是哪個人格、你的名稱、`/ai ask` 的問題（最多 300 字），保留 7 天',
        '• AI 用量：你每天用了多少 AI，保留 90 天',
        '對話內容不另外存，每次回覆時從 Discord 讀最近的訊息。',
        '',
        '用 `/privacy delete` 可以全部刪除。',
    ];
    if (url) lines.push(`完整說明：${url}`);
    return lines.join('\n');
}

/**
 * 刪除指定使用者的資料，回傳各項刪掉的數量（測試與回覆文字用）
 * @param {string} userId
 */
function deleteUserData(userId) {
    const result = { mode: false, replies: 0, usageDays: 0, memoryCleared: false };
    if (!features.isEnabled('ai')) return result;

    const modeSelector = require('./ai/modeSelector');
    if (modeSelector.getUserModeOverride(userId) !== null) {
        modeSelector.setUserMode(userId, null);
        result.mode = true;
    }
    result.replies = require('./ai/aiMessageLog').deleteUserEntries(userId);
    result.usageDays = require('./ai/tokenTracker').deleteUserUsage(userId);
    require('./ai/aiMemoryState').clearUserMemory(userId);
    result.memoryCleared = true;
    // 不印使用者 ID
    logger.info('Privacy', `已依使用者要求刪除資料（回覆紀錄 ${result.replies} 筆、用量 ${result.usageDays} 天）`);
    return result;
}

async function handleDelete(interaction) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('privacy:delete:confirm').setLabel('刪除我的資料').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('privacy:delete:cancel').setLabel('取消').setStyle(ButtonStyle.Secondary),
    );
    const response = await interaction.reply({
        content: '確定要刪除 Bot 存的你的資料嗎？刪除後無法復原，AI 也會忘記之前和你的對話。',
        components: [row],
        flags: MessageFlags.Ephemeral,
        withResponse: true,
    });

    let click;
    try {
        click = await response.resource.message.awaitMessageComponent({
            filter: i => i.user.id === interaction.user.id && i.customId.startsWith('privacy:delete:'),
            time: CONFIRM_TTL_MS,
        });
    } catch {
        await interaction.editReply({ content: '已逾時，沒有刪除任何資料。', components: [] }).catch(() => {});
        return;
    }

    if (click.customId !== 'privacy:delete:confirm') {
        await click.update({ content: '已取消，沒有刪除任何資料。', components: [] });
        return;
    }
    deleteUserData(interaction.user.id);
    await click.update({ content: '✅ 已刪除 Bot 存的你的資料。', components: [] });
}

const privacyCommand = {
    data: null,
    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'info') {
            return interaction.reply({ content: infoText(), flags: MessageFlags.Ephemeral });
        }
        if (sub === 'delete') return handleDelete(interaction);
    },
};

function setupPrivacyCommands(client) {
    privacyCommand.data = buildCommand();
    client.commands.set('privacy', privacyCommand);
}

module.exports = { setupPrivacyCommands, deleteUserData, infoText, buildCommand };
