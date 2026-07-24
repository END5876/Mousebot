// handlers/musicplayer/unifiedQueue/search/online.js
// 職責：線上搜尋流程（送出後備援）— 觸發時機：
//   1. autocomplete 階段來不及即時搜尋完成（逾時／節流跳過）
//   2. 本地找不到對應檔案
//  ★ 注意：這裡呼叫 searchMulti(keyword, 5) 未帶 fast/platforms 參數，
//    因此維持「YouTube + Bilibili 完整解析」的原始行為，不受即時搜尋修改影響

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const { _engines, activeSearchMessages } = require('../state');
const { enqueue } = require('../playback');
const { replyPlayResult } = require('./reply');

// ════════════════════════════════════════════════════════
//  搜尋結果選單 UI（送出後備援流程用，見 handleOnlineSearch）
// ════════════════════════════════════════════════════════
function buildSearchComponents(results) {
  const options = results.map((r, i) => ({
    label      : r.title.slice(0, 100),
    description: `${r.platform} · ${r.author} · ${r.duration}`.slice(0, 100),
    value      : String(i),
    emoji      : r.platform === 'YouTube' ? '🎬' : '📺',
  }));

  const selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('srch_pick')
      .setPlaceholder('請選擇要播放的搜尋結果...')
      .addOptions(options)
  );

  const cancelRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('srch_cancel')
      .setLabel('取消搜尋')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Secondary)
  );

  return [selectRow, cancelRow];
}

async function handleOnlineSearch(interaction, keyword, guildId) {
  const engine = _engines.bilibili;
  if (!engine || typeof engine.searchMulti !== 'function') {
    return interaction.editReply('❌ 線上搜尋引擎未就緒（缺少 searchMulti）');
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder().setColor(0x1DB954).setDescription(`🔍 正在搜尋「${keyword}」（YouTube + Bilibili）...`)
    ],
    components: [],
  });

  let results;
  try {
    results = await engine.searchMulti(keyword, 5);
  } catch (err) {
    return interaction.editReply(`❌ 搜尋失敗：${err.message}`);
  }

  if (!results || results.length === 0) {
    return interaction.editReply(`❌ 找不到與「${keyword}」相關的結果`);
  }

  const listText = results
    .map((r, i) => `**${i + 1}.** [${r.platform}] [${r.title}](${r.url})\n　└ ${r.author} · ${r.duration}`)
    .join('\n\n');

  const message = await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle(`🔍 搜尋結果：「${keyword}」（YouTube + Bilibili）`)
        .setDescription(listText)
        .setFooter({ text: '請於 60 秒內從下方選單選擇（🎬 YouTube / 📺 Bilibili），或按取消' })
    ],
    components: buildSearchComponents(results),
  }).catch(() => null);

  if (!message) return;

  activeSearchMessages.add(message.id);

  let selection;
  try {
    selection = await message.awaitMessageComponent({
      filter: i => i.user.id === interaction.user.id &&
                   (i.customId === 'srch_pick' || i.customId === 'srch_cancel'),
      time: 60_000,
    });
  } catch {
    return interaction.editReply({
      content: '⌛ 搜尋已逾時，請重新使用 /play',
      embeds: [], components: [],
    }).catch(() => {});
  } finally {
    activeSearchMessages.delete(message.id);
  }

  if (selection.customId === 'srch_cancel') {
    return selection.update({ content: '❌ 已取消搜尋', embeds: [], components: [] });
  }

  const picked = results[Number(selection.values[0])];

  await selection.update({
    embeds: [
      new EmbedBuilder().setColor(0x1DB954).setDescription(`🔍 正在取得「${picked.title}」的資訊...`)
    ],
    components: [],
  });

  let item;
  try {
    item = await engine.getInfo(picked.url);
    item.type = 'bilibili';
  } catch (err) {
    return interaction.editReply(`❌ 無法獲取影片資訊：${err.message}`);
  }

  const result = await enqueue(guildId, item, interaction.channel);
  await replyPlayResult(interaction, item, result);
}

module.exports = { handleOnlineSearch };
