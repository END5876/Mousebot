'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const storage = require('../utils/storage');
const { resolveTrip } = require('../utils/tripHelper');
const { showMainMenu } = require('../commands/splitbill');

module.exports = {
  async handleButton(interaction) {
    const { customId, guildId } = interaction;
    const { trip } = resolveTrip(guildId);
    
    if (customId === 'nav_main') return showMainMenu(interaction);

    if (customId === 'mem_nav') {
      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle('👥 行程成員管理')
        .setDescription(`當前行程：**${trip.name}**\n請選擇管理動作：`);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('mem_btn_add_ui').setLabel('➕ 新增成員').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('mem_btn_remove_ui').setLabel('🗑️ 移除成員').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('mem_btn_list').setLabel('📋 查看名單').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('nav_main').setLabel('⬅️ 返回主選單').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    if (customId === 'mem_btn_add_ui') {
      const embed = new EmbedBuilder().setColor(0x9b59b6).setTitle('➕ 邀請成員加入行程').setDescription('請使用下方選單選擇要拉入此行程分帳的成員：');
      const menuRow = new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('mem_select_add').setPlaceholder('選取群組成員...').setMinValues(1).setMaxValues(10));
      return interaction.update({ embeds: [embed], components: [menuRow] });
    }

    if (customId === 'mem_btn_remove_ui') {
      if (!trip.members || trip.members.length === 0) {
        return interaction.reply({ content: '⚠️ 目前行程內沒有任何成員可供移除。', flags: MessageFlags.Ephemeral });
      }

      const embed = new EmbedBuilder().setColor(0xe74c3c).setTitle('🗑️ 從行程移出成員').setDescription('請從下方選單選取欲退出的成員 (可多選)：');
      
      const memberOptions = trip.members.slice(0, 25).map(m => ({ label: m.name, value: m.id }));
      const menuRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('mem_select_remove')
          .setPlaceholder('選取退出成員 (可多選)...')
          .setMinValues(1)
          .setMaxValues(memberOptions.length) // 💡 允許一次選擇多個行程內的成員
          .addOptions(memberOptions)
      );
      
      return interaction.update({ embeds: [embed], components: [menuRow] });
    }

    if (customId === 'mem_btn_list') {
      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle(`📋 行程「${trip.name}」成員名單`)
        .setDescription(trip.members.length ? trip.members.map((m, i) => `${i + 1}. <@${m.id}> (\`${m.name}\`)`).join('\n') : ' 目前沒有成員。');

      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('mem_nav').setLabel('⬅️ 返回成員管理').setStyle(ButtonStyle.Secondary));
      return interaction.update({ embeds: [embed], components: [row] });
    }
  },

  async handleSelectMenu(interaction) {
    const { customId, guildId, values } = interaction;
    const { trip } = resolveTrip(guildId);

    if (customId === 'mem_select_add') {
      let addedCount = 0;
      for (const userId of values) {
        if (!trip.members.some(m => m.id === userId)) {
          const userObj = interaction.client.users.cache.get(userId);
          const userName = userObj ? (userObj.globalName || userObj.username) : `User_${userId}`;
          trip.members.push({ id: userId, name: userName });
          addedCount++;
        }
      }
      if (addedCount > 0) storage.persist();
      return showMainMenu(interaction, `✅ 成功將 ${addedCount} 位成員新增至行程「${trip.name}」！`);
    }

    if (customId === 'mem_select_remove') {
      const targetUserIds = values; // 💡 這裡現在是一個包含多個 ID 的陣列
      const beforeLength = trip.members.length;
      
      // 💡 過濾掉所有被選中的成員
      trip.members = trip.members.filter(m => !targetUserIds.includes(m.id));

      const removedCount = beforeLength - trip.members.length;
      if (removedCount === 0) {
        return interaction.reply({ content: '⚠️ 選擇的使用者本來就不在名單中。', flags: MessageFlags.Ephemeral });
      }

      // 💡 檢查「任何一個」被移除的成員是否含有歷史分帳義務
      const hasHistory = trip.expenses.some(e => 
        e.payers.some(p => targetUserIds.includes(p.userId)) || 
        e.participants.some(pt => targetUserIds.includes(pt.userId))
      );

      storage.persist();
      
      // 將所有被移除的成員 ID 轉為 Discord 提及格式
      const removedMentions = targetUserIds.map(id => `<@${id}>`).join(', ');
      let resContent = `🗑️ 已移出 ${removedCount} 位成員：${removedMentions}。`;
      
      if (hasHistory) {
        resContent += `\n⚠️ 提醒：部分被移出的成員曾參與歷史代墊或分攤，最終結算仍會採計。`;
      }
      
      return showMainMenu(interaction, resContent);
    }
  }
};
