'use strict';

// handlers/splitbill/interactions/expense/logging.js
// 職責：分攤方式選擇 UI、完成記帳（平分 / 自訂分攤）的收尾邏輯
// 由 buttons.js（全體平分）與 selects.js（部分成員平分 / 自訂金額）共用

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const storage = require('../../utils/storage');
const { equalSplit } = require('../../utils/calculator');
const { showMainMenu } = require('../../commands/splitbill');
const { formatAmountConversion } = require('./helpers');

function renderSplitMethodUI(interaction, state) {
  const payerMentions = state.payers.map(p => `<@${p.userId}>(${p.amount})`).join(', ');
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('⚖️ 步驟 3/3：選擇分攤方式')
    .setDescription(`代墊者：${payerMentions}\n\n請點選下方按鈕直接完成分攤：`);

  const btnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('exp_btn_split_all').setLabel('👥 全體平分').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('exp_btn_split_custom').setLabel('🎯 部分成員平分').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('exp_btn_split_custom_amount').setLabel('✏️ 自訂金額分攤').setStyle(ButtonStyle.Danger)
  );

  return interaction.update({ embeds: [embed], components: [btnRow] });
}

async function completeExpenseLogging(interaction, trip, state, participantIds, cache) {
  try {
    const shares = equalSplit(state.amount, participantIds);

    const newTotal = shares.reduce((sum, s) => sum + s.share, 0);
    const extra = newTotal - state.amount;

    if (extra > 0) {
      state.payers[0].amount += extra;
      state.amount = newTotal;
    }

    const amountInBase = Math.round((state.amount * state.exchangeRate + Number.EPSILON) * 100) / 100;

    const newExpense = {
      id: state.id,
      description: state.description,
      amount: state.amount,
      currency: state.currency,
      exchangeRate: state.exchangeRate,
      rateSource: state.rateSource,
      amountInBase,
      payers: state.payers,
      participants: shares.map(s => ({ userId: s.userId, amount: s.share })),
      createdAt: Date.now(),
      createdBy: interaction.user.id
    };

    trip.expenses.push(newExpense);
    storage.persist();
    cache.delete(interaction.guildId, interaction.user.id);

    const payerText = newExpense.payers.map(p => `<@${p.userId}>`).join(', ');
    const amountText = formatAmountConversion(newExpense.amount, newExpense.currency, amountInBase, trip.baseCurrency);
    const msg = `✅ **記帳成功！** 項目：${newExpense.description} | 金額：${amountText} | 代墊：${payerText}`;

    return showMainMenu(interaction, msg);

  } catch (err) {
    const errMsg = `❌ 核心記帳計算失敗：${err.message}`;
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: errMsg });
    }
    return interaction.reply({ content: errMsg, flags: MessageFlags.Ephemeral });
  }
}

async function completeExpenseLoggingWithShares(interaction, trip, state, shares, cache) {
  try {
    const amountInBase = Math.round((state.amount * state.exchangeRate + Number.EPSILON) * 100) / 100;

    const newExpense = {
      id: state.id,
      description: state.description,
      amount: state.amount,
      currency: state.currency,
      exchangeRate: state.exchangeRate,
      rateSource: state.rateSource,
      amountInBase,
      payers: state.payers,
      participants: shares.map(s => ({ userId: s.userId, amount: s.share })),
      createdAt: Date.now(),
      createdBy: interaction.user.id
    };

    trip.expenses.push(newExpense);
    storage.persist();
    cache.delete(interaction.guildId, interaction.user.id);

    const payerText = newExpense.payers.map(p => `<@${p.userId}>`).join(', ');
    const shareText = shares.map(s => `<@${s.userId}>(${s.share})`).join('、');
    const amountText = formatAmountConversion(newExpense.amount, newExpense.currency, amountInBase, trip.baseCurrency);
    const msg = `✅ **記帳成功（自訂分攤）！** 項目：${newExpense.description} | 金額：${amountText}\n代墊：${payerText}\n各自應付：${shareText}`;

    return showMainMenu(interaction, msg);

  } catch (err) {
    const errMsg = `❌ 核心記帳計算失敗：${err.message}`;
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: errMsg });
    }
    return interaction.reply({ content: errMsg, flags: MessageFlags.Ephemeral });
  }
}

module.exports = {
  renderSplitMethodUI,
  completeExpenseLogging,
  completeExpenseLoggingWithShares,
};
