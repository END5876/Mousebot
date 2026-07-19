'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { resolveTrip } = require('../utils/tripHelper');
const { calcNetBalances, calcNetBalancesByCurrency, getUsedCurrencies, convertNetToSingleCurrency, round2 } = require('../utils/calculator');
const { simplifyDebts } = require('../utils/settlement');
const { showMainMenu } = require('../commands/splitbill');

/**
 * 🆕 新版「每人淨額」文字設計（動作語氣版）
 *
 * 設計原則：
 * 1. 標題行不再用「淨額 +20689.12 TWD（應收回）」這種先報數字再解釋的寫法，
 *    改成「應收回 20689.12 TWD」/「要補交 15230 TWD」，直接用動作語氣告訴使用者該做什麼。
 * 2. 明細標籤沿用「幫大家代墊 / 自己還少給」，用更直白的生活化語感描述這個人在該幣別下的角色：
 *    - 幫大家代墊：在該幣別下，這個人付出的錢比自己該負擔的多 → 該幣別對他是「正貢獻」，別人該還他
 *    - 自己還少給：在該幣別下，這個人付出的錢比自己該負擔的少 → 該幣別對他是「負貢獻」，他該補給別人
 * 3. 只有當一個人「同時牽涉兩種以上幣別」時才顯示明細；
 *    若只用單一幣別，明細＝淨額本身，顯示等於廢話，直接省略，讓畫面更乾淨。
 * 4. 淨額為 0 時，用「帳目兩清（無需收付）」明確告訴使用者「不用做什麼」。
 * 5. 樹狀符號改用 ├ / └（雙空格縮排），視覺上更貼近常見的檔案樹結構。
 *
 * 呈現效果範例：
 *   🟢 <@userA> 應收回 20689.12 TWD
 *   　├  幫大家代墊：76344 JPY、6604.66 TWD
 *   　└  自己還少給：34 USD
 *
 *   🔴 <@userB> 要補交 15230 TWD
 *
 *   ⚪ <@userC> 帳目兩清（無需收付）
 */
function formatBreakdownBlock(breakdownEntries) {
  const entries = (breakdownEntries || []).filter(b => Math.abs(b.amount) >= 0.01);

  // 只有單一幣別時，明細等同於淨額本身，不需要重複顯示
  if (entries.length <= 1) return null;

  const positives = entries.filter(b => b.amount > 0).sort((a, b) => b.amount - a.amount);
  const negatives = entries.filter(b => b.amount < 0).sort((a, b) => a.amount - b.amount);

  const lines = [];

  if (positives.length) {
    const text = positives.map(b => `${round2(b.amount)} ${b.currency}`).join('、');
    lines.push(`幫大家代墊：${text}`);
  }

  if (negatives.length) {
    const text = negatives.map(b => `${round2(Math.abs(b.amount))} ${b.currency}`).join('、');
    lines.push(`自己還少給：${text}`);
  }

  // 用 ├ / └ 畫出樹狀結構（雙空格縮排），最後一行收尾用 └
  return lines.map((line, idx) => `　${idx === lines.length - 1 ? '└ ' : '├ '} ${line}`).join('\n');
}

module.exports = {
  async handleButton(interaction, cache) {
    const { customId, guildId } = interaction;
    const { trip } = resolveTrip(guildId);
    if (customId === 'nav_main') {
      return showMainMenu(interaction);
    }

    // 主選單：事實層（淨額）、清單層（帳目）與行動層（轉帳建議）
    // 🆕 新增「查看帳目清單」按鈕，沿用 expenseUI.js 已有的 exp_btn_ledger_last 邏輯，
    //    讓使用者不需要切回「記帳管理分頁」也能直接看到完整帳目清單。
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

    // 1. 每人收支淨額分佈（動作語氣版：標題直接說「該做什麼」，明細只在需要時補充）
    if (customId === 'set_btn_balance') {
      const net = calcNetBalances(trip);
      const netByCurrency = calcNetBalancesByCurrency(trip);

      const lines = trip.members.map(m => {
        const val = round2(net[m.id] || 0);
        const breakdown = Object.entries(netByCurrency[m.id] || {}).map(([currency, amount]) => ({ currency, amount }));

        // 淨額為 0：直接說明「不用做什麼」，不留模糊空間
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

    // 2a. 選擇目標幣別，用「當下即時匯率」統一換算
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