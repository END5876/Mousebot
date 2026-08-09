'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags
} = require('discord.js');
const { equalSplit, round2, parseMoneyInput } = require('../utils/calculator');
const { parsePayerField, parseSplitField } = require('../utils/parse');
const { simplifyDebts } = require('../utils/settlement');

// ────────────────────────────────────────────────────────────────
// ⚡ 快速分帳：給「臨時只有一筆帳單要分」的情境使用，不需要事先建立行程、
// 不需要管理成員名單，也完全不會寫入任何行程的持久化資料 —— 純粹就是
// 「金額怎麼分」的免安裝計算機，算完即丟。
//
// 跟 /splitbill-quick 的差異：/splitbill-quick 是給熟手的免面板指令，
// 但仍然要求「已經有一個行程」（分攤對象取自行程成員名單）；這裡則是
// 主控面板上給所有人（含還沒建立任何行程的新手）使用的一次性小工具。
//
// 因為快速分帳沒有「行程成員名單」可以當作 equal 平分的預設對象，
// 分攤方式一律要求使用者用 @提及 明確指定對象，語法沿用
// utils/parse.js 既有的 parsePayerField / parseSplitField，
// 跟 /splitbill-quick 完全相同，兩者共用同一套經過驗證的解析邏輯：
//   - 代墊人（可留空＝預設你自己）：
//       單人： @提及一位成員
//       多人：<@id1>=600,<@id2>=400（支援多人共同付款、金額不等額）
//   - 分攤方式（必填）：
//       平分：  equal:<@id1>,<@id2>
//       自訂金額（非對稱分攤）：<@id1>=300,<@id2>=700
// ────────────────────────────────────────────────────────────────

module.exports = {
  async handleButton(interaction) {
    const { customId } = interaction;

    if (customId === 'qs_start') {
      const modal = new ModalBuilder().setCustomId('qs_modal_bill').setTitle('⚡ 快速分帳');

      const itemInput = new TextInputBuilder()
        .setCustomId('item')
        .setLabel('項目名稱')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('例如：計程車、晚餐')
        .setRequired(true);

      const amountInput = new TextInputBuilder()
        .setCustomId('amount')
        .setLabel('總金額')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('例如：1200')
        .setRequired(true);

      const currencyInput = new TextInputBuilder()
        .setCustomId('currency')
        .setLabel('幣別代碼（可留空，預設 TWD）')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('例如：JPY、USD')
        .setRequired(false);

      const payerInput = new TextInputBuilder()
        .setCustomId('payer')
        .setLabel('代墊人（可留空＝你自己；多人代墊見下）')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('多人共同付款：<@id1>=600,<@id2>=400')
        .setRequired(false);

      const splitInput = new TextInputBuilder()
        .setCustomId('split')
        .setLabel('分攤方式（必填，@提及分攤對象）')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('平分：equal:<@id1>,<@id2>\n非對稱自訂金額：<@id1>=300,<@id2>=700')
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(itemInput),
        new ActionRowBuilder().addComponents(amountInput),
        new ActionRowBuilder().addComponents(currencyInput),
        new ActionRowBuilder().addComponents(payerInput),
        new ActionRowBuilder().addComponents(splitInput)
      );

      return interaction.showModal(modal);
    }
  },

  async handleModal(interaction) {
    if (interaction.customId !== 'qs_modal_bill') return;

    const { user } = interaction;
    const item = interaction.fields.getTextInputValue('item').trim();
    const amount = round2(parseMoneyInput(interaction.fields.getTextInputValue('amount')));
    const currency = (interaction.fields.getTextInputValue('currency') || 'TWD').trim().toUpperCase() || 'TWD';
    const payerText = interaction.fields.getTextInputValue('payer').trim();
    const splitText = interaction.fields.getTextInputValue('split').trim();

    if (!(amount > 0)) {
      return interaction.reply({ content: '⚠️ 金額必須是大於 0 的數字。', flags: MessageFlags.Ephemeral });
    }

    try {
      // 1. 代墊人：留空預設為發起這次快速分帳的人；
      //    多人共同付款（金額可不等額）請用 <@id1>=600,<@id2>=400
      let payers;
      if (payerText) {
        payers = parsePayerField(payerText, amount);
        const payerSum = round2(payers.reduce((s, p) => s + p.amount, 0));
        if (Math.abs(payerSum - amount) > 0.01) {
          throw new Error(`代墊人金額加總 (${payerSum}) 與總金額 (${amount}) 不相符，差額 ${round2(Math.abs(payerSum - amount))}`);
        }
      } else {
        payers = [{ userId: user.id, amount }];
      }

      // 2. 分攤方式：快速分帳沒有「行程成員名單」可以當作 equal 的預設對象，
      //    因此不接受空白的 "equal"，一定要明確 @提及分攤對象。
      if (/^equal$/i.test(splitText)) {
        throw new Error('快速分帳沒有行程成員名單可用於「全體平分」，請改用 `equal:<@id1>,<@id2>` 指定分攤對象，或用 `<@id1>=300,<@id2>=700` 自訂非對稱金額。');
      }
      const splitInfo = parseSplitField(splitText, []);

      let shares;
      if (splitInfo.mode === 'equal') {
        shares = equalSplit(amount, splitInfo.ids);
      } else {
        const shareSum = round2(splitInfo.customShares.reduce((s, p) => s + p.amount, 0));
        if (Math.abs(shareSum - amount) > 0.01) {
          throw new Error(`分攤金額加總 (${shareSum}) 與總金額 (${amount}) 不相符，差額 ${round2(Math.abs(shareSum - amount))}`);
        }
        shares = splitInfo.customShares.map(p => ({ userId: p.userId, share: p.amount }));
      }

      // 3. 用「淨額 = 代墊金額 − 分攤金額」餵給既有的 simplifyDebts()，
      //    自動算出最少筆數的建議轉帳（天然支援多人代墊 + 非對稱分攤互相抵銷的情況）
      const net = {};
      for (const p of payers) net[p.userId] = round2((net[p.userId] || 0) + p.amount);
      for (const s of shares) net[s.userId] = round2((net[s.userId] || 0) - s.share);
      const transfers = simplifyDebts(net);

      const payerLines = payers.map(p => `　• <@${p.userId}>：代墊 ${round2(p.amount)} ${currency}`).join('\n');
      const shareLines = shares.map(s => `　• <@${s.userId}>：應分攤 ${round2(s.share)} ${currency}`).join('\n');
      const transferText = transfers.length
        ? transfers.map(t => `　➜ <@${t.from}> 轉給 <@${t.to}>：**${t.amount} ${currency}**`).join('\n')
        : '🎉 剛好互相抵銷，無需任何轉帳！';

      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('⚡ 快速分帳結果')
        .setDescription(`**${item}** — 總金額 ${amount} ${currency}`)
        .addFields(
          { name: '💰 代墊', value: payerLines },
          { name: '🎯 分攤', value: shareLines },
          { name: '💸 建議轉帳', value: transferText }
        )
        .setFooter({ text: '此為臨時計算結果，不會被儲存，也不會建立任何行程。' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('qs_start').setLabel('⚡ 再算一筆').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('nav_main').setLabel('🏠 返回主控台').setStyle(ButtonStyle.Secondary)
      );

      const payload = { content: '', embeds: [embed], components: [row] };

      // 這個 Modal 是從主控面板的按鈕點出來的，優先用 update() 直接改寫原本那則面板訊息；
      // 若因故無法 update，才退回 reply() 保底。
      if (interaction.isFromMessage && interaction.isFromMessage()) {
        return interaction.update(payload);
      }
      return interaction.reply(payload);
    } catch (err) {
      return interaction.reply({ content: `❌ 快速分帳計算失敗：${err.message}`, flags: MessageFlags.Ephemeral });
    }
  }
};
