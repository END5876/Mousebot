'use strict';

// handlers/splitbill/interactions/expense/ledger.js
// 職責：帳目清單分頁渲染（含刪除用的下拉選單、上一頁/下一頁導覽）

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { memberDisplay } = require('../../utils/tripHelper');
const { round2 } = require('../../utils/calculator');
const { getBackNavConfig, formatAmountConversion, formatParticipantsList } = require('./helpers');

const LEDGER_PAGE_SIZE = 8;

function renderLedgerPage(interaction, trip, page, alertMsg = null, source = 'exp') {
  const allRecords = [
    ...trip.expenses.map(e => ({ ...e, type: 'expense' })),
    ...(trip.deposits || []).map(d => ({ ...d, type: 'deposit' }))
  ].sort((a, b) => a.createdAt - b.createdAt);

  const content = typeof alertMsg === 'string' ? alertMsg : '';
  const backNav = getBackNavConfig(source);

  if (!allRecords.length) {
    const embed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle(`📒 「${trip.name}」總帳目清單`)
      .setDescription('📭 目前尚無任何花費或訂金紀錄。');

    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(backNav.customId).setLabel(backNav.label).setStyle(ButtonStyle.Secondary)
    );
    return interaction.update({ content, embeds: [embed], components: [navRow] });
  }

  const totalPages = Math.max(1, Math.ceil(allRecords.length / LEDGER_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * LEDGER_PAGE_SIZE;
  const pageRecords = allRecords.slice(start, start + LEDGER_PAGE_SIZE);

  const lines = pageRecords.map((r, idx) => {
    const globalIdx = start + idx + 1;
    const dateStr = new Date(r.createdAt).toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    const amountText = formatAmountConversion(r.amount, r.currency, r.amountInBase, trip.baseCurrency);

    if (r.type === 'expense') {
      const payers = r.payers.map(p => memberDisplay(trip, p.userId)).join('、');
      const participantsText = formatParticipantsList(trip, r.participants, r.currency);
      return `**#${globalIdx}** \`[花費]\` **${r.description}**\n${amountText}\n> 🕒 ${dateStr}・由 ${payers} 代墊\n> 💸 分攤：${participantsText}`;
    } else {
      const payer = memberDisplay(trip, r.payerId);
      const collector = memberDisplay(trip, r.collectorId);
      const noteText = r.note ? `\n> 📝 備註：${r.note}` : '';
      return `**#${globalIdx}** \`[訂金]\` **${payer} → ${collector}**\n${amountText}\n> 🕒 ${dateStr}${noteText}`;
    }
  }).join('\n\n');

  const totalsByCurrency = {};
  let totalExpenseBase = 0;
  for (const e of trip.expenses) {
    totalsByCurrency[e.currency] = (totalsByCurrency[e.currency] || 0) + e.amount;
    totalExpenseBase += e.amountInBase || 0;
  }
  const breakdownText = Object.entries(totalsByCurrency)
    .map(([currency, amount]) => `${round2(amount)} ${currency}`)
    .join(' + ');
  const totalDepositBase = (trip.deposits || []).reduce((sum, d) => sum + (d.amountInBase || 0), 0);

  const embed = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setTitle(`📒 「${trip.name}」總帳目清單`)
    .setDescription(lines)
    .addFields(
      {
        name: '📊 總覽',
        value:
          `🧾 花費筆數：\`${trip.expenses.length} 筆\`\n` +
          `💰 轉帳筆數：\`${(trip.deposits || []).length} 筆\`\n` +
          `💵 花費總額：**${round2(totalExpenseBase)} ${trip.baseCurrency}**${breakdownText ? `（${breakdownText}）` : ''}\n` +
          `🏦 訂金總額：**${round2(totalDepositBase)} ${trip.baseCurrency}**`
      }
    )
    .setFooter({ text: `第 ${safePage + 1} / ${totalPages} 頁・共 ${allRecords.length} 筆紀錄\n💡 可用下方選單直接刪除本頁任一筆（刪除前會再次確認）` });

  const deleteRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`exp_select_delete_${safePage}__${source}`)
      .setPlaceholder('🗑️ 選擇本頁一筆帳目將其刪除...')
      .addOptions(pageRecords.map(r => ({
        label: r.type === 'expense'
          ? `[花費] ${r.description} (${r.amount} ${r.currency})`.slice(0, 100)
          : `[訂金] ${memberDisplay(trip, r.payerId)} 給 ${memberDisplay(trip, r.collectorId)} (${r.amount} ${r.currency})`.slice(0, 100),
        value: `${r.type}_${r.id}`
      })))
  );

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`exp_btn_ledger_${safePage - 1}__${source}`).setLabel('⬅️ 上一頁').setStyle(ButtonStyle.Primary).setDisabled(safePage <= 0),
    new ButtonBuilder().setCustomId(`exp_btn_ledger_${safePage + 1}__${source}`).setLabel('➡️ 下一頁').setStyle(ButtonStyle.Primary).setDisabled(safePage >= totalPages - 1),
    new ButtonBuilder().setCustomId(backNav.customId).setLabel(backNav.label).setStyle(ButtonStyle.Secondary)
  );

  return interaction.update({ content, embeds: [embed], components: [deleteRow, navRow] });
}

module.exports = { renderLedgerPage, LEDGER_PAGE_SIZE };
