// handlers/musicplayer/unifiedQueue/search/playlist.js
// 職責：播放清單詢問 UI（全部加入/只加入第一首/取消）、批次加入整個播放清單

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const { activeSearchMessages } = require('../state');
const { enqueue, updateControlPanel } = require('../playback');
const { formatDuration, resolveEntryUrl } = require('./utils');

// ════════════════════════════════════════════════════════
//  播放清單詢問 UI（Button：全部加入 / 只加入第一首 / 取消）
//  風格與 commands.js 的 uq_skip / uq_stop 一致
// ════════════════════════════════════════════════════════
async function askPlaylistChoice(interaction, playlistInfo) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('pl_all')
      .setLabel(`全部加入（${playlistInfo.count} 首）`)
      .setEmoji('📋')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('pl_first')
      .setLabel('只加入這一首')
      .setEmoji('🎵')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('pl_cancel')
      .setLabel('取消')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  );

  const message = await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle('📋 偵測到播放清單')
        .setDescription(`「${playlistInfo.title}」共有 **${playlistInfo.count}** 首歌曲，請選擇加入方式：`)
        .setFooter({ text: '請於 30 秒內選擇，逾時將只加入第一首' })
    ],
    components: [row],
  }).catch(() => null);

  if (!message) return 'cancel';

  // 殭屍互動防護（與 _handleOnlineSearch / _handleLocalMultiSelect 一致）
  activeSearchMessages.add(message.id);

  let selection;
  try {
    selection = await message.awaitMessageComponent({
      filter: i => i.user.id === interaction.user.id &&
                   ['pl_all', 'pl_first', 'pl_cancel'].includes(i.customId),
      time: 30_000,
    });
  } catch {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0xFFA500).setDescription('⌛ 選擇逾時，將只加入第一首')],
      components: [],
    }).catch(() => {});
    return 'first';
  } finally {
    activeSearchMessages.delete(message.id);
  }

  if (selection.customId === 'pl_cancel') {
    await selection.update({ content: '❌ 已取消加入播放清單', embeds: [], components: [] });
    return 'cancel';
  }

  await selection.update({
    embeds: [
      new EmbedBuilder().setColor(0x1DB954).setDescription(
        selection.customId === 'pl_all'
          ? '📋 正在加入整個播放清單，請稍候...'
          : '🔍 正在獲取影片資訊...'
      )
    ],
    components: [],
  }).catch(() => {});

  return selection.customId === 'pl_all' ? 'all' : 'first';
}

// ════════════════════════════════════════════════════════
//  批次加入整個播放清單
//  ★ 直接使用 checkPlaylist（--flat-playlist）已取得的 metadata，
//    不對每一首再呼叫 getInfo()，避免短時間大量請求觸發平台反爬蟲機制
// ════════════════════════════════════════════════════════
async function handleAddPlaylist(interaction, baseUrl, playlistInfo, guildId) {
  const entries = playlistInfo.entries;
  let addedCount  = 0;
  let skippedCount = 0;

  for (const entry of entries) {
    const resolvedUrl = resolveEntryUrl(baseUrl, entry);

    // 極少數情況 flat-playlist 條目連基本網址都解析不出來，跳過而非報錯中斷整批
    if (!resolvedUrl) {
      skippedCount++;
      continue;
    }

    const item = {
      url        : resolvedUrl,
      title      : entry.title || '未知標題',
      author     : entry.uploader || entry.channel || entry.creator || '未知作者',
      duration   : entry.duration ? formatDuration(entry.duration) : '未知',
      durationSec: entry.duration || 0,
      thumbnail  : entry.thumbnail
        || (Array.isArray(entry.thumbnails) && entry.thumbnails.length
              ? entry.thumbnails[entry.thumbnails.length - 1].url
              : null),
      type       : 'bilibili', // 沿用既有慣例：YouTube/Bilibili 統一標記為 'bilibili' 引擎類型
    };

    await enqueue(guildId, item, interaction.channel);
    addedCount++;
  }

  const embed = new EmbedBuilder()
    .setColor(0x1DB954)
    .setTitle('📋 播放清單已加入')
    .setDescription(`「${playlistInfo.title}」`)
    .addFields(
      { name: '✅ 成功加入', value: `${addedCount} 首`, inline: true },
      ...(skippedCount > 0 ? [{ name: '⚠️ 已跳過', value: `${skippedCount} 首（無法解析網址）`, inline: true }] : []),
    )
    .setFooter({ text: '💡 metadata 取自快速清單模式，播放時仍會取得完整資訊' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], components: [] });
  await updateControlPanel(guildId, interaction.channel);
  console.log(`✅ [UnifiedQueue] playlist: ${addedCount} 首已加入佇列, ${skippedCount} 首跳過 (${guildId})`);
}

module.exports = { askPlaylistChoice, handleAddPlaylist };
