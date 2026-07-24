// handlers/unifiedQueue/search.js
// 統一佇列 — /play 核心邏輯、網址清理、全部本地音樂、線上搜尋（YouTube）、即時 Autocomplete

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const { _engines, SEARCH_MARKER, activeSearchMessages } = require('./state');
const { enqueue, ensureConnection, updateControlPanel } = require('./playback');
const voiceMonitor = require('../voiceActivityMonitor');

// ════════════════════════════════════════════════════════
//  時長格式化（與 onlineMusicHandler.js 的邏輯保持一致）
// ════════════════════════════════════════════════════════
function _formatDuration(seconds) {
  if (!seconds) return '未知';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

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

async function _handleLocalMultiSelect(interaction) {
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

// ════════════════════════════════════════════════════════
//  網址清理工具 (URL Cleaning)
// ════════════════════════════════════════════════════════
function cleanUrl(rawUrl) {
  try {
    const urlObj = new URL(rawUrl);

    if (urlObj.hostname.includes('bilibili.com')) {
      const p = urlObj.searchParams.get('p');
      urlObj.search = '';
      if (p) urlObj.searchParams.set('p', p);
      return urlObj.toString();
    }

    if (urlObj.hostname.includes('youtube.com') || urlObj.hostname === 'youtu.be') {
      urlObj.searchParams.delete('list');
      urlObj.searchParams.delete('index');
      urlObj.searchParams.delete('start_radio');
      urlObj.searchParams.delete('rv');
      urlObj.searchParams.delete('feature');
      return urlObj.toString();
    }

    return rawUrl;
  } catch (error) {
    return rawUrl;
  }
}

// ════════════════════════════════════════════════════════
//  將 flat-playlist 條目解析為可直接 getInfo() 的完整網址
// ════════════════════════════════════════════════════════
function _resolveEntryUrl(baseUrl, entry) {
  if (entry.url && /^https?:\/\//i.test(entry.url)) return entry.url;
  if (entry.webpage_url) return entry.webpage_url;
  if (entry.id) return `https://www.youtube.com/watch?v=${entry.id}`;
  return baseUrl;
}

// ════════════════════════════════════════════════════════
//  播放清單詢問 UI（Button：全部加入 / 只加入第一首 / 取消）
//  風格與 commands.js 的 uq_skip / uq_stop 一致
// ════════════════════════════════════════════════════════
async function _askPlaylistChoice(interaction, playlistInfo) {
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
async function _handleAddPlaylist(interaction, baseUrl, playlistInfo, guildId) {
  const entries = playlistInfo.entries;
  let addedCount  = 0;
  let skippedCount = 0;

  for (const entry of entries) {
    const resolvedUrl = _resolveEntryUrl(baseUrl, entry);

    // 極少數情況 flat-playlist 條目連基本網址都解析不出來，跳過而非報錯中斷整批
    if (!resolvedUrl) {
      skippedCount++;
      continue;
    }

    const item = {
      url        : resolvedUrl,
      title      : entry.title || '未知標題',
      author     : entry.uploader || entry.channel || entry.creator || '未知作者',
      duration   : entry.duration ? _formatDuration(entry.duration) : '未知',
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

// ════════════════════════════════════════════════════════
//  共用的「已加入佇列 / 開始播放」回覆
// ════════════════════════════════════════════════════════
async function _replyPlayResult(interaction, item, result) {
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
    components: _buildSearchComponents(results),
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
  await _replyPlayResult(interaction, item, result);
}

// ════════════════════════════════════════════════════════
//  handlePlay（/play 核心邏輯）
// ════════════════════════════════════════════════════════
async function handlePlay(interaction, input, shuffleOpt = 'no') {
  const guildId = interaction.guildId;

  voiceMonitor.touchActivity(guildId);

  if (input === '__ALL_LOCAL__') {
    return _handlePlayAll(interaction, shuffleOpt);
  }

  if (input === '__LOCAL_MULTI__') {
    return _handleLocalMultiSelect(interaction);
  }

  let connection;
  try {
    connection = await ensureConnection(interaction);
  } catch {
    return interaction.editReply('❌ 加入語音頻道時發生錯誤');
  }
  if (!connection) return interaction.editReply('❌ 你必須先加入語音頻道！');

  if (input.startsWith(SEARCH_MARKER)) {
    const keyword = input.slice(SEARCH_MARKER.length).trim();
    if (!keyword) return interaction.editReply('❌ 搜尋關鍵字不可為空');
    return _handleOnlineSearch(interaction, keyword, guildId);
  }

  const cleanInput = cleanUrl(input);
  const isUrl = (() => { try { new URL(cleanInput); return true; } catch { return false; } })();

  let item;

  if (isUrl) {
    const engine = _engines.bilibili;
    if (!engine) return interaction.editReply('❌ 串流引擎未就緒');

    // 先偵測是否為播放清單
    // ★ 修正：改用 input（原始未清理網址），保留 list 參數才能正確偵測 YouTube 播放清單。
    //    getInfo 仍使用 cleanInput，因為 buildInfoArgs 已內建 --no-playlist，帶 list 參數也安全。
    let playlistInfo = null;
    if (typeof engine.checkPlaylist === 'function') {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x1DB954).setDescription('🔍 正在檢查網址類型...')]
      });
      try {
        playlistInfo = await engine.checkPlaylist(input);
      } catch {
        playlistInfo = null;
      }
    }

    if (playlistInfo && playlistInfo.isPlaylist) {
      const choice = await _askPlaylistChoice(interaction, playlistInfo);
      if (choice === 'cancel') return;
      if (choice === 'all') {
        // ★ 修正：baseUrl 同步改用 input，與上方 checkPlaylist(input) 保持一致
        return _handleAddPlaylist(interaction, input, playlistInfo, guildId);
      }
      // choice === 'first' → 繼續往下走，用單曲流程處理 cleanInput
    } else {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x1DB954).setDescription('🔍 正在獲取影片資訊...')]
      });
    }

    try {
      item = await engine.getInfo(cleanInput);
      item.type = 'bilibili';
    } catch (err) {
      return interaction.editReply(`❌ 無法獲取影片資訊：${err.message}`);
    }
  } else {

    const localEngine = _engines.local;
    const localItem = localEngine ? localEngine.getTrackInfo(input) : null;

    if (localItem) {
      item = localItem;
      item.type = 'local';
    } else {
      return _handleOnlineSearch(interaction, input, guildId);
    }
  }

  const result = await enqueue(guildId, item, interaction.channel);
  await _replyPlayResult(interaction, item, result);
}

// ════════════════════════════════════════════════════════
//  即時線上搜尋（Autocomplete 用）— 節流 + 快取 + 搶時間
// ════════════════════════════════════════════════════════
const AC_MIN_KEYWORD_LEN   = 2;
const AC_SEARCH_TIMEOUT_MS = 2000;
const AC_CACHE_TTL_MS      = 30_000;
const AC_RESULT_LIMIT      = 5;

const _acCache    = new Map(); // keyword(lowercase) -> { results, timestamp }
const _acInFlight = new Map(); // keyword(lowercase) -> Promise

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _acCache) {
    if (now - entry.timestamp >= AC_CACHE_TTL_MS) {
      _acCache.delete(key);
    }
  }
}, AC_CACHE_TTL_MS);

function _getAcCached(keyword) {
  const hit = _acCache.get(keyword);
  if (hit && Date.now() - hit.timestamp < AC_CACHE_TTL_MS) return hit.results;
  return null;
}

function _raceOnlineSearch(engine, keyword) {
  const key = keyword.toLowerCase();

  let inflight = _acInFlight.get(key);
  if (!inflight) {
    // 第 3 參數 true      = fast 模式（YouTube 走 flat-playlist 加速）
    // 第 4 參數 ['youtube'] = 只搜尋 YouTube，移除 Bilibili
    inflight = engine.searchMulti(keyword, AC_RESULT_LIMIT, true, ['youtube'])
      .then(results => {
        _acCache.set(key, { results, timestamp: Date.now() });
        return results;
      })
      .catch(() => [])
      .finally(() => { _acInFlight.delete(key); });
    _acInFlight.set(key, inflight);
  }

  const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), AC_SEARCH_TIMEOUT_MS));
  return Promise.race([inflight, timeoutPromise]);
}

// ════════════════════════════════════════════════════════
//  Autocomplete（即時顯示，可直接選歌）
// ════════════════════════════════════════════════════════
async function handleAutocomplete(interaction) {
  if (interaction.commandName !== 'play') return false;

  const focusedRaw = interaction.options.getFocused();
  const focused = focusedRaw.toLowerCase();

  // 網址不做任何建議
  if (focused.startsWith('http')) {
    interaction.respond([]).catch(() => {});
    return true;
  }

  const localEngine = _engines.local;

  const ALL_LOCAL_CHOICE = {
    name: '📂 ▶ 全部本地音樂（一次加入所有檔案）',
    value: '__ALL_LOCAL__',
  };

  const MULTI_LOCAL_CHOICE = {
    name: '📂✅ 選擇多首本地音樂（勾選加入）',
    value: '__LOCAL_MULTI__',
  };

  const fileChoices = localEngine
    ? localEngine.getMusicFiles()
        .filter(f =>
          f.name.toLowerCase().includes(focused) ||
          f.filename.toLowerCase().includes(focused)
        )
        .slice(0, 23)
        .map(f => ({
          name : `📁 ${f.name}`.slice(0, 100),
          value: f.filename.slice(0, 100),
        }))
    : [];

  // 空白輸入：只顯示本地清單，不觸發線上搜尋
  if (focused.trim() === '') {
    const choices = [ALL_LOCAL_CHOICE, MULTI_LOCAL_CHOICE, ...fileChoices];
    interaction.respond(choices.slice(0, 25)).catch(() => {});
    return true;
  }

  // 保底：一定會顯示的「送出後搜尋」選項，即時搜尋失敗/逾時時墊底用
  const fallbackSearchChoice = {
    name : `🔍 搜尋線上：「${focusedRaw}」（YouTube + Bilibili）`,
    value: (SEARCH_MARKER + focusedRaw).slice(0, 100),
  };

  // 關鍵字太短不觸發即時搜尋
  const onlineEngine = _engines.bilibili;
  if (focused.trim().length < AC_MIN_KEYWORD_LEN || !onlineEngine) {
    const choices = fileChoices.length > 0
      ? [...fileChoices, fallbackSearchChoice]
      : [fallbackSearchChoice, ...fileChoices];
    interaction.respond(choices.slice(0, 25)).catch(() => {});
    return true;
  }

  // 先看快取，命中就直接回傳，零延遲
  const cached = _getAcCached(focused);
  if (cached) {
    const onlineChoices = cached.map(r => ({
      name : `${r.platform === 'YouTube' ? '🎬' : '📺'} ${r.title} · ${r.author} (${r.duration})`.slice(0, 100),
      value: r.url.slice(0, 100),
    }));
    const choices = [...fileChoices, ...onlineChoices, fallbackSearchChoice];
    interaction.respond(choices.slice(0, 25)).catch(() => {});
    return true;
  }

  // 沒快取，搶時間即時查詢
  let onlineResults = null;
  try {
    onlineResults = await _raceOnlineSearch(onlineEngine, focusedRaw.trim());
  } catch {
    onlineResults = null;
  }

  if (onlineResults && onlineResults.length > 0) {
    const onlineChoices = onlineResults.map(r => ({
      name : `${r.platform === 'YouTube' ? '🎬' : '📺'} ${r.title} · ${r.author} (${r.duration})`.slice(0, 100),
      value: r.url.slice(0, 100),
    }));
    const choices = [...fileChoices, ...onlineChoices, fallbackSearchChoice];
    interaction.respond(choices.slice(0, 25)).catch(() => {});
    return true;
  }

  // 搜尋逾時 / 失敗 / 無結果 → 顯示保底選項，不讓使用者卡住
  const choices = fileChoices.length > 0
    ? [...fileChoices, fallbackSearchChoice]
    : [fallbackSearchChoice, ...fileChoices];
  interaction.respond(choices.slice(0, 25)).catch(() => {});
  return true;
}

module.exports = {
  handlePlay,
  handleAutocomplete,
};