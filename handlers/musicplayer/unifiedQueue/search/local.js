'use strict';

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const C = require('../../../../utils/embedColors'); // embed 色票（utils/embedColors.js）
const { _engines, activeSearchMessages, nowPlaying, queues, loopSettings, randomPlaySettings } = require('../state');
const logger = require('../../../../utils/logger');
const { enqueue, ensureConnection, updateControlPanel, playRandomLocal, resetShuffleBag } = require('../playback');

// 一次把音樂庫全部加進佇列前要先確認的門檻（加太多會讓之後點的歌要等很久）
const PLAY_ALL_CONFIRM_MIN = 20;

// ════════════════════════════════════════════════════════
//  Fisher-Yates 洗牌
// ════════════════════════════════════════════════════════
function _shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ════════════════════════════════════════════════════════
//  handlePlayAll（全部本地音樂批次加入）
// ════════════════════════════════════════════════════════
async function _handlePlayAll(interaction, shuffleOpt) {
  const guildId = interaction.guildId;

  const engine = _engines.local;
  if (!engine) return interaction.editReply('⏳ Bot 剛啟動，音樂庫還在準備，請過一下再試。');

  let files = engine.getMusicFiles();
  if (files.length === 0) {
    return interaction.editReply('ℹ️ 音樂庫還沒有歌。加歌之後就能用 /play 點播。');
  }

  // 超過門檻先確認：全部加入，或改用隨機連播（不會把整個音樂庫塞進共用佇列）。
  // 確認完才進語音頻道：取消或逾時時 Bot 不會白白待在頻道裡
  const choice = files.length > PLAY_ALL_CONFIRM_MIN ? await _confirmPlayAll(interaction, files.length) : 'all';
  if (choice === 'cancel') return;

  let connection;
  try {
    connection = await ensureConnection(interaction);
  } catch {
    return interaction.editReply({ content: '❌ 沒能加入語音頻道，請再試一次。', embeds: [], components: [] });
  }
  if (!connection) return interaction.editReply({ content: '🔈 先加入一個語音頻道，Bot 才知道要去哪裡播。加入後再用一次指令。', embeds: [], components: [] });

  if (choice === 'random') {
    if (nowPlaying.has(guildId)) {
      randomPlaySettings.set(guildId, true);
      loopSettings.set(guildId, 'off');
      resetShuffleBag(guildId);
    } else {
      await playRandomLocal(guildId, interaction.channel, { enableContinuous: true });
    }
    await interaction.editReply({ content: '🎲 已開啟隨機連播', embeds: [], components: [] }).catch(() => {});
    await updateControlPanel(guildId, interaction.channel);
    return;
  }

  if (shuffleOpt === 'yes') files = _shuffle(files);

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

  const orderLabel = shuffleOpt === 'yes' ? '🔀 打亂順序' : '📋 照歌名順序';
  const previewLines = files
    .slice(0, 10)
    .map((f, i) => `\`${i + 1}.\` ${f.name}`)
    .join('\n');
  const moreText = files.length > 10
    ? `\n*…還有 ${files.length - 10} 首*`
    : '';

  const embed = new EmbedBuilder()
    .setColor(C.MUSIC)
    .setTitle('📋 已把音樂庫的歌全部加入佇列')
    .addFields(
      { name: '✅ 加入數量', value: `${addedCount} 首`, inline: true },
      { name: '🔢 排序方式', value: orderLabel, inline: true },
      { name: '📄 播放順序預覽（前 10 首）', value: previewLines + moreText },
    )
    .setFooter({ text: `由 ${interaction.user.tag} 加入` })
    .setTimestamp();

  await interaction.editReply({ content: '', embeds: [embed], components: [] });
  await updateControlPanel(guildId, interaction.channel);
  logger.success('UnifiedQueue', `localAll: ${addedCount} 首已加入佇列 (${guildId})`);
}

// 「全部加入」的確認：回傳 'all' | 'random' | 'cancel'（逾時算取消）
async function _confirmPlayAll(interaction, total) {
  const queued = (queues.get(interaction.guildId) || []).length;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pa_all').setLabel(`全部加入（${total} 首）`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('pa_random').setLabel('改用隨機連播').setEmoji('🎲').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pa_cancel').setLabel('取消').setStyle(ButtonStyle.Secondary),
  );
  const message = await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(C.MUSIC)
      .setTitle(`把音樂庫的 ${total} 首全部加進佇列？`)
      .setDescription(queued ? `會排在目前 ${queued} 首後面，之後點的歌要很久才輪到。` : '之後點的歌要很久才輪到。')],
    components: [row],
  }).catch(() => null);
  if (!message) return 'cancel';

  activeSearchMessages.set(message.id, interaction.user.id);
  let pick;
  try {
    pick = await message.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id && ['pa_all', 'pa_random', 'pa_cancel'].includes(i.customId),
      time: 60_000,
    });
  } catch {
    await interaction.editReply({ content: '⌛ 超過 60 秒沒選，已取消。', embeds: [], components: [] }).catch(() => {});
    return 'cancel';
  } finally {
    activeSearchMessages.delete(message.id);
  }
  const choice = pick.customId === 'pa_all' ? 'all' : pick.customId === 'pa_random' ? 'random' : 'cancel';
  // 回應按鈕失敗（網路抖一下）不影響選擇：後面會用 editReply 更新同一則訊息
  if (choice === 'cancel') await pick.update({ content: '已取消，沒有加入佇列。', embeds: [], components: [] }).catch(() => {});
  else await pick.deferUpdate().catch(() => {});
  return choice;
}

// ════════════════════════════════════════════════════════
//  handleLocalMultiSelect（多選本地音樂 → 一次加入佇列）
//  ★ Discord Select Menu 平台限制：單選單最多 25 個選項，
//    超過部分不顯示，請使用者改用 /play 關鍵字搜尋單首補加
// ════════════════════════════════════════════════════════
const LOCAL_MULTI_SELECT_LIMIT = 25;

async function _handleLocalMultiSelect(interaction) {
  const guildId = interaction.guildId;

  let connection;
  try {
    connection = await ensureConnection(interaction);
  } catch {
    return interaction.editReply('❌ 沒能加入語音頻道，請再試一次。');
  }
  if (!connection) return interaction.editReply('🔈 先加入一個語音頻道，Bot 才知道要去哪裡播。加入後再用一次指令。');

  const engine = _engines.local;
  if (!engine) return interaction.editReply('⏳ Bot 剛啟動，音樂庫還在準備，請過一下再試。');

  const files = engine.getMusicFiles();
  if (files.length === 0) {
    return interaction.editReply('ℹ️ 音樂庫還沒有歌。加歌之後就能用 /play 點播。');
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
      .setPlaceholder('勾選要加入的歌（可以多選）')
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
    ? `只列出前 ${LOCAL_MULTI_SELECT_LIMIT} 首，其他的歌請用 /play 打歌名點。`
    : null;

  const message = await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(C.MUSIC)
        .setTitle('📂 從音樂庫選多首')
        .setDescription(noteText)
    ],
    components: [selectRow, cancelRow],
  }).catch(() => null);

  if (!message) return;

  // ★ 沿用既有的殭屍互動防護標記（與 _handleOnlineSearch 一致）
  activeSearchMessages.set(message.id, interaction.user.id);

  let selection;
  try {
    selection = await message.awaitMessageComponent({
      filter: i => i.user.id === interaction.user.id &&
                   (i.customId === 'lm_pick' || i.customId === 'lm_cancel'),
      time: 60_000,
    });
  } catch {
    return interaction.editReply({
      content: '⌛ 超過 60 秒沒選，這次選擇已經過期。請重新用 /play 選歌。',
      embeds: [], components: [],
    }).catch(() => {});
  } finally {
    activeSearchMessages.delete(message.id);
  }

  if (selection.customId === 'lm_cancel') {
    return selection.update({ content: '已取消選擇。', embeds: [], components: [] });
  }

  const pickedFiles = selection.values
    .map(v => displayFiles[Number(v)])
    .filter(Boolean);

  await selection.update({
    embeds: [
      new EmbedBuilder().setColor(C.NEUTRAL).setDescription(`➕ 正在加入 ${pickedFiles.length} 首…`)
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
    .setColor(C.MUSIC)
    .setTitle('📂 已把選的歌加入佇列')
    .addFields(
      { name: '✅ 加入數量', value: `${addedCount} 首`, inline: true },
      { name: '📄 曲目清單', value: previewLines },
    )
    .setFooter({ text: `由 ${interaction.user.tag} 加入` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], components: [] });
  await updateControlPanel(guildId, interaction.channel);
  logger.success('UnifiedQueue', `localMulti: ${addedCount} 首已加入佇列 (${guildId})`);
}

module.exports = {
  _handlePlayAll,
  _handleLocalMultiSelect
};
