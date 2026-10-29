'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags
} = require('discord.js');
const splitbillClient = require('../../utils/splitbillClient');
const { equalSplit } = require('../../utils/calculator');
const { showMainMenu } = require('../../commands/splitbill');
const { formatAmountConversion, expenseDraftCacheUserId, withDraftId } = require('./helpers');
const { memberMention } = require('../../utils/tripHelper');

// 🔒 [修正：中途切換行程] 新增花費流程每一步都用草稿裡鎖定的 tripId 找行程，成員選項、
// 驗證跟最後寫入才會是同一個行程（以前選項用作用行程，寫入卻是鎖定的行程，
// 會把別的行程的成員 ID 存進來）。行程不見了就取消，不退回作用行程。
async function resolveDraftTrip(interaction, cache, state) {
  const trip = await splitbillClient.resolveTripById(interaction.guildId, state.tripId);
  if (!trip) {
    cache.delete(interaction.guildId, expenseDraftCacheUserId(interaction.user.id, state.id));
    await showMainMenu(interaction, '⚠️ **記帳已取消**：找不到原本的行程（可能已被刪除）。');
    return null;
  }
  return trip;
}

function renderSplitMethodUI(interaction, state, trip) {
  const payerMentions = state.payers.map(p => `${memberMention(trip, p.userId)}(${p.amount})`).join(', ');
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('⚖️ 步驟 3/3：選擇分攤方式')
    .setDescription(`代墊者：${payerMentions}\n\n請點選下方按鈕直接完成分攤：`);

  const btnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(withDraftId('exp_btn_split_all', state.id)).setLabel('👥 全體平分').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(withDraftId('exp_btn_split_custom', state.id)).setLabel('🎯 部分成員平分').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(withDraftId('exp_btn_split_custom_amount', state.id)).setLabel('✏️ 自訂金額分攤').setStyle(ButtonStyle.Danger)
  );

  return interaction.update({ embeds: [embed], components: [btnRow] });
}

async function completeExpenseLogging(interaction, trip, state, participantIds, cache) {
  try {
    // 沒有代墊人就不能存：只有人分攤、沒人代墊，整個行程的淨額加總就不再是 0
    if (!Array.isArray(state.payers) || !state.payers.length) throw new Error('缺少代墊人資料，請重新操作。');
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
    await splitbillClient.saveTrip(interaction.guildId, trip.id, trip, { actorId: interaction.user.id });
    cache.delete(interaction.guildId, expenseDraftCacheUserId(interaction.user.id, state.id));

    const payerText = newExpense.payers.map(p => memberMention(trip, p.userId)).join(', ');
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
      if (!Array.isArray(state.payers) || !state.payers.length) throw new Error('缺少代墊人資料，請重新操作。');
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
      await splitbillClient.saveTrip(interaction.guildId, trip.id, trip, { actorId: interaction.user.id });
      cache.delete(interaction.guildId, expenseDraftCacheUserId(interaction.user.id, state.id));

      const payerText = newExpense.payers.map(p => memberMention(trip, p.userId)).join(', ');
      const shareText = shares.map(s => `${memberMention(trip, s.userId)}(${s.share})`).join('、');
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
  resolveDraftTrip,
  renderSplitMethodUI,
  completeExpenseLogging,
  completeExpenseLoggingWithShares
};
