'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { resolveTrip } = require('../utils/tripHelper');
const { calcNetBalances, calcNetBalancesByCurrency, getUsedCurrencies, convertNetToSingleCurrency, round2 } = require('../utils/calculator');
const { simplifyDebts } = require('../utils/settlement');
const { showMainMenu } = require('../commands/splitbill');

/**
 * 每人淨額明細（區分「花費代墊」與「直接轉帳」兩種來源）
 *
 * 用詞修正：
 * 原本用「訂金」來標記 trip.deposits 的正負值，但 deposits 這個機制
 * 本質上只是「兩人之間的直接轉帳」，用途可能是團費預收、還款、代收代付等，
 * 系統無法（也不該）替使用者預設具體用途。改用中性詞彙「已直接付款 / 已收到付款」，
 * 只客觀描述金流方向，不假設背後原因。
 *
 *   - 花費 + 正值 → 幫大家代墊
 *   - 花費 + 負值 → 自己還少給
 *   - 轉帳 + 正值 → 已直接付款給他人
 *   - 轉帳 + 負值 → 已收到他人付款
 */
function formatBreakdownBlock(breakdownEntries) {
  const entries = (breakdownEntries || []).filter(b => Math.abs(b.amount) >= 0.01);

  if (entries.length <= 1) return null;

  const fmt = (list) => list.map(b => `${round2(Math.abs(b.amount))} ${b.currency}`).join('、');

  const expensePositive = entries.filter(b => b.source === 'expense' && b.amount > 0).sort((a, b) => b.amount - a.amount);
  const expenseNegative = entries.filter(b => b.source === 'expense' && b.amount < 0).sort((a, b) => a.amount - b.amount);
  const transferPositive = entries.filter(b => b.source === 'deposit' && b.amount > 0).sort((a, b) => b.amount - a.amount);
  const transferNegative = entries.filter(b => b.source === 'deposit' && b.amount < 0).sort((a, b) => a.amount - b.amount);

  const lines = [];
  if (expensePositive.length) lines.push(`幫大家代墊：${fmt(expensePositive)}`);
  if (expenseNegative.length) lines.push(`自己還少給：${fmt(expenseNegative)}`);
  if (transferPositive.length) lines.push(`已直接付款給他人：${fmt(transferPositive)}`);
  if (transferNegative.length) lines.push(`已收到他人付款：${fmt(transferNegative)}`);

  return lines.map((line, idx) => `　${idx === lines.length - 1 ? '└ ' : '└ '} ${line}`).join('\n');
}

module.exports = {
  async handleButton(interaction, cache) {
    const { customId, guildId } = interaction;
    const { trip } = resolveTrip(guildId);
    if (customId === 'nav_main') {
      return showMainMenu(interaction);
    }

    if (customId === 'set_nav') {
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('📊 結算與淨額中心')
        .setDescription(`當前行程：**${trip.name}**\n請選擇結算檢視工具：`);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_btn_balance').setLabel('🟢 查看每人淨額').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('set_btn_transfer').setLabel('🚀 建議轉帳清單').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('exp_btn_ledger_last__set').setLabel('📒 查看帳目清單').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('nav_main').setLabel('⬅️ 返回主選單').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    // 1. 每人收支淨額分佈
    if (customId === 'set_btn_balance') {
      const net = calcNetBalances(trip);
      const netByCurrency = calcNetBalancesByCurrency(trip);

      const lines = trip.members.map(m => {
        const val = round2(net[m.id] || 0);

        // 把 { expense, deposit } 拆成兩筆獨立 entry，交給 formatBreakdownBlock 分類
        const breakdown = Object.entries(netByCurrency[m.id] || {}).flatMap(([currency, sources]) => {
          const items = [];
          if (Math.abs(sources.expense || 0) >= 0.01) {
            items.push({ currency, amount: sources.expense, source: 'expense' });
          }
          if (Math.abs(sources.deposit || 0) >= 0.01) {
            items.push({ currency, amount: sources.deposit, source: 'deposit' });
          }
          return items;
        });

        if (Math.abs(val) < 0.01) {
          return `⚪ <@${m.id}> 帳目兩清（無需收付）`;
        }

        const statusIcon = val > 0 ? '🟢' : '🔴';
        const actionText = val > 0 ? '應收回' : '要補交';
        const titleLine = `${statusIcon} <@${m.id}> ${actionText} ${round2(Math.abs(val))} ${trip.baseCurrency}`;

        const block = formatBreakdownBlock(breakdown);
        return block ? `${titleLine}\n${block}` : titleLine;
      }).join('\n\n');

      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle(`🟢 「${trip.name}」成員收支淨額`)
        .setDescription(lines || '尚無成員數據。');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_nav').setLabel('⬅️ 返回結算選單').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    // 2. 建議轉帳清單（未變動）
    if (customId === 'set_btn_transfer') {
      const net = calcNetBalances(trip);
      const transactions = simplifyDebts(net);

      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle(`🚀 「${trip.name}」建議轉帳清單（基準幣 ${trip.baseCurrency}）`);

      if (!transactions.length) {
        embed.setDescription('🎉 讚啦！當前所有人帳目皆完全兩清，無須進行任何轉帳！');
      } else {
        const lines = transactions.map((t, idx) =>
          `**${idx + 1}.** <@${t.from}> ➡️ <@${t.to}>：**${round2(t.amount)} ${trip.baseCurrency}**`
        ).join('\n');
        embed.setDescription(lines);
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_btn_transfer_live').setLabel('💱 換算成其他幣別').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('set_nav').setLabel('⬅️ 返回結算選單').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    // 2a. 選擇目標幣別（未變動）
    if (customId === 'set_btn_transfer_live') {
      const currencies = getUsedCurrencies(trip);

      if (!currencies.length) {
        return interaction.reply({ content: '📭 目前尚無任何花費或訂金紀錄，無須換算結算。', flags: MessageFlags.Ephemeral });
      }

      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle('💱 選擇最終結算的統一幣別')
        .setDescription(
          `此行程目前使用過的幣別有：**${currencies.join('、')}**\n` +
          `請選擇要換算成哪一種幣別進行最終結算：\n\n` +
          `*💡 這裡會用「當下即時匯率」重新換算，跟記帳當下存好的匯率可能不同。*`
        );

      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('set_select_convert_target')
          .setPlaceholder('選擇結算的目標幣別...')
          .addOptions(currencies.map(c => ({ label: c, value: c })))
      );

      const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_btn_transfer').setLabel('⬅️ 返回').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [selectRow, navRow] });
    }
  },

  async handleSelectMenu(interaction) {
    const { customId, guildId, values } = interaction;
    const { trip } = resolveTrip(guildId);

    if (customId === 'set_select_convert_target') {
      const targetCurrency = values[0];
      await interaction.deferUpdate();

      const netByCurrency = calcNetBalancesByCurrency(trip);
      const { converted, rates, failedCurrencies } = await convertNetToSingleCurrency(netByCurrency, targetCurrency, trip);

      const rateLines = Object.entries(rates)
        .filter(([currency]) => currency !== targetCurrency)
        .map(([currency, rate]) => `1 ${currency} = ${rate === null ? '❌ 抓取失敗' : `${rate} ${targetCurrency}`}`)
        .join('\n');

      const transactions = simplifyDebts(converted);

      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle(`💱 「${trip.name}」轉帳建議（換算成 ${targetCurrency}，即時匯率）`)
        .setDescription(
          (rateLines ? `**採用即時匯率：**\n${rateLines}\n\n` : '') +
          (transactions.length
            ? `**最精簡轉帳路線：**\n${transactions.map((t, idx) => `${idx + 1}. <@${t.from}> ➡️ <@${t.to}>：**${t.amount} ${targetCurrency}**`).join('\n')}`
            : '🎉 讚啦！換算後所有人帳目皆完全兩清，無須進行任何轉帳！') +
          (failedCurrencies.length ? `\n\n⚠️ 以下幣別即時匯率抓取失敗，已從換算結果中忽略：${failedCurrencies.join('、')}` : '')
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_btn_transfer_live').setLabel('🔄 重新選擇幣別').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('set_btn_transfer').setLabel('⬅️ 返回').setStyle(ButtonStyle.Secondary)
      );

      return interaction.editReply({ embeds: [embed], components: [row] });
    }
  }
};
