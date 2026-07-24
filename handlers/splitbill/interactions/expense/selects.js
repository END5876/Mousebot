'use strict';

// handlers/splitbill/interactions/expense/selects.js
// 職責：exp_select_* 下拉選單互動（幣別/收付款人/分攤成員/刪除確認）

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { resolveTrip, memberDisplay } = require('../../utils/tripHelper');
const { parseLedgerSuffix, formatAmountConversion, formatParticipantsList } = require('./helpers');
const { renderSplitMethodUI, completeExpenseLogging } = require('./logging');

async function handleSelectMenu(interaction, cache) {
  const { customId, guildId, values, user } = interaction;
  const { trip } = resolveTrip(guildId);

  if (customId === 'exp_select_deposit_currency') {
    const selectedCurrency = values[0];
    cache.set(guildId, user.id, { depositCurrency: selectedCurrency });

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('💰 步驟 2/4：選擇收款人')
      .setDescription(`幣別：**${selectedCurrency}**\n\n誰負責「代收」這筆訂金？\n*(例如：負責統一訂機票/住宿的人)*`);

    const selectRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('exp_select_deposit_collector')
        .setPlaceholder('選擇收款人...')
        .addOptions(trip.members.slice(0, 25).map(m => ({ label: m.name, value: m.id })))
    );

    return interaction.update({ embeds: [embed], components: [selectRow] });
  }

  if (customId === 'exp_select_deposit_collector') {
    const state = cache.get(guildId, user.id);
    if (!state || !state.depositCurrency) return interaction.reply({ content: '⚠️ 快取失效，請重新操作。', flags: MessageFlags.Ephemeral });
    state.depositCollectorId = values[0];

    const availableMembers = trip.members.filter(m => m.id !== values[0]);
    const maxSelect = Math.min(availableMembers.length, 5);

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('💰 步驟 3/4：選擇付款人')
      .setDescription(`幣別：**${state.depositCurrency}**\n\n誰「付錢」給了收款人？\n*(💡 可多選，最多 ${maxSelect} 人)*`);

    const selectRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('exp_select_deposit_payer')
        .setPlaceholder(`選擇付款人 (可多選，最多 ${maxSelect} 人)...`)
        .setMinValues(1)
        .setMaxValues(maxSelect)
        .addOptions(availableMembers.slice(0, 25).map(m => ({ label: m.name, value: m.id })))
    );

    return interaction.update({ embeds: [embed], components: [selectRow] });
  }

  if (customId === 'exp_select_deposit_payer') {
    const state = cache.get(guildId, user.id);
    if (!state || !state.depositCurrency || !state.depositCollectorId) {
      return interaction.reply({ content: '⚠️ 快取失效，請重新操作。', flags: MessageFlags.Ephemeral });
    }

    state.depositPayerIds = values;

    const modal = new ModalBuilder()
      .setCustomId('exp_modal_multi_deposit')
      .setTitle(`💰 步驟 4/4：輸入訂金金額 (${state.depositCurrency})`);

    values.forEach((id, idx) => {
      const memberName = trip.members.find(m => m.id === id).name;
      const amountInput = new TextInputBuilder()
        .setCustomId(`dep_amount_${idx}`)
        .setLabel(`${memberName} 付了多少 (${state.depositCurrency})？`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
    });

    if (values.length < 5) {
      const noteInput = new TextInputBuilder()
        .setCustomId('dep_note')
        .setLabel('備註 (選填，例如：機票+住宿訂金)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(noteInput));
    }

    return interaction.showModal(modal);
  }

  if (customId === 'exp_select_currency') {
    const selectedCurrency = values[0];
    const modal = new ModalBuilder()
      .setCustomId(`exp_modal_add_${selectedCurrency}`)
      .setTitle(`步驟 2/3：新增花費 (${selectedCurrency})`);

    const descInput = new TextInputBuilder().setCustomId('desc').setLabel('項目名稱 (例如：計程車、晚餐)').setStyle(TextInputStyle.Short).setRequired(true);
    const amountInput = new TextInputBuilder().setCustomId('amount').setLabel(`金額 (單位: ${selectedCurrency})`).setStyle(TextInputStyle.Short).setRequired(true);
    const rateInput = new TextInputBuilder().setCustomId('custom_rate').setLabel(`自訂匯率 (1 ${selectedCurrency} = ? ${trip.baseCurrency})`).setStyle(TextInputStyle.Short).setPlaceholder('💡 留空將自動抓取當下即時網路匯率').setRequired(false);

    modal.addComponents(new ActionRowBuilder().addComponents(descInput), new ActionRowBuilder().addComponents(amountInput), new ActionRowBuilder().addComponents(rateInput));
    return interaction.showModal(modal);
  }

  if (customId === 'exp_select_payer') {
    const state = cache.get(guildId, user.id);
    if (!state) return interaction.reply({ content: '⚠️ 快取過期，請重新開啟。', flags: MessageFlags.Ephemeral });

    const payerIds = values;
    const invalid = payerIds.filter(id => !trip.members.some(m => m.id === id));
    if (invalid.length) {
      return interaction.reply({ content: '⚠️ 選擇的使用者不在此行程的成員名單內！', flags: MessageFlags.Ephemeral });
    }

    if (payerIds.length === 1) {
      state.payers = [{ userId: payerIds[0], amount: state.amount }];
      return renderSplitMethodUI(interaction, state);
    } else {
      state.tempPayerIds = payerIds;
      const modal = new ModalBuilder().setCustomId('exp_modal_multi_payer').setTitle(`輸入多人代墊金額 (總計: ${state.amount})`);

      payerIds.forEach((id, idx) => {
        const memberName = trip.members.find(m => m.id === id).name;
        const input = new TextInputBuilder().setCustomId(`payer_${idx}`).setLabel(`${memberName} 付了多少？`).setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
      });

      return interaction.showModal(modal);
    }
  }

  if (customId === 'exp_select_participants') {
    const state = cache.get(guildId, user.id);
    if (!state) return interaction.reply({ content: '⚠️ 快取已失效。', flags: MessageFlags.Ephemeral });

    const participantIds = values.filter(id => trip.members.some(m => m.id === id));
    if (!participantIds.length) return interaction.reply({ content: '⚠️ 所選成員皆不在行程中。', flags: MessageFlags.Ephemeral });

    return completeExpenseLogging(interaction, trip, state, participantIds, cache);
  }

  if (customId === 'exp_select_custom_participants') {
    const state = cache.get(guildId, user.id);
    if (!state) return interaction.reply({ content: '⚠️ 快取過期，請重新開啟。', flags: MessageFlags.Ephemeral });

    const invalid = values.filter(id => !trip.members.some(m => m.id === id));
    if (invalid.length) {
      return interaction.reply({ content: '⚠️ 選擇的使用者不在此行程的成員名單內！', flags: MessageFlags.Ephemeral });
    }

    state.tempCustomParticipantIds = values;

    const modal = new ModalBuilder()
      .setCustomId('exp_modal_custom_split')
      .setTitle(`✏️ 輸入各自應付金額 (總計: ${state.amount})`);

    values.forEach((id, idx) => {
      const memberName = trip.members.find(m => m.id === id).name;
      const input = new TextInputBuilder()
        .setCustomId(`share_${idx}`)
        .setLabel(`${memberName} 應付多少 (免費請填 0)？`)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('例如：0、1000、2000')
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
    });

    return interaction.showModal(modal);
  }

  // ✅ 不再直接刪除，改為先暫存待刪除紀錄，顯示確認畫面
  // customId 仍帶有「目前頁碼__來源」，讓確認/取消按鈕都能記得回到哪一頁、哪個來源分頁
  if (customId.startsWith('exp_select_delete_')) {
    const suffix = customId.substring('exp_select_delete_'.length);
    const { page, source } = parseLedgerSuffix(suffix);
    const [type, ...rest] = values[0].split('_');
    const realId = rest.join('_');

    let record, titleText, detailText, color;

    if (type === 'expense') {
      record = trip.expenses.find(e => e.id === realId);
      if (!record) return interaction.reply({ content: '⚠️ 找不到此花費帳目，可能已被其他人刪除。', flags: MessageFlags.Ephemeral });

      const amountText = formatAmountConversion(record.amount, record.currency, record.amountInBase, trip.baseCurrency);
      const payers = record.payers.map(p => memberDisplay(trip, p.userId)).join('、');
      const participantsText = formatParticipantsList(trip, record.participants, record.currency);

      titleText = `[花費] ${record.description}`;
      color = 0xe74c3c;
      detailText =
        `💰 金額：${amountText}\n` +
        `👤 代墊：${payers}\n` +
        `📊 分攤：${participantsText}`;
    } else if (type === 'deposit') {
      record = trip.deposits.find(d => d.id === realId);
      if (!record) return interaction.reply({ content: '⚠️ 找不到此訂金紀錄，可能已被其他人刪除。', flags: MessageFlags.Ephemeral });

      const amountText = formatAmountConversion(record.amount, record.currency, record.amountInBase, trip.baseCurrency);
      titleText = `[訂金] ${memberDisplay(trip, record.payerId)} → ${memberDisplay(trip, record.collectorId)}`;
      color = 0xe74c3c;
      detailText =
        `💰 金額：${amountText}` +
        (record.note ? `\n📝 備註：${record.note}` : '');
    } else {
      return interaction.reply({ content: '⚠️ 無法識別的紀錄類型。', flags: MessageFlags.Ephemeral });
    }

    // 暫存待刪除資訊，供確認/取消按鈕使用
    cache.set(guildId, user.id, {
      pendingDelete: { type, id: realId, page, source }
    });

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle('⚠️ 確認刪除此筆紀錄？')
      .setDescription(
        `**${titleText}**\n${detailText}\n\n` +
        `❗ 此操作**無法復原**，請再次確認是否要刪除。`
      );

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('exp_btn_confirm_delete').setLabel('✅ 確認刪除').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('exp_btn_cancel_delete').setLabel('↩️ 取消').setStyle(ButtonStyle.Secondary)
    );

    return interaction.update({ content: '', embeds: [embed], components: [confirmRow] });
  }
}

module.exports = { handleSelectMenu };
