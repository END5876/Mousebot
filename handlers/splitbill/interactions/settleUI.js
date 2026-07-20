'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { resolveTrip } = require('../utils/tripHelper');
const { calcNetBalances, calcNetBalancesByCurrency, listTransfersByMember, getUsedCurrencies, convertNetToSingleCurrency, round2 } = require('../utils/calculator');
const { simplifyDebts } = require('../utils/settlement');
const { showMainMenu } = require('../commands/splitbill');

/**
 * 🆕【收支帳模式 v3】每人淨額明細呈現
 *
 * 設計原則：
 * 1. 每一行都用 ➕/➖ 明確標示「這筆讓淨額增加還是減少」，使用者可以
 *    自行驗算：淨額 = 所有➕ − 所有➖（換算成基準幣後）。
 * 2. 外幣金額一律附上換算成基準幣別後的等值（約 xx TWD），使用者不用
 *    自己查匯率，就能對照標題的數字是怎麼算出來的。
 * 3. 轉帳不再彙總成一個數字——彙總會讓「轉給了誰」這個關鍵資訊消失，
 *    交叉轉帳甚至可能互相抵銷、被誤讀成沒事發生。改成逐筆列出對象，
 *    見 formatTransferLines。
 * 4. 🆕 同一分類若同時有多個幣別（例如同時墊了 JPY／TWD／USD），不再用
 *    「、」串成一整行導致爆版，改成該分類展開成子項目，一個幣別一行。
 *
 * bucketsByCurrency 格式：{ [currency]: { paid, paidBase, share, shareBase, ... } }
 */
function formatExpenseSections(bucketsByCurrency, trip) {
  const categories = [
    { field: 'paid',  prefix: '➕', label: '幫大家先墊的錢' },
    { field: 'share', prefix: '➖', label: '自己該分攤的花費' },
  ];

  const sections = [];
  for (const { field, prefix, label } of categories) {
    const items = Object.entries(bucketsByCurrency || {})
      .filter(([, b]) => Math.abs(b[field] || 0) >= 0.01)
      .sort(([, a], [, b]) => (b[field] || 0) - (a[field] || 0))
      .map(([currency, b]) => {
        const amountText = `${round2(b[field])} ${currency}`;
        if (currency === trip.baseCurrency) return amountText;
        return `${amountText}（約 ${round2(b[`${field}Base`])} ${trip.baseCurrency}）`;
      });
    if (items.length) sections.push({ title: `${prefix} ${label}`, items });
  }
  return sections;
}

/**
 * 🆕 逐筆列出轉帳對象，取代舊版「轉帳給他人／收到他人轉帳」的彙總數字。
 */
function formatTransferLines(transfers, trip) {
  if (!transfers || !transfers.length) return [];
  return transfers.map(t => {
    const arrow = t.direction === 'out' ? '➕ 轉給' : '➖ 收到';
    const amountText = `${round2(t.amount)} ${t.currency}`;
    const baseText = t.currency === trip.baseCurrency ? '' : `（約 ${round2(t.amountInBase)} ${trip.baseCurrency}）`;
    // 🆕 備註改成獨立一行並縮排，而不是接在同一行尾端——手機寬度不夠時，
    // 原本接在句尾的備註很容易把整行撐到很晚才換行，閱讀起來斷得很突兀。
    const noteText = t.note ? `\n　　📝 ${t.note}` : '';
    return `${arrow} <@${t.counterpartId}>：${amountText}${baseText}${noteText}`;
  });
}

/**
 * 🆕 把「分類區塊（sections，可能含多幣別子項）」與「轉帳明細（flatLines，單行字串）」
 * 混合組成樹狀結構（├/└）。
 *
 * - 分類若只有 1 個幣別 → 顯示成單行「標題：金額」
 * - 分類若有多個幣別 → 標題獨立一行，各幣別展開成子項目（避免單行過長）
 * - 只有 0～1 行且該行沒有子項目時，視為資訊量等同標題本身，省略以保持畫面乾淨
 */
function toTreeBlock(sections, flatLines) {
  const nodes = [
    ...sections.map(s => ({
      text: s.items.length === 1 ? `${s.title}：${s.items[0]}` : s.title,
      children: s.items.length > 1 ? s.items : null,
    })),
    ...flatLines.map(text => ({ text, children: null })),
  ];

  if (nodes.length === 0) return null;
  if (nodes.length === 1 && !nodes[0].children) return null;

  return nodes.map((node, idx) => {
    const isLast = idx === nodes.length - 1;
    const branch = isLast ? '└' : '├';
    let out = `　${branch} ${node.text}`;

    if (node.children) {
      const childIndent = isLast ? '　　' : '　│';
      out += '\n' + node.children.map((c, cidx) => {
        const cIsLast = cidx === node.children.length - 1;
        const cBranch = cIsLast ? '└' : '├';
        return `${childIndent}  ${cBranch} ${c}`;
      }).join('\n');
    }

    return out;
  }).join('\n');
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

    // 1. 每人收支淨額分佈（收支帳模式 v3：分組排序 + 附換算金額 + 多幣別自動換行 + 轉帳逐筆列出對象）
    if (customId === 'set_btn_balance') {
      const net = calcNetBalances(trip);
      const netByCurrency = calcNetBalancesByCurrency(trip);
      const transfersByMember = listTransfersByMember(trip);

      const owing = [];
      const receiving = [];
      const settled = [];

      for (const m of (trip.members || [])) {
        const val = round2(net[m.id] || 0);
        if (Math.abs(val) < 0.01) settled.push(m);
        else if (val > 0) receiving.push({ m, val });
        else owing.push({ m, val });
      }

      // 依欠款/可收金額大小排序，最需要處理的人排最前面
      receiving.sort((a, b) => b.val - a.val);
      owing.sort((a, b) => a.val - b.val);

      const renderMember = ({ m, val }) => {
        const statusIcon = val > 0 ? '🟢' : '🔴';
        const actionText = val > 0 ? '需收回' : '需付款';
        const titleLine = `**${statusIcon} <@${m.id}> ${actionText} ${round2(Math.abs(val))} ${trip.baseCurrency}**`;

        const sections = formatExpenseSections(netByCurrency[m.id], trip);
        const transferLines = formatTransferLines(transfersByMember[m.id], trip);
        const block = toTreeBlock(sections, transferLines);
        return block ? `${titleLine}\n${block}` : titleLine;
      };

      const sections = [];
      if (owing.length) {
        sections.push(`**🔴 需要付款**\n\n${owing.map(renderMember).join('\n\n')}`);
      }
      if (receiving.length) {
        sections.push(`**🟢 需要收款**\n\n${receiving.map(renderMember).join('\n\n')}`);
      }
      if (settled.length) {
        sections.push(`**⚪ 已結清**\n${settled.map(m => `<@${m.id}>`).join('、')} 帳目兩清，無需收付`);
      }

      const tip = '\n\n💡 以上金額已依記帳當下匯率換算成 TWD，方便對帳。想知道誰該轉給誰？可以到「建議轉帳清單」查看最省事的匯款方案。';
      const description = sections.length
        ? sections.join('\n\n━━━━━━━━━━━━━━\n\n') + tip
        : '尚無成員數據。';

      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle(`🟢 「${trip.name}」成員收支淨額`)
        .setDescription(description);

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