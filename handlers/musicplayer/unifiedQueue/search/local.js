// handlers/musicplayer/unifiedQueue/search/local.js
// 職責：全部本地音樂批次加入（__ALL_LOCAL__）、多選本地音樂（__LOCAL_MULTI__）

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const { _engines, activeSearchMessages } = require('../state');
const { enqueue, ensureConnection, updateControlPanel } = require('../playback');
const { shuffle } = require('./utils');

// ════════════════════════════════════════════════════════
//  handlePlayAll（全部本地音樂批次加入）
// ════════════════════════════════════════════════════════
async function handlePlayAll(interaction, shuffleOpt) {
  const guildId = interaction.guildId;

  let connection;
  try {
    connection = await ensureConnection(interaction);
  } catch {
    return interaction.editReply('❌ 加入語音頻道時發生錯誤');
  }
  if (!connection) return interaction.editReply('❌ 你必須先加入語音頻道！');

  const engine = _engines.local;
  if (!engine) return interaction.editReply('❌ 本地音樂引擎未就緒');

  let files = engine.getMusicFiles();
  if (files.length === 0) {
    return interaction.editReply('❌ music 資料夾內沒有可播放的音訊檔案！');
  }

  if (shuffleOpt === 'yes') files = shuffle(files);

  let addedCount = 0;
  for (const file of files) {
    const item = {
      ...file,
      title: file.name,
      type: 'local',
    };
    await enqueue(guildId, item, interaction.channel);
    addedCount++;
  }

  const orderLabel = shuffleOpt === 'yes' ? '🔀 隨機排序' : '📋 依檔名順序';
  const previewLines = files
    .slice(0, 10)
    .map((f, i) => `\`${i + 1}.\` ${f.name}`)
    .join('\n');
  const moreText = files.length > 10
    ? `\n*...以及另外 ${files.length - 10} 首*`
    : '';

  const embed = new EmbedBuilder()
    .setColor(0x1DB954)
    .setTitle('📋 已將所有本地音樂加入佇列')
    .addFields(
      { name: '✅ 加入數量', value: `${addedCount} 首`, inline: true },
      { name: '🔢 排序方式', value: orderLabel, inline: true },
      { name: '📄 播放順序預覽（前 10 首）', value: previewLines + moreText },
    )
    .setFooter({ text: `由 ${interaction.user.tag} 加入` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
  await updateControlPanel(guildId, interaction.channel);
  console.log(`✅ [UnifiedQueue] localAll: ${addedCount} 首已加入佇列 (${guildId})`);
}

// ════════════════════════════════════════════════════════
//  handleLocalMultiSelect（多選本地音樂 → 一次加入佇列）
//  ★ Discord Select Menu 平台限制：單選單最多 25 個選項，
//    超過部分不顯示，請使用者改用 /play 關鍵字搜尋單首補加
// ════════════════════════════════════════════════════════
const LOCAL_MULTI_SELECT_LIMIT = 25;

async function handleLocalMultiSelect(interaction) {
  const guildId = interaction.guildId;

  let connection;
  try {
    connection = await ensureConnection(interaction);
  } catch {
    return interaction.editReply('❌ 加入語音頻道時發生錯誤');
  }
  if (!connection) return interaction.editReply('❌ 你必須先加入語音頻道！');

  const engine = _engines.local;
  if (!engine) return interaction.editReply('❌ 本地音樂引擎未就緒');

  const files = engine.getMusicFiles();
  if (files.length === 0) {
    return interaction.editReply('❌ music 資料夾內沒有可播放的音訊檔案！');
  }

  const displayFiles = files.slice(0, LOCAL_MULTI_SELECT_LIMIT);
  const truncated = files.length > LOCAL_MULTI_SELECT_LIMIT;

  const options = displayFiles.map((f, i) => ({
    label      : f.name.slice(0, 100),
    description: f.filename.slice(0, 100),
    value      : String(i),
  }));

  const selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('lm_pick')
      .setPlaceholder('請勾選要加入的本地音樂（可多選）...')
      .setMinValues(1)
      .setMaxValues(options.length)
      .addOptions(options)
  );

  const cancelRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('lm_cancel')
      .setLabel('取消')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Secondary)
  );

  const noteText = truncated
    ? `⚠️ 本地音樂共有 **${files.length}** 首，選單受 Discord 平台限制僅能顯示前 **${LOCAL_MULTI_SELECT_LIMIT}** 首。\n若需要清單外的曲目，請改用 \`/play\` 輸入關鍵字，自動完成選取單首加入。`
    : `共 **${files.length}** 首，請勾選要加入的曲目：`;

  const message = await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle('📂 選擇多首本地音樂')
        .setDescription(noteText)
        .setFooter({ text: '請於 60 秒內勾選並送出，或按取消' })
    ],
    components: [selectRow, cancelRow],
  }).catch(() => null);

  if (!message) return;

  // ★ 沿用既有的殭屍互動防護標記（與 _handleOnlineSearch 一致）
  activeSearchMessages.add(message.id);

  let selection;
  try {
    selection = await message.awaitMessageComponent({
      filter: i => i.user.id === interaction.user.id &&
                   (i.customId === 'lm_pick' || i.customId === 'lm_cancel'),
      time: 60_000,
    });
  } catch {
    return interaction.editReply({
      content: '⌛ 選擇已逾時，請重新使用 /play',
      embeds: [], components: [],
    }).catch(() => {});
  } finally {
    activeSearchMessages.delete(message.id);
  }

  if (selection.customId === 'lm_cancel') {
    return selection.update({ content: '❌ 已取消選擇', embeds: [], components: [] });
  }

  const pickedFiles = selection.values
    .map(v => displayFiles[Number(v)])
    .filter(Boolean);

  await selection.update({
    embeds: [
      new EmbedBuilder().setColor(0x1DB954).setDescription(`➕ 正在加入 ${pickedFiles.length} 首本地音樂...`)
    ],
    components: [],
  });

  let addedCount = 0;
  for (const file of pickedFiles) {
    const item = { ...file, title: file.name, type: 'local' };
    await enqueue(guildId, item, interaction.channel);
    addedCount++;
  }

  const previewLinesRaw = pickedFiles
    .map((f, i) => `\`${i + 1}.\` ${f.name}`)
    .join('\n');
  const previewLines = previewLinesRaw.length > 1024
    ? previewLinesRaw.slice(0, 1021) + '...'
    : previewLinesRaw;

  const embed = new EmbedBuilder()
    .setColor(0x1DB954)
    .setTitle('📂 已將所選本地音樂加入佇列')
    .addFields(
      { name: '✅ 加入數量', value: `${addedCount} 首`, inline: true },
      { name: '📄 曲目清單', value: previewLines },
    )
    .setFooter({ text: `由 ${interaction.user.tag} 加入` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], components: [] });
  await updateControlPanel(guildId, interaction.channel);
  console.log(`✅ [UnifiedQueue] localMulti: ${addedCount} 首已加入佇列 (${guildId})`);
}

module.exports = { handlePlayAll, handleLocalMultiSelect };
