'use strict';

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const C = require('../../../../utils/embedColors'); // embed 色票（utils/embedColors.js）
const { _engines, activeSearchMessages } = require('../state');
const { updateControlPanel, enqueue } = require('../playback');
const { md } = require('../../../../utils/markdown');

// ════════════════════════════════════════════════════════
//  共用的「已加入佇列 / 開始播放」回覆
// ════════════════════════════════════════════════════════
async function _replyPlayResult(interaction, item, result) {
  const guildId = interaction.guildId;

  const descText = item.type === 'bilibili'
    ? `[${md(item.title)}](${item.url})`
    : `🎧 **${md(item.title)}**`;

  const fields = item.type === 'bilibili'
    ? [
        { name: '作者', value: item.author || '未知', inline: true },
        { name: '時長', value: item.duration || '未知', inline: true },
        ...(result.queued ? [{ name: '佇列位置', value: `第 ${result.position} 首`, inline: true }] : []),
      ]
    : [
        ...(result.queued ? [{ name: '佇列位置', value: `第 ${result.position} 首`, inline: true }] : []),
      ];

  const replyEmbed = new EmbedBuilder()
    .setColor(C.MUSIC)
    .setTitle(result.queued ? '➕ 已加入佇列' : '▶️ 開始播放')
    .setDescription(descText)
    .setTimestamp();

  if (fields.length > 0) {
    replyEmbed.addFields(...fields);
  }

  if (item.thumbnail) {
    replyEmbed.setThumbnail(item.thumbnail);
  }

  if (!result.queued) {
    replyEmbed.setFooter({ text: '用下方按鈕控制播放' });
  }

  await interaction.editReply({ embeds: [replyEmbed], components: [] });
  await updateControlPanel(guildId, interaction.channel);
}

// ════════════════════════════════════════════════════════
//  搜尋結果選單 UI（送出後備援流程用，見 _handleOnlineSearch）
// ════════════════════════════════════════════════════════
function _buildSearchComponents(results) {
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

// ════════════════════════════════════════════════════════
//  線上搜尋流程（送出後備援）
//  觸發時機：
//    1. autocomplete 階段來不及即時搜尋完成（逾時／節流跳過）
//    2. 本地找不到對應檔案
//  ★ 注意：這裡呼叫 searchMulti(keyword, 5) 未帶 fast/platforms 參數，
//    因此維持「YouTube + Bilibili 完整解析」的原始行為，不受即時搜尋修改影響
// ════════════════════════════════════════════════════════
async function _handleOnlineSearch(interaction, keyword, guildId) {
  const engine = _engines.bilibili;
  if (!engine || typeof engine.searchMulti !== 'function') {
    return interaction.editReply('⏳ Bot 剛啟動，線上音樂還在準備，約 30 秒後再試一次。');
  }

  await interaction.editReply({
    embeds: [
      new EmbedBuilder().setColor(C.NEUTRAL).setDescription(`🔍 正在 YouTube 和 Bilibili 搜尋「${keyword}」…（最多約 20 秒）`)
    ],
    components: [],
  });

  let results;
  try {
    results = await engine.searchMulti(keyword, 5);
  } catch (err) {
    return interaction.editReply('⚠️ 搜尋沒有完成，請過一下再試一次。');
  }

  if (!results || results.length === 0) {
    return interaction.editReply(`ℹ️ 找不到「${keyword}」。換個關鍵字試試，或直接貼上影片網址。`);
  }

  const listText = results
    .map((r, i) => `**${i + 1}.** [${r.platform}] [${md(r.title)}](${r.url})\n　└ ${md(r.author)} · ${r.duration}`)
    .join('\n\n');

  const message = await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(C.MUSIC)
        .setTitle(`🔍 搜尋結果：「${keyword}」（YouTube + Bilibili）`)
        .setDescription(listText)
        .setFooter({ text: '60 秒內從下方選單選一首（🎬 YouTube、📺 Bilibili），或按「取消搜尋」。' })
    ],
    components: _buildSearchComponents(results),
  }).catch(() => null);

  if (!message) return;

  activeSearchMessages.set(message.id, interaction.user.id);

  let selection;
  try {
    selection = await message.awaitMessageComponent({
      filter: i => i.user.id === interaction.user.id &&
                   (i.customId === 'srch_pick' || i.customId === 'srch_cancel'),
      time: 60_000,
    });
  } catch {
    return interaction.editReply({
      content: '⌛ 超過 60 秒沒選，這次搜尋已經過期。請重新用 /play 搜尋。',
      embeds: [], components: [],
    }).catch(() => {});
  } finally {
    activeSearchMessages.delete(message.id);
  }

  if (selection.customId === 'srch_cancel') {
    return selection.update({ content: '已取消搜尋。', embeds: [], components: [] });
  }

  const picked = results[Number(selection.values[0])];

  await selection.update({
    embeds: [
      new EmbedBuilder().setColor(C.NEUTRAL).setDescription(`🔍 正在讀取「${picked.title}」…（通常 5 秒內）`)
    ],
    components: [],
  });

  let item;
  try {
    item = await engine.getInfo(picked.url);
    item.type = 'bilibili';
  } catch (err) {
    return interaction.editReply('⚠️ 讀不到這個影片，可能是私人影片、有地區限制或已經下架。請換一首。');
  }

  const result = await enqueue(guildId, item, interaction.channel);
  await _replyPlayResult(interaction, item, result);
}

module.exports = {
  _replyPlayResult,
  _handleOnlineSearch
};
