'use strict';

const { 
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, 
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags 
} = require('discord.js');
const storage = require('../utils/storage');
const { resolveTrip } = require('../utils/tripHelper');
const { showMainMenu } = require('../commands/splitbill');

const BASELINE_RATES = {
  TWD: 1, JPY: 0.2, USD: 32, KRW: 0.024, EUR: 34.8, THB: 0.89, HKD: 4.1, GBP: 40.5
};

module.exports = {
  async handleButton(interaction) {
    const { customId, guildId } = interaction;
    const guild = storage.getGuild(guildId);
    
    if (customId === 'nav_main') return showMainMenu(interaction);

    if (customId === 'trip_nav') {
      const { trip } = resolveTrip(guildId);
      const activeName = trip ? `**${trip.name}**` : '無';
      const trips = Object.values(guild.trips).filter(t => !t.archived);

      const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('🧳 行程與外幣設定')
        .setDescription(`目前作用行程：${activeName}\n\n請直接由下方選單切換行程，或使用按鈕建立/刪除行程。`);

      const btnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('trip_btn_create_modal').setLabel('🆕 建立新行程').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('trip_btn_delete_ui').setLabel('❌ 刪除此行程').setStyle(ButtonStyle.Danger).setDisabled(!trip),
        new ButtonBuilder().setCustomId('nav_main').setLabel('🏠 返回主控台').setStyle(ButtonStyle.Secondary)
      );

      const components = [btnRow];

      if (trips.length > 0) {
        const selectRow = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('trip_select_switch')
            .setPlaceholder('🔄 快速切換其他行程...')
            .addOptions(trips.map(t => ({ label: t.name, value: t.id, description: `基準幣別: ${t.baseCurrency}` })))
        );
        components.push(selectRow);
      }

      return interaction.update({ embeds: [embed], components });
    }

    if (customId === 'trip_btn_create_modal') {
      const modal = new ModalBuilder().setCustomId('trip_modal_create').setTitle('建立全新行程');
      const nameInput = new TextInputBuilder().setCustomId('name').setLabel('行程名稱 (例: 2026東京跨年、澎湖行)').setStyle(TextInputStyle.Short).setRequired(true);
      const curInput = new TextInputBuilder().setCustomId('baseCur').setLabel('基準本位幣別 (預設 TWD)').setStyle(TextInputStyle.Short).setValue('TWD').setRequired(false);

      modal.addComponents(new ActionRowBuilder().addComponents(nameInput), new ActionRowBuilder().addComponents(curInput));
      return interaction.showModal(modal);
    }

    if (customId === 'trip_btn_delete_ui') {
      const { trip } = resolveTrip(guildId);
      const embed = new EmbedBuilder()
        .setColor(0xd35400)
        .setTitle(`⚠️ 警告：確定要刪除行程「${trip.name}」？`)
        .setDescription('此操作將會清除所有歷史記帳與成員關聯，**無法復原**。確認刪除？');

      const btns = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('trip_btn_delete_confirm').setLabel('💥 確定全面刪除').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('trip_nav').setLabel('🛡️ 取消安全返回').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [btns] });
    }

    if (customId === 'trip_btn_delete_confirm') {
      const { trip } = resolveTrip(guildId);
      if (guild.activeTripId === trip.id) guild.activeTripId = null;
      delete guild.trips[trip.id];
      storage.persist();

      return showMainMenu(interaction, `✅ 已徹底銷毀行程 \`${trip.name}\` 及其所有檔案。`);
    }
  },

  async handleModal(interaction) {
    if (interaction.customId === 'trip_modal_create') {
      const guildId = interaction.guildId;
      const guild = storage.getGuild(guildId);

      const name = interaction.fields.getTextInputValue('name').trim();
      const baseCur = (interaction.fields.getTextInputValue('baseCur') || 'TWD').toUpperCase();

      const baseRate = BASELINE_RATES[baseCur] ?? 1;
      const autoRates = { [baseCur]: 1 };
      for (const [cur, rateToTWD] of Object.entries(BASELINE_RATES)) {
        if (cur !== baseCur) {
          autoRates[cur] = parseFloat((rateToTWD / baseRate).toFixed(4));
        }
      }

      const newTripId = `trip_${Date.now().toString(36)}`;
      const newTrip = {
        id: newTripId, name, baseCurrency: baseCur, rates: autoRates,
        members: [{ id: interaction.user.id, name: interaction.user.globalName || interaction.user.username }],
        expenses: [], archived: false, createdAt: Date.now()
      };

      guild.trips[newTripId] = newTrip;
      guild.activeTripId = newTripId;
      storage.persist();

      return showMainMenu(interaction, `🎉 成功創立新行程！\n**名稱**：${name}\n**本位幣別**：${baseCur}\n已自動帶入常用多國匯率，並切換為當前作用行程！`);
    }
  },

  async handleSelectMenu(interaction) {
    if (interaction.customId === 'trip_select_switch') {
      const guildId = interaction.guildId;
      const guild = storage.getGuild(guildId);
      const selectedTripId = interaction.values[0];

      if (!guild.trips[selectedTripId]) return interaction.reply({ content: '⚠️ 選擇的行程不存在。', flags: MessageFlags.Ephemeral });

      guild.activeTripId = selectedTripId;
      storage.persist();

      return showMainMenu(interaction, `🔄 已成功切換目前主作用行程至：**${guild.trips[selectedTripId].name}**`);
    }
  }
};
