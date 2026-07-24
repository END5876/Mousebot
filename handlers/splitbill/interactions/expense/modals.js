'use strict';

// handlers/splitbill/interactions/expense/modals.js
// 職責：exp_modal_* 表單送出處理（新增花費/多人代墊/自訂分攤金額/多人訂金）

const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const storage = require('../../utils/storage');
const { resolveTrip } = require('../../utils/tripHelper');
const { validateCustomSplit, fetchRealTimeRate, round2 } = require('../../utils/calculator');
const { addDeposit } = require('../../utils/deposit');
const { showMainMenu } = require('../../commands/splitbill');
const { renderSplitMethodUI, completeExpenseLoggingWithShares } = require('./logging');

async function handleModal(interaction, cache) {
  if (interaction.customId === 'exp_modal_multi_deposit') {
    const { guildId, user } = interaction;
    const { trip } = resolveTrip(guildId);
    const state = cache.get(guildId, user.id);

    if (!state || !state.depositCurrency || !state.depositCollectorId || !state.depositPayerIds) {
      return interaction.reply({ content: '⚠️ 快取失效，請重新操作。', flags: MessageFlags.Ephemeral });
    }

    let note = '預收款/訂金';
    if (state.depositPayerIds.length < 5) {
      try {
        const inputNote = interaction.fields.getTextInputValue('dep_note');
        if (inputNote) note = inputNote;
      } catch (e) {}
    }

    const depositsAdded = [];
    let totalAmount = 0;

    try {
      for (let i = 0; i < state.depositPayerIds.length; i++) {
        const amountStr = interaction.fields.getTextInputValue(`dep_amount_${i}`);
        const amount = parseFloat(amountStr);

        if (isNaN(amount) || amount <= 0) {
          throw new Error(`第 ${i + 1} 筆金額格式錯誤，必須大於 0。`);
        }

        const deposit = addDeposit(trip, {
          collectorId: state.depositCollectorId,
          payerId: state.depositPayerIds[i],
          amount,
          currency: state.depositCurrency,
          note
        });

        depositsAdded.push(deposit);
        totalAmount += amount;
      }

      storage.persist();
      cache.delete(guildId, user.id);

      const payerMentions = depositsAdded.map(d => `<@${d.payerId}>(${d.amount})`).join('、');
      const msg = `✅ **預收款紀錄成功！** <@${state.depositCollectorId}> 共收了 ${totalAmount} ${state.depositCurrency}。\n付款人：${payerMentions}\n備註：${note}`;

      return showMainMenu(interaction, msg);
    } catch (err) {
      return interaction.reply({ content: `❌ 錯誤：${err.message}`, flags: MessageFlags.Ephemeral });
    }
  }

  if (interaction.customId.startsWith('exp_modal_add_')) {
    const { guildId, user } = interaction;
    const { trip } = resolveTrip(guildId);

    const currency = interaction.customId.replace('exp_modal_add_', '');
    const desc = interaction.fields.getTextInputValue('desc');
    const amount = parseFloat(interaction.fields.getTextInputValue('amount'));
    const customRateStr = interaction.fields.getTextInputValue('custom_rate');

    if (isNaN(amount) || amount <= 0) {
      return interaction.reply({ content: '⚠️ 請輸入正確的大於 0 的金額數字。', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferUpdate();

    let actualRate;
    let rateSource;

    if (customRateStr && !isNaN(parseFloat(customRateStr)) && parseFloat(customRateStr) > 0) {
      actualRate = parseFloat(customRateStr);
      rateSource = '手動自訂';
    } else if (currency === trip.baseCurrency) {
      actualRate = 1;
      rateSource = '本位幣';
    } else {
      const liveRate = await fetchRealTimeRate(currency, trip.baseCurrency);
      if (liveRate) {
        actualRate = liveRate;
        rateSource = '網路即時';
      } else {
        actualRate = trip.rates[currency] ?? 1;
        rateSource = '行程預設';
      }
    }

    cache.set(guildId, user.id, {
      id: `id_${Date.now().toString(36)}`,
      description: desc,
      amount,
      currency,
      exchangeRate: actualRate,
      rateSource
    });

    const embed = new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle('👤 請選擇代墊者')
      .setDescription(
        `項目：**${desc}**\n` +
        `金額：**${amount} ${currency}**\n` +
        `匯率：**1 ${currency} = ${actualRate} ${trip.baseCurrency}** (${rateSource})\n\n` +
        `👉 誰先幫大家付了這筆錢？\n*(💡 若為多人合資代墊，請直接複選)*`
      );

    const memberOptions = trip.members.slice(0, 25).map(m => ({ label: m.name, value: m.id }));
    const selectRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('exp_select_payer')
        .setPlaceholder('選擇代墊者 (可多選，最多5人)...')
        .setMinValues(1)
        .setMaxValues(Math.min(memberOptions.length, 5))
        .addOptions(memberOptions)
    );

    return interaction.editReply({ embeds: [embed], components: [selectRow] });
  }

  if (interaction.customId === 'exp_modal_multi_payer') {
    const { guildId, user } = interaction;
    const { trip } = resolveTrip(guildId);
    const state = cache.get(guildId, user.id);

    if (!state || !state.tempPayerIds) return interaction.reply({ content: '⚠️ 快取過期，請重新開啟。', flags: MessageFlags.Ephemeral });

    let sum = 0;
    const payers = [];

    for (let i = 0; i < state.tempPayerIds.length; i++) {
      const valStr = interaction.fields.getTextInputValue(`payer_${i}`);
      const val = parseFloat(valStr);
      if (isNaN(val) || val < 0) {
        return interaction.reply({ content: `⚠️ 請輸入正確的數字（不可為負數）。`, flags: MessageFlags.Ephemeral });
      }
      sum += val;
      payers.push({ userId: state.tempPayerIds[i], amount: val });
    }

    if (Math.abs(sum - state.amount) > 0.01) {
      cache.delete(guildId, user.id);
      return showMainMenu(interaction, `⚠️ **記帳已取消**：多人代墊金額加總 (**${sum}**) 不等於總花費 (**${state.amount}**)！請重新操作。`);
    }

    state.payers = payers;
    delete state.tempPayerIds;

    return renderSplitMethodUI(interaction, state);
  }

  if (interaction.customId === 'exp_modal_custom_split') {
    const { guildId, user } = interaction;
    const { trip } = resolveTrip(guildId);
    const state = cache.get(guildId, user.id);

    if (!state || !state.tempCustomParticipantIds) {
      return interaction.reply({ content: '⚠️ 快取過期，請重新開啟。', flags: MessageFlags.Ephemeral });
    }

    const shares = [];
    for (let i = 0; i < state.tempCustomParticipantIds.length; i++) {
      const valStr = interaction.fields.getTextInputValue(`share_${i}`);
      const val = parseFloat(valStr);
      if (isNaN(val) || val < 0) {
        return interaction.reply({ content: '⚠️ 請輸入正確的數字（不可為負數，免費請填 0）。', flags: MessageFlags.Ephemeral });
      }
      shares.push({ userId: state.tempCustomParticipantIds[i], share: round2(val) });
    }

    try {
      validateCustomSplit(state.amount, shares);
    } catch (err) {
      cache.delete(guildId, user.id);
      return showMainMenu(interaction, `⚠️ **記帳已取消**：${err.message}`);
    }

    delete state.tempCustomParticipantIds;
    return completeExpenseLoggingWithShares(interaction, trip, state, shares, cache);
  }
}

module.exports = { handleModal };
