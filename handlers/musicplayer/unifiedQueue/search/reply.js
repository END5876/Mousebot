// handlers/musicplayer/unifiedQueue/search/reply.js
// 職責：共用的「已加入佇列 / 開始播放」回覆組裝，供 index.js 與 online.js 共用

const { EmbedBuilder } = require('discord.js');
const { updateControlPanel } = require('../playback');

async function replyPlayResult(interaction, item, result) {
  const guildId = interaction.guildId;

  const descText = item.type === 'bilibili'
    ? `[${item.title}](${item.url})`
    : `🎧 **${item.title}**`;

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
    .setColor(0x1DB954)
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
    replyEmbed.setFooter({ text: '使用下方按鈕控制播放' });
  }

  await interaction.editReply({ embeds: [replyEmbed], components: [] });
  await updateControlPanel(guildId, interaction.channel);
}

module.exports = { replyPlayResult };
