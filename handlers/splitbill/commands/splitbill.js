'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { resolveTrip } = require('../utils/tripHelper');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('splitbill')
    .setDescription('召喚 Splitbill 分帳主控台面板'),

  async execute(interaction) {
    await this.showMainMenu(interaction);
  },

  /**
   * 渲染或更新主選單畫面
   * @param {object} interaction - Discord 互動對象
   * @param {string|null} alertMsg - 操作成功後的提示文字（顯示在訊息 content）
   */
  async showMainMenu(interaction, alertMsg = null) {
    const guildId = interaction.guildId;
    const { trip } = resolveTrip(guildId); // 抓取目前伺服器啟用中的行程

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🧮 Splitbill 分帳主控面板')
      .setDescription('歡迎使用分帳系統！您可以完全透過下方按鈕與選單搞定所有行程與記帳。')
      .setTimestamp();

    if (trip) {
      const totalInBase = trip.expenses.reduce((sum, e) => sum + (e.amountInBase || 0), 0);
      embed.addFields(
        { name: '🧳 當前作用行程', value: `**${trip.name}**`, inline: true },
        { name: '🪙 基準幣別', value: `\`${trip.baseCurrency}\``, inline: true },
        { name: '👥 行程人數', value: `\`${trip.members.length} 人\``, inline: true },
        { name: '🧾 累計帳目', value: `\`${trip.expenses.length} 筆\``, inline: true },
        { name: '💰 總花費金額', value: `**${totalInBase.toFixed(2)} ${trip.baseCurrency}**`, inline: false }
      );
    } else {
      embed.addFields({
        name: '⚠️ 提示',
        value: '目前此伺服器尚未設定或選擇任何行程。請點選下方 **「🧳 行程設定」** 開始建立第一個行程！'
      });
    }

    // 建立人性化主要導覽按鈕
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('exp_nav').setLabel('💸 記帳管理').setStyle(ButtonStyle.Primary).setDisabled(!trip),
      new ButtonBuilder().setCustomId('mem_nav').setLabel('👥 成員管理').setStyle(ButtonStyle.Secondary).setDisabled(!trip),
      new ButtonBuilder().setCustomId('set_nav').setLabel('📊 結算與淨額').setStyle(ButtonStyle.Success).setDisabled(!trip || !trip.expenses.length),
      new ButtonBuilder().setCustomId('trip_nav').setLabel('🧳 行程設定').setStyle(ButtonStyle.Secondary)
    );

    const payload = { 
      embeds: [embed], 
      components: [row], 
      content: typeof alertMsg === 'string' ? alertMsg : '' 
    };

    // 智慧判斷當前 Interaction 狀態，決定更新畫面的方式
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
      await interaction.update(payload);
    } else {
      await interaction.reply(payload);
    }
  }
};
