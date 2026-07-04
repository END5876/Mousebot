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
const voiceMonitor = require('../voiceActivityMonitor'); // ★ 修改 1：新增 import

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

    // ★ 修改 2：加入 youtu.be 短網址判斷
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

  // ★ 修改 3：editReply 直接取回傳值，消除 editReply + fetchReply 的競態
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

  // ★ 修改 4：使用者主動下 /play，視為頻道仍活躍，重置靜音計時
  voiceMonitor.touchActivity(guildId);

  if (input === '__ALL_LOCAL__') {
    return _handlePlayAll(interaction, shuffleOpt);
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

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x1DB954)
          .setDescription('🔍 正在獲取影片資訊...')
      ]
    });

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
//
//  Discord Autocomplete 有 3 秒硬性回應上限（無法 deferReply），
//  而 yt-dlp 單次搜尋正常約 1~5 秒，因此這裡做三層保護：
//    1. 快取（30 秒 TTL）：同關鍵字重複查詢直接吃快取，零延遲。
//    2. 併發合併（in-flight dedupe）：同一關鍵字若已有搜尋在跑，
//       不重複 spawn，直接共用同一個 Promise。
//    3. 搶時間（Promise.race，2 秒）：搜尋逾時就先回傳 null，
//       由呼叫端改顯示「保底選項」（沿用送出後搜尋的舊流程），
//       絕不讓 Discord 端等到逾時顯示錯誤。
//       被丟下的 yt-dlp 進程仍會在背景跑完並補進快取，
//       供使用者下一次按鍵時直接命中。
// ════════════════════════════════════════════════════════
const AC_MIN_KEYWORD_LEN   = 2;
const AC_SEARCH_TIMEOUT_MS = 2000;
const AC_CACHE_TTL_MS      = 30_000;
const AC_RESULT_LIMIT      = 5;

const _acCache    = new Map(); // keyword(lowercase) -> { results, timestamp }
const _acInFlight = new Map(); // keyword(lowercase) -> Promise

// ★ 修改 5：定期清掃過期快取，避免記憶體無限累積
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
    // searchMulti 已改為同時搜尋 YouTube + Bilibili，各取 AC_RESULT_LIMIT 筆
    inflight = engine.searchMulti(keyword, AC_RESULT_LIMIT)
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

  const fileChoices = localEngine
    ? localEngine.getMusicFiles()
        .filter(f =>
          f.name.toLowerCase().includes(focused) ||
          f.filename.toLowerCase().includes(focused)
        )
        .slice(0, 24)
        .map(f => ({
          name : `📁 ${f.name}`.slice(0, 100),   // ★ 修正：補上截斷
          value: f.filename.slice(0, 100),        // ★ 修正：補上截斷
        }))
    : [];

  // 空白輸入：只顯示本地清單，不觸發線上搜尋
  if (focused.trim() === '') {
    const choices = [ALL_LOCAL_CHOICE, ...fileChoices];
    interaction.respond(choices.slice(0, 25)).catch(() => {});
    return true;
  }

  // 保底：一定會顯示的「送出後搜尋」選項，即時搜尋失敗/逾時時墊底用
  const fallbackSearchChoice = {
    name : `🔍 搜尋線上：「${focusedRaw}」（YouTube + Bilibili）`,
    value: (SEARCH_MARKER + focusedRaw).slice(0, 100),
  };

  // 關鍵字太短不觸發即時搜尋，避免單字查詢意義不大又浪費資源
  const onlineEngine = _engines.bilibili; // bilibili engine 同時處理 YouTube + Bilibili
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
    // searchMulti 回傳 YouTube 前 5 筆 + Bilibili 前 5 筆
    const onlineChoices = cached.map(r => ({
      name : `${r.platform === 'YouTube' ? '🎬' : '📺'} ${r.title} · ${r.author} (${r.duration})`.slice(0, 100),
      value: r.url.slice(0, 100),
    }));
    const choices = [...fileChoices, ...onlineChoices, fallbackSearchChoice];
    interaction.respond(choices.slice(0, 25)).catch(() => {});
    return true;
  }

  // 沒快取，搶時間即時查詢（YouTube + Bilibili 各前 5 筆）
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