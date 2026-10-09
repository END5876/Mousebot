'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const splitbillClient = require('../utils/splitbillClient');
const { wouldLeaveTripNonEmpty, memberMention, findMemberByDiscordId } = require('../utils/tripHelper');
const { showMainMenu } = require('../commands/splitbill');

// 🆕 [行程獨立化] 成員 = { id, name, discordId? }。從 Discord 使用者選單加進來的人
// 會拿到新的成員 ID（mem_xxxx）並直接連結 discordId；網頁上建立、尚未連結的
// 成員可以在這裡由任何一位成員替他連結 Discord 帳號（「🔗 連結 Discord 帳號」）。

function displayNameOf(interaction, userId) {
  const member = interaction.members && interaction.members.get(userId);
  if (member && member.displayName) return member.displayName;
  const user = (interaction.users && interaction.users.get(userId)) || interaction.client.users.cache.get(userId);
  return user ? (user.globalName || user.username) : `User_${userId}`;
}

async function loadPinnedTrip(interaction) {
  const { customId, guildId, user } = interaction;
  const pinned = customId.includes('::') ? customId.split('::')[1] : null;
  if (pinned) return splitbillClient.resolveTripById(guildId, pinned);
  return (await splitbillClient.resolveTrip(guildId, null, user.id)).trip;
}

module.exports = {
  async handleButton(interaction) {
    const { customId, guildId, user } = interaction;
    const { trip } = await splitbillClient.resolveTrip(guildId, null, user.id);

    if (customId === 'nav_main') return showMainMenu(interaction);
    if (!trip) return showMainMenu(interaction, '⚠️ 找不到行程（可能已被刪除或已在網頁解除綁定）。');

    if (customId === 'mem_nav') {
      const unlinked = trip.members.filter((m) => !m.discordId).length;
      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle('👥 行程成員管理')
        .setDescription(
          `當前行程：**${trip.name}**\n請選擇管理動作：` +
          (unlinked ? `\n\n🔗 有 **${unlinked}** 位成員尚未連結 Discord 帳號（在 Discord 只會顯示名字、無法操作面板），可用「連結 Discord 帳號」替他們連結。` : '')
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('mem_btn_add_ui').setLabel('➕ 新增成員').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('mem_btn_remove_ui').setLabel('🗑️ 移除成員').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('mem_btn_link_ui').setLabel('🔗 連結 Discord 帳號').setStyle(ButtonStyle.Secondary).setDisabled(!unlinked),
        new ButtonBuilder().setCustomId('mem_btn_list').setLabel('📋 查看名單').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('nav_main').setLabel('⬅️ 返回主選單').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    if (customId === 'mem_btn_add_ui') {
      const embed = new EmbedBuilder().setColor(0x9b59b6).setTitle('➕ 邀請成員加入行程').setDescription('請使用下方選單選擇要拉入此行程分帳的成員：');
      const menuRow = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId(`mem_select_add::${trip.id}`).setPlaceholder('選取群組成員...').setMinValues(1).setMaxValues(10)
      );
      return interaction.update({ embeds: [embed], components: [menuRow] });
    }

    if (customId === 'mem_btn_remove_ui') {
      if (!trip.members || trip.members.length === 0) {
        return interaction.reply({ content: '⚠️ 目前行程內沒有任何成員可供移除。', flags: MessageFlags.Ephemeral });
      }

      // 🔒 [修正：孤兒行程] 只剩最後 1 位成員時不再提供移除。
      if (trip.members.length === 1) {
        return interaction.reply({
          content: '⚠️ 這是行程「' + trip.name + '」的最後 1 位成員，無法移除——移除後將沒有任何人能再操作或刪除這個行程。\n如果要結束這趟行程，請改用「🧳 行程設定 → ❌ 刪除此行程」。',
          flags: MessageFlags.Ephemeral
        });
      }

      const embed = new EmbedBuilder().setColor(0xe74c3c).setTitle('🗑️ 從行程移出成員').setDescription(
        '請從下方選單選取欲退出的成員 (可多選)：\n*(至少需保留 1 位已連結 Discord 的成員)*'
      );

      const memberOptions = trip.members.slice(0, 25).map(m => (m.discordId
        ? { label: m.name.slice(0, 100), value: m.id }
        : { label: m.name.slice(0, 100), value: m.id, description: '尚未連結 Discord' }));
      // 🔒 上限設為「總數 - 1」，讓使用者在選單層級就不可能一次選光所有成員；
      // 「至少留 1 位已連結成員」由送出後的 wouldLeaveTripNonEmpty() 把關。
      const maxRemovable = Math.max(1, memberOptions.length - 1);
      const menuRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`mem_select_remove::${trip.id}`)
          .setPlaceholder('選取退出成員 (可多選)...')
          .setMinValues(1)
          .setMaxValues(maxRemovable)
          .addOptions(memberOptions)
      );

      return interaction.update({ embeds: [embed], components: [menuRow] });
    }

    if (customId === 'mem_btn_link_ui') {
      const unlinked = trip.members.filter((m) => !m.discordId);
      if (!unlinked.length) {
        return interaction.reply({ content: '✅ 所有成員都已經連結 Discord 帳號了。', flags: MessageFlags.Ephemeral });
      }
      const embed = new EmbedBuilder().setColor(0x9b59b6).setTitle('🔗 連結 Discord 帳號（1/2）')
        .setDescription('這些成員是在網頁上建立的，還沒有對應的 Discord 帳號。\n請先選擇要連結的是哪一位：\n\n*(本人也可以用網頁的邀請連結自己認領)*');
      const menuRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`mem_select_link_member::${trip.id}`)
          .setPlaceholder('選擇尚未連結的成員...')
          .addOptions(unlinked.slice(0, 25).map((m) => ({ label: m.name.slice(0, 100), value: m.id })))
      );
      const backRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('mem_nav').setLabel('⬅️ 返回成員管理').setStyle(ButtonStyle.Secondary)
      );
      return interaction.update({ embeds: [embed], components: [menuRow, backRow] });
    }

    if (customId === 'mem_btn_list') {
      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle(`📋 行程「${trip.name}」成員名單`)
        .setDescription(trip.members.length
          ? trip.members.map((m, i) => (m.discordId
            ? `${i + 1}. <@${m.discordId}> (\`${m.name}\`)`
            : `${i + 1}. ${m.name}　*（尚未連結 Discord）*`)).join('\n')
          : ' 目前沒有成員。');

      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('mem_nav').setLabel('⬅️ 返回成員管理').setStyle(ButtonStyle.Secondary));
      return interaction.update({ embeds: [embed], components: [row] });
    }
  },

  async handleSelectMenu(interaction) {
    const { customId, guildId, values } = interaction;
    const baseId = customId.split('::')[0];
    const trip = await loadPinnedTrip(interaction);
    if (!trip) {
      return interaction.reply({ content: '⚠️ 找不到行程（可能已被刪除或已在網頁解除綁定），請重新開啟面板。', flags: MessageFlags.Ephemeral });
    }
    const save = () => splitbillClient.saveTrip(guildId, trip.id, trip, { actorId: interaction.user.id });

    if (baseId === 'mem_select_add') {
      let addedCount = 0;
      const skipped = [];
      for (const discordUserId of values) {
        const user = (interaction.users && interaction.users.get(discordUserId)) || null;
        if (user && user.bot) { skipped.push(`<@${discordUserId}>`); continue; }
        if (findMemberByDiscordId(trip, discordUserId)) continue;
        trip.members.push({ id: splitbillClient.genId('mem'), name: displayNameOf(interaction, discordUserId), discordId: discordUserId });
        addedCount++;
      }
      if (addedCount > 0) await save();
      const skipNote = skipped.length ? `\n（機器人不能加入行程，已略過：${skipped.join('、')}）` : '';
      return showMainMenu(interaction, `✅ 成功將 ${addedCount} 位成員新增至行程「${trip.name}」！${skipNote}`);
    }

    if (baseId === 'mem_select_remove') {
      const targetMemberIds = values;

      // 🔒 [修正：孤兒行程] 最終防線：以當下最新的成員名單重新驗證一次，只要移除後
      // 不再有任何已連結 Discord 的成員就整批拒絕、完全不寫入。
      if (!wouldLeaveTripNonEmpty(trip, targetMemberIds)) {
        return interaction.reply({
          content: `❌ 無法移除：移除後行程「${trip.name}」將沒有任何已連結 Discord 的成員，屆時 Discord 這邊沒有人能再操作它。請至少保留 1 位（如需結束行程，請改用「🧳 行程設定 → ❌ 刪除此行程」）。`,
          flags: MessageFlags.Ephemeral
        });
      }

      // 先記下顯示用的名字／提及，移除後就查不到了
      const removedLabels = targetMemberIds.filter((id) => trip.members.some((m) => m.id === id)).map((id) => memberMention(trip, id));
      const beforeLength = trip.members.length;
      trip.members = trip.members.filter(m => !targetMemberIds.includes(m.id));

      const removedCount = beforeLength - trip.members.length;
      if (removedCount === 0) {
        return interaction.reply({ content: '⚠️ 選擇的成員本來就不在名單中。', flags: MessageFlags.Ephemeral });
      }

      // 💡 檢查「任何一個」被移除的成員是否含有歷史分帳義務
      const hasHistory = trip.expenses.some(e =>
        e.payers.some(p => targetMemberIds.includes(p.userId)) ||
        e.participants.some(pt => targetMemberIds.includes(pt.userId))
      ) || (trip.deposits || []).some(d => targetMemberIds.includes(d.payerId) || targetMemberIds.includes(d.collectorId));

      await save();

      let resContent = `🗑️ 已移出 ${removedCount} 位成員：${removedLabels.join(', ')}。`;
      if (hasHistory) {
        resContent += `\n⚠️ 提醒：部分被移出的成員曾參與歷史代墊或分攤，最終結算仍會採計。`;
      }
      return showMainMenu(interaction, resContent);
    }

    if (baseId === 'mem_select_link_member') {
      const memberId = values[0];
      const member = trip.members.find((m) => m.id === memberId);
      if (!member || member.discordId) {
        return interaction.reply({ content: '⚠️ 這位成員已經被連結或已被移除，請重新操作。', flags: MessageFlags.Ephemeral });
      }
      const embed = new EmbedBuilder().setColor(0x9b59b6).setTitle('🔗 連結 Discord 帳號（2/2）')
        .setDescription(`要把成員「**${member.name}**」連結到哪一位 Discord 使用者？\n\n連結後，他過去的代墊與分攤紀錄都會保留，並且可以開始操作這個行程的面板。`);
      // customId：mem_select_link_user::<tripId>::<memberId>（第二段固定是 tripId，
      // 讓 index.js 的權限檢查能鎖定同一個行程）
      const menuRow = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId(`mem_select_link_user::${trip.id}::${member.id}`).setPlaceholder('選擇 Discord 使用者...').setMinValues(1).setMaxValues(1)
      );
      const backRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('mem_nav').setLabel('⬅️ 返回成員管理').setStyle(ButtonStyle.Secondary)
      );
      return interaction.update({ embeds: [embed], components: [menuRow, backRow] });
    }

    if (baseId === 'mem_select_link_user') {
      const memberId = customId.split('::')[2];
      const discordUserId = values[0];
      const member = trip.members.find((m) => m.id === memberId);
      if (!member) {
        return interaction.reply({ content: '⚠️ 找不到這位成員（可能已被移除），請重新操作。', flags: MessageFlags.Ephemeral });
      }
      if (member.discordId) {
        return interaction.reply({ content: `⚠️「${member.name}」已經連結到 <@${member.discordId}> 了。`, flags: MessageFlags.Ephemeral });
      }
      const user = interaction.users && interaction.users.get(discordUserId);
      if (user && user.bot) {
        return interaction.reply({ content: '⚠️ 不能把成員連結到機器人帳號。', flags: MessageFlags.Ephemeral });
      }
      const existing = findMemberByDiscordId(trip, discordUserId);
      if (existing) {
        return interaction.reply({ content: `⚠️ <@${discordUserId}> 在這個行程已經是「${existing.name}」了，一個帳號只能連結一位成員。`, flags: MessageFlags.Ephemeral });
      }
      member.discordId = discordUserId;
      const saved = await save();
      // service 端會拒絕不合規的連結（例如同時有人先連結了），以回傳結果為準
      const after = (saved.members || []).find((m) => m.id === memberId);
      if (!after || after.discordId !== discordUserId) {
        return showMainMenu(interaction, `⚠️ 「${member.name}」沒有連結成功（可能剛好被其他人搶先連結了），請重新查看成員名單。`);
      }
      return showMainMenu(interaction, `🔗 已把成員「${member.name}」連結到 <@${discordUserId}>，他現在可以操作這個行程了。`);
    }
  }
};
