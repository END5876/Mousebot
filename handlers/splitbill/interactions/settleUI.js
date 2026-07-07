'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { resolveTrip, memberDisplay } = require('../utils/tripHelper');
const { calcNetBalances, round2 } = require('../utils/calculator');
const { simplifyDebts } = require('../utils/settlement');
const { showMainMenu } = require('../commands/splitbill');

module.exports = {
  async handleButton(interaction) {
    const { customId, guildId } = interaction;
    const { trip } = resolveTrip(guildId);
    if (customId === 'nav_main') {
        return showMainMenu(interaction);
    }

    if (customId === 'set_nav') {
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('📊 結算與淨額中心')
        .setDescription(`當前行程：**${trip.name}**\\n請選擇結算檢視工具：`);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_btn_balance').setLabel('🟢 查看每人淨額').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('set_btn_simplify').setLabel('🚀 最佳化轉帳清單').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('nav_main').setLabel('⬅️ 返回主選單').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    // 1. 每人收支淨額分佈
    if (customId === 'set_btn_balance') {
      const net = calcNetBalances(trip);
      const lines = trip.members.map(m => {
        const val = round2(net[m.id] || 0);
        if (val > 0.01) return `🟢 <@${m.id}>：應**收回** \`${val} ${trip.baseCurrency}\` (多墊)`;
        if (val < -0.01) return `🔴 <@${m.id}>：應**付出** \`${Math.abs(val)} ${trip.baseCurrency}\` (透支)`;
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

    // 2. 貪心演算法簡化債務
    if (customId === 'set_btn_simplify') {
      const net = calcNetBalances(trip);
      const transactions = simplifyDebts(net);

      const embed = new EmbedBuilder().setColor(0x2ecc71).setTitle(`🚀 「${trip.name}」最佳化轉帳懶人包`);

      if (!transactions.length) {
        embed.setDescription('🎉 讚啦！當前所有人帳目皆完全兩清，無須進行任何轉帳！');
      } else {
        const lines = transactions.map((t, idx) => 
          `**${idx + 1}.** <@${t.from}> ➡️ <@${t.to}>：**${t.amount} ${trip.baseCurrency}**`
        ).join('\n');
        embed.setDescription(`透過交叉債務自動抵銷演算法，最精簡的轉帳路線如下：\n\n${lines}`);
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_nav').setLabel('⬅️ 返回結算選單').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [row] });
    }
  }
};