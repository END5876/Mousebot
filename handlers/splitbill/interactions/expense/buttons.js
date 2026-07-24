'use strict';

// handlers/splitbill/interactions/expense/buttons.js
// 職責：exp_* 按鈕互動（記帳管理分頁導覽、新增花費/收訂金起始、
//       帳目分頁導覽、刪除確認/取消、全體平分/分攤方式按鈕）

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const storage = require('../../utils/storage');
const { resolveTrip, memberDisplay } = require('../../utils/tripHelper');
const { showMainMenu } = require('../../commands/splitbill');
const { parseLedgerSuffix, formatAmountConversion, formatParticipantsList } = require('./helpers');
const { renderLedgerPage } = require('./ledger');
const { completeExpenseLogging } = require('./logging');

async function handleButton(interaction, cache) {
  const { customId, guildId } = interaction;
  const { trip } = resolveTrip(guildId);

  if (customId === 'nav_main') return showMainMenu(interaction);

  if (customId === 'exp_nav') {
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('💸 記帳管理分頁')
      .setDescription(`當前行程：**${trip.name}**\n請選擇您要執行的記帳操作：`);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('exp_btn_add_start').setLabel('➕ 新增花費').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('exp_btn_deposit_start').setLabel('💰 收取金額').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('exp_btn_ledger_last__exp').setLabel('📒 總帳目清單／刪除').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('nav_main').setLabel('🏠 返回主控台').setStyle(ButtonStyle.Secondary)
    );

    return interaction.update({ embeds: [embed], components: [row] });
  }

  if (customId === 'exp_btn_deposit_start') {
    if (!trip.members || trip.members.length < 2) {
      return interaction.reply({ content: '⚠️ 此行程成員不足兩人，無法使用訂金功能！', flags: MessageFlags.Ephemeral });
    }

    const currencies = Object.keys(trip.rates);
    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('💰 步驟 1/4：選擇幣別')
      .setDescription('這筆訂金是用哪種幣別收的？\n*(訂金會保留原始幣別，不會預先換算成本位幣)*');

    const selectRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('exp_select_deposit_currency')
        .setPlaceholder('選擇訂金幣別...')
        .addOptions(
          currencies.map(c => ({
            label: `${c}${c === trip.baseCurrency ? ' (基準本位幣)' : ''}`,
            value: c
          })).slice(0, 25)
        )
    );

    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('exp_nav').setLabel('⬅️ 取消並返回').setStyle(ButtonStyle.Secondary)
    );

    return interaction.update({ embeds: [embed], components: [selectRow, navRow] });
  }

  if (customId === 'exp_btn_add_start') {
    if (!trip.members || trip.members.length === 0) {
      return interaction.reply({ content: '⚠️ 此行程目前沒有任何成員，請先到「成員管理」新增成員！', flags: MessageFlags.Ephemeral });
    }

    const currencies = Object.keys(trip.rates);
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('💱 步驟 1/3：請選擇幣別')
      .setDescription('為方便計算，請先由下方選單選擇此筆花費的「結帳幣別」。');

    const selectRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('exp_select_currency')
        .setPlaceholder('選擇結帳貨幣...')
        .addOptions(
          currencies.map(c => ({
            label: `${c}${c === trip.baseCurrency ? ' (基準本位幣)' : ''}`,
            description: c !== trip.baseCurrency ? `參考匯率: ${trip.rates[c]}` : '匯率: 1',
            value: c
          })).slice(0, 25)
        )
    );

    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('exp_nav').setLabel('⬅️ 取消並返回').setStyle(ButtonStyle.Secondary)
    );

    return interaction.update({ embeds: [embed], components: [selectRow, navRow] });
  }

  if (customId.startsWith('exp_btn_ledger_')) {
    const suffix = customId.substring('exp_btn_ledger_'.length);
    const { page, source } = parseLedgerSuffix(suffix);
    return renderLedgerPage(interaction, trip, page, null, source);
  }

  // ✅ 使用者在確認畫面點擊「確認刪除」，這時才真正執行刪除動作
  if (customId === 'exp_btn_confirm_delete') {
    const state = cache.get(guildId, interaction.user.id);
    if (!state || !state.pendingDelete) {
      return interaction.reply({ content: '⚠️ 確認逾時或快取失效，請重新操作一次刪除流程。', flags: MessageFlags.Ephemeral });
    }

    const { type, id: realId, page, source } = state.pendingDelete;
    cache.delete(guildId, interaction.user.id);

    if (type === 'expense') {
      const idx = trip.expenses.findIndex(e => e.id === realId);
      if (idx === -1) {
        return renderLedgerPage(interaction, trip, page, '⚠️ 找不到此花費帳目，可能已被其他人刪除。', source);
      }
      const deleted = trip.expenses.splice(idx, 1)[0];
      storage.persist();
      return renderLedgerPage(interaction, trip, page, `🗑️ 已成功刪除花費：**${deleted.description}** (${deleted.amount} ${deleted.currency})`, source);
    } else if (type === 'deposit') {
      const idx = trip.deposits.findIndex(d => d.id === realId);
      if (idx === -1) {
        return renderLedgerPage(interaction, trip, page, '⚠️ 找不到此訂金紀錄，可能已被其他人刪除。', source);
      }
      const deleted = trip.deposits.splice(idx, 1)[0];
      storage.persist();
      return renderLedgerPage(interaction, trip, page, `🗑️ 已成功刪除訂金紀錄：**${memberDisplay(trip, deleted.payerId)} 預付給 ${memberDisplay(trip, deleted.collectorId)}** (${deleted.amount} ${deleted.currency})`, source);
    }
  }

  // ✅ 使用者在確認畫面點擊「取消」，放棄本次刪除，直接回到原頁面（資料不變）
  if (customId === 'exp_btn_cancel_delete') {
    const state = cache.get(guildId, interaction.user.id);
    const pending = state && state.pendingDelete;
    cache.delete(guildId, interaction.user.id);

    const page = pending ? pending.page : 0;
    const source = pending ? pending.source : 'exp';
    return renderLedgerPage(interaction, trip, page, '↩️ 已取消刪除操作，帳目未變動。', source);
  }

  if (customId === 'exp_btn_split_all') {
    const state = cache.get(guildId, interaction.user.id);
    if (!state) return interaction.reply({ content: '⚠️ 狀態過期，請重新操作。', flags: MessageFlags.Ephemeral });
    const allMemberIds = trip.members.map(m => m.id);
    return completeExpenseLogging(interaction, trip, state, allMemberIds, cache);
  }

  if (customId === 'exp_btn_split_custom') {
    const embed = new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle('🎯 選擇分攤成員')
      .setDescription('請使用下方選單選擇需要一起平分這筆錢的成員：');

    const memberOptions = trip.members.slice(0, 25).map(m => ({ label: m.name, value: m.id }));
    const selectRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('exp_select_participants')
        .setPlaceholder('挑選分攤此花費的人...')
        .setMinValues(1)
        .setMaxValues(memberOptions.length)
        .addOptions(memberOptions)
    );

    return interaction.update({ embeds: [embed], components: [selectRow] });
  }

  if (customId === 'exp_btn_split_custom_amount') {
    const state = cache.get(guildId, interaction.user.id);
    if (!state) return interaction.reply({ content: '⚠️ 狀態過期，請重新操作。', flags: MessageFlags.Ephemeral });

    const maxSelect = Math.min(trip.members.length, 5);
    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('✏️ 自訂金額分攤')
      .setDescription(
        `總花費：**${state.amount} ${state.currency}**\n\n` +
        `請選擇需要「指定各自應付金額」的成員。\n` +
        `*(⚠️ Discord 表單限制，最多可選 ${maxSelect} 人；未被選到的人視為不參與此筆分攤)*\n` +
        `*(💡 若某人不需付錢，填入 0 即可)*`
      );

    const memberOptions = trip.members.slice(0, 25).map(m => ({ label: m.name, value: m.id }));
    const selectRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('exp_select_custom_participants')
        .setPlaceholder(`選擇成員 (最多 ${maxSelect} 人)...`)
        .setMinValues(1)
        .setMaxValues(maxSelect)
        .addOptions(memberOptions)
    );

    return interaction.update({ embeds: [embed], components: [selectRow] });
  }
}

module.exports = { handleButton };
