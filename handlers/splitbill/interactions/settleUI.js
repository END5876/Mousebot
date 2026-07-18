'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { resolveTrip } = require('../utils/tripHelper');
const { calcNetBalances, calcNetBalancesByCurrency, getUsedCurrencies, convertNetToSingleCurrency, round2 } = require('../utils/calculator');
const { simplifyDebts, simplifyDebtsWithBreakdown } = require('../utils/settlement');
const { showMainMenu } = require('../commands/splitbill');

/**
 * 格式化成："200 TWD (500 TWD - 15000 JPY)"
 * breakdownEntries: [{currency, amount}]，amount 為原始幣別數字（保留正負號）
 *
 * 修正說明：
 * 1. 原本用 Math.abs() 把每個成分都強制轉正、固定用 ' + ' 連接，
 *    導致方向相反的成分被誤顯示成同方向相加，明細加總對不上主要金額。
 * 2. 現在改為依數值排序（正數在前、負數在後），並依實際正負號
 *    選用 '+' 或 '-' 連接，確保第一筆一律不帶負號，且明細加總後
 *    能正確還原出主要金額。
 */
function formatWithBreakdown(baseAmount, baseCurrency, breakdownEntries) {
  const main = `${round2(Math.abs(baseAmount))} ${baseCurrency}`;

  const entries = (breakdownEntries || []).filter(b => Math.abs(b.amount) >= 0.01);
  if (!entries.length) return main;

  // 正數排前面、負數排後面，確保第一筆一定不會是負數（除非全部都是負數）
  const sorted = [...entries].sort((a, b) => b.amount - a.amount);

  let parts = '';
  sorted.forEach((b, idx) => {
    const amt = round2(Math.abs(b.amount));
    if (idx === 0) {
      // 第一筆一律不加正負號前綴
      parts += `${amt} ${b.currency}`;
    } else {
      // 後續依正負號決定用 '+' 或 '-' 連接
      parts += b.amount < 0 ? ` - ${amt} ${b.currency}` : ` + ${amt} ${b.currency}`;
    }
  });

  return `${main} (${parts})`;
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
        new ButtonBuilder().setCustomId('set_btn_simplify').setLabel('🚀 最佳化轉帳清單').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('set_btn_convert').setLabel('💱 換算成單一幣別結算').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('nav_main').setLabel('⬅️ 返回主選單').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    // 1. 每人收支淨額分佈（基準幣別金額 + 原始幣別組成）
    if (customId === 'set_btn_balance') {
      const net = calcNetBalances(trip);
      const netByCurrency = calcNetBalancesByCurrency(trip);

      const lines = trip.members.map(m => {
        const val = round2(net[m.id] || 0);
        const breakdown = Object.entries(netByCurrency[m.id] || {}).map(([currency, amount]) => ({ currency, amount }));
        const text = formatWithBreakdown(val, trip.baseCurrency, breakdown);

        if (val > 0.01) return `🟢 <@${m.id}>：應**收回** \`${text}\` (多墊)`;
        if (val < -0.01) return `🔴 <@${m.id}>：應**付出** \`${text}\` (透支)`;
        return `⚪ <@${m.id}>：已完全平穩 (淨額為 0)`;
      }).join('\n');

      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle(`🟢 「${trip.name}」成員收支淨額`)
        .setDescription(lines || '尚無成員數據。');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_nav').setLabel('⬅️ 返回結算選單').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    // 2. 貪心演算法簡化債務，並附加每筆轉帳的原始幣別組成
    if (customId === 'set_btn_simplify') {
      const net = calcNetBalances(trip);
      const netByCurrency = calcNetBalancesByCurrency(trip);
      const transactions = simplifyDebtsWithBreakdown(net, netByCurrency, trip.rates, trip.baseCurrency);

      const embed = new EmbedBuilder().setColor(0x2ecc71).setTitle(`🚀 「${trip.name}」最佳化轉帳懶人包`);

      if (!transactions.length) {
        embed.setDescription('🎉 讚啦！當前所有人帳目皆完全兩清，無須進行任何轉帳！');
      } else {
        const lines = transactions.map((t, idx) => {
          const text = formatWithBreakdown(t.amount, trip.baseCurrency, t.breakdown);
          return `**${idx + 1}.** <@${t.from}> ➡️ <@${t.to}>：**${text}**`;
        }).join('\n');
        embed.setDescription(lines);
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_nav').setLabel('⬅️ 返回結算選單').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    // 3. 選擇目標幣別，用「當下即時匯率」統一換算結算（不受記錄當下的匯率影響）
    if (customId === 'set_btn_convert') {
      const currencies = getUsedCurrencies(trip);

      if (!currencies.length) {
        return interaction.reply({ content: '📭 目前尚無任何花費或訂金紀錄，無須換算結算。', flags: MessageFlags.Ephemeral });
      }

      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle('💱 選擇最終結算的統一幣別')
        .setDescription(
          `此行程目前使用過的幣別有：**${currencies.join('、')}**\n` +
          `請選擇要換算成哪一種幣別進行最終結算（僅能選擇行程內實際出現過的幣別）：\n\n` +
          `*💡 這裡會用「當下即時匯率」重新換算，跟記帳當下存好的匯率可能不同。*`
        );

      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('set_select_convert_target')
          .setPlaceholder('選擇結算的目標幣別...')
          .addOptions(currencies.map(c => ({ label: c, value: c })))
      );

      const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_nav').setLabel('⬅️ 取消並返回').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [selectRow, navRow] });
    }
  },

  async handleSelectMenu(interaction) {
    const { customId, guildId, values } = interaction;
    const { trip } = resolveTrip(guildId);

    // 依使用者選擇的目標幣別，用當下即時匯率換算並產出最終轉帳清單
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
        .setTitle(`💱 「${trip.name}」統一換算成 ${targetCurrency} 結算`)
        .setDescription(
          (rateLines ? `**採用即時匯率：**\n${rateLines}\n\n` : '') +
          (transactions.length
            ? `**最精簡轉帳路線：**\n${transactions.map((t, idx) => `${idx + 1}. <@${t.from}> ➡️ <@${t.to}>：**${t.amount} ${targetCurrency}**`).join('\n')}`
            : '🎉 讚啦！換算後所有人帳目皆完全兩清，無須進行任何轉帳！') +
          (failedCurrencies.length ? `\n\n⚠️ 以下幣別即時匯率抓取失敗，已從換算結果中忽略：${failedCurrencies.join('、')}` : '')
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_btn_convert').setLabel('🔄 重新選擇幣別').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('set_nav').setLabel('⬅️ 返回結算選單').setStyle(ButtonStyle.Secondary)
      );

      return interaction.editReply({ embeds: [embed], components: [row] });
    }
  }
};
