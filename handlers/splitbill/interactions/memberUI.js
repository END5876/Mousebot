'use strict';

const crypto = require('crypto');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const splitbillClient = require('../utils/splitbillClient');
const { wouldLeaveTripNonEmpty, memberMention, findMemberByDiscordId, canRemoveMember, isLinkedMember } = require('../utils/tripHelper');
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

// 移出成員前的檢查；有問題回傳要顯示的訊息，沒問題回傳 null
function removalProblem(trip, ids, userId) {
  // 🔒 [修正：孤兒行程] 最終防線：以當下最新的成員名單重新驗證一次，只要移除後
  // 不再有任何已連結 Discord 的成員就整批拒絕、完全不寫入。
  if (!wouldLeaveTripNonEmpty(trip, ids)) {
    return `❌ 無法移除：移除後行程「${trip.name}」將沒有任何已連結 Discord 的成員，屆時 Discord 這邊沒有人能再操作它。請至少保留 1 位（如需結束行程，請改用「🧳 行程設定 → ❌ 刪除此行程」）。`;
  }
  // 🔒 以最新的成員名單再確認一次權限（選單打開之後，可能有人剛連結了 Discord 帳號）
  const notAllowed = trip.members.filter((m) => ids.includes(m.id) && !canRemoveMember(trip, m, userId));
  if (notAllowed.length) {
    return `❌ 無法移除：${notAllowed.map((m) => memberMention(trip, m.id)).join('、')} 已經連結 Discord 帳號，只有行程建立者可以移除（本人可以移除自己）。`;
  }
  return null;
}

// 每位成員出現在幾筆支出、幾筆轉帳裡
function entryCounts(trip, ids) {
  return ids.map((id) => ({
    id,
    expenses: (trip.expenses || []).filter((e) => e.payers.some((p) => p.userId === id) || e.participants.some((pt) => pt.userId === id)).length,
    deposits: (trip.deposits || []).filter((d) => d.payerId === id || d.collectorId === id).length,
  }));
}

// 等待「仍要移出」的選擇：key＝每次確認各自的代碼（放在按鈕的 customId 裡），10 分鐘內有效。
// customId 放不下多位成員的 ID；用每次不同的代碼，舊的確認訊息不會移出後來選的另一批人
const pendingRemovals = new Map();
function newRemovalToken() {
  const now = Date.now();
  for (const [k, v] of pendingRemovals) if (now - v.at > PENDING_REMOVAL_MS) pendingRemovals.delete(k);
  return crypto.randomBytes(6).toString('hex');
}
const PENDING_REMOVAL_MS = 10 * 60 * 1000;

async function removeMembers(interaction, trip, targetMemberIds) {
  const save = () => splitbillClient.saveTrip(interaction.guildId, trip.id, trip, { actorId: interaction.user.id });
  // 先記下顯示用的名字／提及，移除後就查不到了
  const labelOf = new Map(targetMemberIds
    .filter((id) => trip.members.some((m) => m.id === id))
    .map((id) => [id, memberMention(trip, id)]));
  const hasHistory = entryCounts(trip, targetMemberIds).some((c) => c.expenses || c.deposits);
  const beforeLength = trip.members.length;
  trip.members = trip.members.filter(m => !targetMemberIds.includes(m.id));

  if (beforeLength - trip.members.length === 0) {
    return interaction.reply({ content: '⚠️ 選擇的成員本來就不在名單中。', flags: MessageFlags.Ephemeral });
  }

  // 以伺服器存檔後的名單為準回報結果：service 會把不允許移除的已連結成員補回去，
  // 不能只看本地陣列就說「已移出」
  const saved = await save();
  const remaining = new Set(((saved && saved.members) || trip.members).map((m) => m.id));
  const removedIds = targetMemberIds.filter((id) => labelOf.has(id) && !remaining.has(id));
  const keptIds = targetMemberIds.filter((id) => labelOf.has(id) && remaining.has(id));
  if (!removedIds.length) {
    return showMainMenu(interaction, `❌ 沒有移除任何成員：${keptIds.map((id) => labelOf.get(id)).join(', ')} 只有行程建立者可以移除。`);
  }

  let resContent = `🗑️ 已移出 ${removedIds.length} 位成員：${removedIds.map((id) => labelOf.get(id)).join(', ')}。`;
  if (keptIds.length) {
    resContent += `\n⚠️ ${keptIds.map((id) => labelOf.get(id)).join(', ')} 已連結 Discord 帳號，只有行程建立者可以移除，仍保留在行程中。`;
  }
  if (hasHistory) {
    resContent += '\n⚠️ 被移出的成員有參與過的帳目，這些金額已經不算進結算，其他人的要付、可拿回金額跟著改變了。';
  }
  return showMainMenu(interaction, resContent);
}

module.exports = {
  async handleButton(interaction) {
    const { customId, guildId, user } = interaction;

    // 「仍要移出」：用按鈕上綁定的行程，重新檢查一次再移出
    if (customId.startsWith('mem_confirm_remove::')) {
      const pinnedTrip = await loadPinnedTrip(interaction);
      if (!pinnedTrip) {
        return interaction.reply({ content: '⚠️ 找不到行程（可能已被刪除或已在網頁解除綁定），請重新開啟面板。', flags: MessageFlags.Ephemeral });
      }
      const token = customId.split('::')[2];
      const pending = pendingRemovals.get(token);
      // 只有當初選人的那位可以按（確認訊息是只有自己看得到的，這裡多擋一層）
      if (pending && pending.userId !== user.id) {
        return interaction.reply({ content: '⚠️ 這是別人的確認，請從成員管理自己選擇要移出的成員。', flags: MessageFlags.Ephemeral });
      }
      pendingRemovals.delete(token);
      if (!pending || Date.now() - pending.at > PENDING_REMOVAL_MS) {
        return interaction.reply({ content: '⌛ 這個確認已經逾時，請回到成員管理重新選擇要移出的成員。', flags: MessageFlags.Ephemeral });
      }
      const problem = removalProblem(pinnedTrip, pending.ids, user.id);
      if (problem) return interaction.reply({ content: problem, flags: MessageFlags.Ephemeral });
      return removeMembers(interaction, pinnedTrip, pending.ids);
    }

    const { trip } = await splitbillClient.resolveTrip(guildId, null, user.id);

    if (customId === 'nav_main') return showMainMenu(interaction);
    if (!trip) return showMainMenu(interaction, '⚠️ 找不到行程（可能已被刪除或已在網頁解除綁定）。');

    if (customId === 'mem_nav') {
      const unlinked = trip.members.filter((m) => !isLinkedMember(m)).length;
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

      // 🔒 只列出「這位操作者可以移除」的成員：已連結 Discord 的成員只有建立者能移除
      // （本人可以移除自己），規則同 splitbill-service，見 tripHelper.canRemoveMember()。
      const removable = trip.members.filter((m) => canRemoveMember(trip, m, user.id));
      const hiddenLinked = trip.members.length - removable.length;
      if (!removable.length) {
        return interaction.reply({
          content: '⚠️ 目前沒有你可以移除的成員：已連結 Discord 的成員只有行程建立者可以移除（本人可以移除自己）。',
          flags: MessageFlags.Ephemeral
        });
      }

      const embed = new EmbedBuilder().setColor(0xe74c3c).setTitle('🗑️ 從行程移出成員').setDescription(
        '請選擇要移出的成員（可多選）：\n*（至少要留下 1 位已連結 Discord 的成員）*' +
        (hiddenLinked ? `\n*(另有 ${hiddenLinked} 位已連結 Discord 的成員只有行程建立者可以移除，未列出)*` : '')
      );

      const memberOptions = removable.slice(0, 25).map(m => (m.discordId
        ? { label: m.name.slice(0, 100), value: m.id }
        : { label: m.name.slice(0, 100), value: m.id, description: m.lineId ? '已用 LINE 連結' : '尚未連結 Discord' }));
      // 🔒 上限不超過「總數 - 1」，讓使用者在選單層級就不可能一次選光所有成員；
      // 「至少留 1 位已連結成員」由送出後的 wouldLeaveTripNonEmpty() 把關。
      const maxRemovable = Math.max(1, Math.min(memberOptions.length, trip.members.length - 1));
      const menuRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`mem_select_remove::${trip.id}`)
          .setPlaceholder('選擇要移出的成員（可多選）...')
          .setMinValues(1)
          .setMaxValues(maxRemovable)
          .addOptions(memberOptions)
      );

      return interaction.update({ embeds: [embed], components: [menuRow] });
    }

    if (customId === 'mem_btn_link_ui') {
      // 🆕 在網頁用 LINE 認領的成員（lineId）已經有主人，不能再連結給別的 Discord 帳號
      const unlinked = trip.members.filter((m) => !isLinkedMember(m));
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
            : `${i + 1}. ${m.name}　*（${m.lineId ? '已用 LINE 連結' : '尚未連結 Discord'}）*`)).join('\n')
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
      const problem = removalProblem(trip, targetMemberIds, interaction.user.id);
      if (problem) return interaction.reply({ content: problem, flags: MessageFlags.Ephemeral });

      // 有帳目的成員：移出後他的金額不會算進結算，先講清楚、確認後才移出
      const withEntries = entryCounts(trip, targetMemberIds).filter((c) => c.expenses || c.deposits);
      if (withEntries.length) {
        const token = newRemovalToken();
        pendingRemovals.set(token, { ids: targetMemberIds, userId: interaction.user.id, at: Date.now() });
        const lines = withEntries.map((c) => `・${memberMention(trip, c.id)}：${[c.expenses ? `${c.expenses} 筆支出` : '', c.deposits ? `${c.deposits} 筆轉帳` : ''].filter(Boolean).join('、')}`);
        const embed = new EmbedBuilder().setColor(0xe74c3c).setTitle('🗑️ 移出有帳目的成員？').setDescription(
          `${lines.join('\n')}\n\n移出後，這些金額不會算進結算，其他人的要付、可拿回金額會跟著改變。\n可以先到網頁把他的帳目改給另一位成員，再回來移出。`
        );
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`mem_confirm_remove::${trip.id}::${token}`).setLabel('仍要移出').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('mem_nav').setLabel('取消，返回成員管理').setStyle(ButtonStyle.Secondary)
        );
        return interaction.update({ embeds: [embed], components: [row] });
      }
      return removeMembers(interaction, trip, targetMemberIds);
    }

    if (baseId === 'mem_select_link_member') {
      const memberId = values[0];
      const member = trip.members.find((m) => m.id === memberId);
      if (!member || isLinkedMember(member)) {
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
      if (member.lineId) {
        return interaction.reply({ content: `⚠️「${member.name}」已經由本人用 LINE 帳號認領，不能再連結到其他 Discord 帳號。`, flags: MessageFlags.Ephemeral });
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
