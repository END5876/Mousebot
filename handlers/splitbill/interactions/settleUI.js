'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { resolveTrip } = require('../utils/tripHelper');
const { calcNetBalances, calcNetBalancesByCurrency, getUsedCurrencies, convertNetToSingleCurrency, round2 } = require('../utils/calculator');
const { simplifyDebts } = require('../utils/settlement');
const { showMainMenu } = require('../commands/splitbill');

/**
 * 新版「每人淨額」區塊格式：
 * 淨額：20689.12 TWD
 * ┣ 總花費：76344 JPY、6604.66 TWD   ← 正貢獻幣別
 * ┗ 付出：34 USD                     ← 負貢獻幣別
 *
 * 正、負貢獻分開列出，取代舊版塞在括號裡用 +/- 混合呈現的寫法。
 */
function formatBreakdownBlock(baseAmount, baseCurrency, breakdownEntries) {
  const mainLine = `${round2(Math.abs(baseAmount))} ${baseCurrency}`;

  const entries = (breakdownEntries || []).filter(b => Math.abs(b.amount) >= 0.01);
  if (!entries.length) return `　┗ 淨額：**${mainLine}**`;

  const positives = entries.filter(b => b.amount > 0).sort((a, b) => b.amount - a.amount);
  const negatives = entries.filter(b => b.amount < 0).sort((a, b) => a.amount - b.amount);

  const lines = [`　┣ 淨額：**${mainLine}**`];

  if (positives.length) {
    const spendText = positives.map(b => `${round2(b.amount)} ${b.currency}`).join('、');
    lines.push(`　┣ 總花費：${spendText}`);
  }

  if (negatives.length) {
    const payText = negatives.map(b => `${round2(Math.abs(b.amount))} ${b.currency}`).join('、');
    lines.push(`　┗ 付出：${payText}`);
  } else {
    // 把上一行的 ┣ 改成 ┗，讓樹狀結構收尾正確
    lines[lines.length - 1] = lines[lines.length - 1].replace('┣', '┗');
  }

  return lines.join('\n');
}

module.exports = {
  async handleButton(interaction, cache) {
    const { customId, guildId } = interaction;
    const { trip } = resolveTrip(guildId);
    if (customId === 'nav_main') {
      return showMainMenu(interaction);
    }

    // 主選單：事實層（淨額）與行動層（轉帳建議）
    if (customId === 'set_nav') {
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('📊 結算與淨額中心')
        .setDescription(`當前行程：**${trip.name}**\n請選擇結算檢視工具：`);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_btn_balance').setLabel('🟢 查看每人淨額').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('set_btn_transfer').setLabel('🚀 建議轉帳清單').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('nav_main').setLabel('⬅️ 返回主選單').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    // 1. 每人收支淨額分佈（新版：分類分行呈現總花費 / 付出）
    if (customId === 'set_btn_balance') {
      const net = calcNetBalances(trip);
      const netByCurrency = calcNetBalancesByCurrency(trip);

      const lines = trip.members.map(m => {
        const val = round2(net[m.id] || 0);
        const breakdown = Object.entries(netByCurrency[m.id] || {}).map(([currency, amount]) => ({ currency, amount }));

        let statusLabel;
        if (val > 0.01) statusLabel = `🟢 <@${m.id}>：應**收回** (多墊)`;
        else if (val < -0.01) statusLabel = `🔴 <@${m.id}>：應**付出** (透支)`;
        else return `⚪ <@${m.id}>：已完全平穩 (淨額為 0)`;

        const block = formatBreakdownBlock(val, trip.baseCurrency, breakdown);
        return `${statusLabel}\n${block}`;
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

    // 2. 建議轉帳清單 —— 直接顯示基準幣（記帳當時匯率）計算結果
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

    // 2a. 選擇目標幣別，用「當下即時匯率」統一換算（原「換算成單一幣別結算」邏輯）
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