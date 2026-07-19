'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { resolveTrip } = require('../utils/tripHelper');
const { calcNetBalances, calcNetBalancesByCurrency, getUsedCurrencies, convertNetToSingleCurrency, round2 } = require('../utils/calculator');
const { simplifyDebts } = require('../utils/settlement');
const { showMainMenu } = require('../commands/splitbill');

/**
 * 🆕【收支帳模式】每人淨額明細呈現
 *
 * 設計原則：
 * 每一行都用 ➕/➖ 明確標示「這筆讓淨額增加還是減少」，使用者可以
 * 自行驗算：淨額 = 所有➕ − 所有➖（換算成基準幣後）。
 * 徹底解決舊版「標題說應收回、明細卻說還少給」的語意矛盾問題。
 *
 * 分類（固定順序顯示）：
 *   ➕ 代墊花費      (paid)
 *   ➕ 轉帳給他人    (transferOut)
 *   ➖ 應分攤花費    (share)
 *   ➖ 收到他人轉帳  (transferIn)
 *
 * bucketsByCurrency 格式：{ [currency]: { paid, share, transferOut, transferIn } }
 */
function formatBreakdownBlock(bucketsByCurrency) {
  const categories = [
    { field: 'paid',        prefix: '➕', label: '代墊花費' },
    { field: 'transferOut', prefix: '➕', label: '轉帳給他人' },
    { field: 'share',       prefix: '➖', label: '應分攤花費' },
    { field: 'transferIn',  prefix: '➖', label: '收到他人轉帳' },
  ];

  const lines = [];
  for (const { field, prefix, label } of categories) {
    const parts = Object.entries(bucketsByCurrency || {})
      .filter(([, b]) => Math.abs(b[field] || 0) >= 0.01)
      .sort(([, a], [, b]) => (b[field] || 0) - (a[field] || 0))
      .map(([currency, b]) => `${round2(b[field])} ${currency}`);
    if (parts.length) lines.push(`${prefix} ${label}：${parts.join('、')}`);
  }

  // 明細只有 0～1 行時，資訊量等同標題本身，省略以保持畫面乾淨
  if (lines.length <= 1) return null;

  // 樹狀符號：非最後一行用 ├，最後一行用 └（雙空格縮排）
  return lines
    .map((line, idx) => `　${idx === lines.length - 1 ? '└' : '├'} ${line}`)
    .join('\n');
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

    // 1. 每人收支淨額分佈（收支帳模式）
    if (customId === 'set_btn_balance') {
      const net = calcNetBalances(trip);
      const netByCurrency = calcNetBalancesByCurrency(trip);

      const lines = trip.members.map(m => {
        const val = round2(net[m.id] || 0);

        if (Math.abs(val) < 0.01) {
          return `⚪ <@${m.id}> 帳目兩清（無需收付）`;
        }

        const statusIcon = val > 0 ? '🟢' : '🔴';
        const actionText = val > 0 ? '應收回' : '要付出';
        const titleLine = `${statusIcon} <@${m.id}> ${actionText} ${round2(Math.abs(val))} ${trip.baseCurrency}`;

        const block = formatBreakdownBlock(netByCurrency[m.id]);
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
