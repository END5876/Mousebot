'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const storage = require('../utils/storage');
const { resolveTrip, wouldLeaveTripNonEmpty } = require('../utils/tripHelper');
const { showMainMenu } = require('../commands/splitbill');

module.exports = {
  async handleButton(interaction) {
    const { customId, guildId, user } = interaction;
    const { trip } = resolveTrip(guildId, null, user.id);
    
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

      // 🔒 [修正：孤兒行程] 只剩最後 1 位成員時，不允許再透過「移除成員」把最後
      // 一人移出——那會讓行程變成 0 成員，之後任何人（含原成員）都無法再操作或刪除它。
      // 如果真的要結束這個行程，請引導使用者改走「🧳 行程設定 → ❌ 刪除此行程」。
      if (trip.members.length === 1) {
        return interaction.reply({
          content: '⚠️ 這是行程「' + trip.name + '」的最後 1 位成員，無法移除——移除後將沒有任何人能再操作或刪除這個行程。\n如果要結束這趟行程，請改用「🧳 行程設定 → ❌ 刪除此行程」。',
          flags: MessageFlags.Ephemeral
        });
      }

      const embed = new EmbedBuilder().setColor(0xe74c3c).setTitle('🗑️ 從行程移出成員').setDescription('請從下方選單選取欲退出的成員 (可多選)：\n*(至少需保留 1 位成員，所以最多只能整批選到剩 1 人)*');
      
      const memberOptions = trip.members.slice(0, 25).map(m => ({ label: m.name, value: m.id }));
      // 🔒 上限設為「總數 - 1」，讓使用者在選單層級就不可能一次選光所有成員，
      // 而不是等送出後才被攔下來——UI 上直接不給選超過安全範圍。
      const maxRemovable = Math.max(1, memberOptions.length - 1);
      const menuRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('mem_select_remove')
          .setPlaceholder('選取退出成員 (可多選)...')
          .setMinValues(1)
          .setMaxValues(maxRemovable)
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
    const { customId, guildId, values, user } = interaction;
    const { trip } = resolveTrip(guildId, null, user.id);

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
      if (addedCount > 0) {
        storage.touchTrip(trip);
        storage.persist();
      }
      return showMainMenu(interaction, `✅ 成功將 ${addedCount} 位成員新增至行程「${trip.name}」！`);
    }

    if (customId === 'mem_select_remove') {
      const targetUserIds = values; // 💡 這裡現在是一個包含多個 ID 的陣列

      // 🔒 [修正：孤兒行程] 最終防線——即使上面 UI 層已經把選單上限設為「總數-1」，
      // 仍可能因為多人同時操作、或成員名單在選擇期間被別人改動等情況，讓「移除後
      // 剩餘成員數」在送出當下才變成 0。這裡以當下最新的 trip.members 重新驗證一次，
      // 只要會導致 0 成員就整批拒絕、完全不寫入，不留下任何孤兒行程。
      if (!wouldLeaveTripNonEmpty(trip, targetUserIds)) {
        return interaction.reply({
          content: `❌ 無法移除：這會讓行程「${trip.name}」變成 0 位成員，屆時將沒有任何人能再操作或刪除它。請至少保留 1 位成員（如需結束行程，請改用「🧳 行程設定 → ❌ 刪除此行程」）。`,
          flags: MessageFlags.Ephemeral
        });
      }

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

      storage.touchTrip(trip);
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
