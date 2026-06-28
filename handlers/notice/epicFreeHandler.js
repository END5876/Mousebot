const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');

// ── 常數設定 ──────────────────────────────────────────────
const MAX_DESC_LENGTH = 250;
const MAX_GAMES_PER_REPLY = 10;
const MAX_AGE_DAYS = 90;
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 分鐘檢查一次
const LOG_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ── 資料存檔設定 ──────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const NOTIFIED_FILE = path.join(DATA_DIR, 'epicnotified.json');
const CONFIG_FILE   = path.join(DATA_DIR, 'epicchannel.json');

let notifiedGames    = new Map();
let notifyChannelIds = [];

// ── 讀取已通知清單 ────────────────────────────────────────
if (fs.existsSync(NOTIFIED_FILE)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(NOTIFIED_FILE, 'utf8'));
    if (Array.isArray(parsed) && Array.isArray(parsed[0])) {
      notifiedGames = new Map(parsed);
    } else if (Array.isArray(parsed)) {
      parsed.forEach(id => notifiedGames.set(id, Date.now()));
    }
    console.log(`[EpicFree] 已載入 ${notifiedGames.size} 筆通知記錄`);
  } catch (e) {
    console.error('⚠️ [EpicFree] 讀取已通知清單失敗:', e.message);
  }
}

// ── 讀取頻道設定 ──────────────────────────────────────────
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (Array.isArray(config.channelIds)) {
      notifyChannelIds = config.channelIds;
    } else if (config.channelId) {
      notifyChannelIds = [config.channelId];
    }
    if (notifyChannelIds.length > 0)
      console.log(`[EpicFree] 已載入 ${notifyChannelIds.length} 個通知頻道`);
  } catch (e) {
    console.error('⚠️ [EpicFree] 讀取頻道設定失敗:', e.message);
  }
}

// ── 儲存頻道設定 ──────────────────────────────────────────
function saveChannelConfig() {
  fs.writeFile(CONFIG_FILE, JSON.stringify({ channelIds: notifyChannelIds }, null, 2), (e) => {
    if (e) console.error('⚠️ [EpicFree] 儲存頻道設定失敗:', e.message);
  });
}

// ── 儲存已通知清單 ────────────────────────────────────────
function saveNotifiedGames() {
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  for (const [id, timestamp] of notifiedGames) {
    if (timestamp < cutoff) notifiedGames.delete(id);
  }
  fs.writeFile(NOTIFIED_FILE, JSON.stringify([...notifiedGames]), (e) => {
    if (e) console.error('⚠️ [EpicFree] 儲存已通知清單失敗:', e.message);
  });
}

// ── HTTP GET 封裝（含 Retry） ─────────────────────────────
async function fetchJson(url, retries = 3, delayMs = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'MouseBot/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      console.warn(`⚠️ [EpicFree] 請求失敗，${delayMs / 1000}s 後重試，剩餘 ${retries - i - 1} 次`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ── 取得 Epic 限免遊戲清單 (官方 API) ──────────────────────
async function getEpicFreeGames() {
  try {
    // 呼叫 Epic 官方 GraphQL 轉換的 REST API，直接指定台灣與繁體中文
    const url = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=zh-Hant&country=TW&allowCountries=TW';
    const data = await fetchJson(url);
    
    const elements = data?.data?.Catalog?.searchStore?.elements;
    if (!Array.isArray(elements)) {
      console.warn('[EpicFree] ⚠️ API 回傳格式異常，elements 非陣列，實際結構:', JSON.stringify(data)?.slice(0, 200));
      return [];
    }

    console.log(`[EpicFree] 取得 ${elements.length} 個 elements，開始篩選...`);
    const freeGames = [];
    const now = new Date();

    for (const game of elements) {
      // 尋找當前有效的促銷活動
      const promos = game.promotions?.promotionalOffers?.[0]?.promotionalOffers;
      if (!promos || promos.length === 0) continue;

      const promo = promos[0];
      const startDate = new Date(promo.startDate);
      const endDate = new Date(promo.endDate);

      // ── Bug 修正：discountPrice 可能為 null（而非 0），嚴格 === 0 會漏掉這類遊戲
      const discountPrice = game.price?.totalPrice?.discountPrice;
      const isInWindow   = now >= startDate && now < endDate;
      const isFree       = discountPrice === 0 || discountPrice === null;

      if (!isInWindow || !isFree) {
        console.log(`[EpicFree] 略過 "${game.title}" — 時間內: ${isInWindow}, 免費: ${isFree} (discountPrice: ${discountPrice})`);
        continue;
      }

      // 處理遊戲敘述過長
      let finalDesc = game.description || '快去 Epic Games 領取！';
      if (finalDesc.length > MAX_DESC_LENGTH) finalDesc = finalDesc.substring(0, MAX_DESC_LENGTH) + '...';

      // 取得原價
      const originalPrice = game.price?.totalPrice?.fmtPrice?.originalPrice || '未知';

      // 取得高品質圖片 (優先拿 OfferImageWide，其次 Thumbnail)
      const imageObj = game.keyImages?.find(img => img.type === 'OfferImageWide')
                    ?? game.keyImages?.find(img => img.type === 'Thumbnail');
      const image = imageObj?.url ?? '';

      // 組合 Epic 商店連結 (嘗試多種 slug 來源)
      const slug = game.catalogNs?.mappings?.[0]?.pageSlug
                ?? game.offerMappings?.[0]?.pageSlug
                ?? game.productSlug
                ?? game.urlSlug;
      const storeUrl = slug
        ? `https://store.epicgames.com/zh-Hant/p/${slug}`
        : 'https://store.epicgames.com/zh-Hant/free-games';

      // ── Bug 修正：game.id 若為 undefined 會導致所有遊戲共用同一個 Map key
      const gameId = game.id ?? `${game.title}::${promo.endDate}`;

      freeGames.push({
        id: gameId,
        name: game.title,
        originalPrice,
        url: storeUrl,
        image,
        description: finalDesc,
        endDate: promo.endDate,
        platforms: 'PC, Epic Games',
      });
    }

    console.log(`[EpicFree] 篩選完成，共找到 ${freeGames.length} 款限免遊戲`);
    return freeGames;
  } catch (e) {
    console.error('⚠️ [EpicFree] 獲取 Epic 限免遊戲失敗:', e.message);
    return [];
  }
}

// ── 建立 Embed 與按鈕 ─────────────────────────────────────
function buildMessage(game) {
  let endDateDisplay = '未知 / 隨時結束';
  
  if (game.endDate) {
    const dateObj = new Date(game.endDate);
    const endTimestamp = Math.floor(dateObj.getTime() / 1000);
    
    if (!isNaN(endTimestamp)) {
      // 手動提取年、月、日來固定格式，避免 Discord 自動排版走鐘
      const y = dateObj.getFullYear();
      const m = dateObj.getMonth() + 1;
      const d = dateObj.getDate();
      
      // 組合：固定日期字串 + Discord 動態倒數標籤
      endDateDisplay = `${y}年${m}月${d}日 (<t:${endTimestamp}:R>)`;
    }
  }

  const priceText = game.originalPrice !== '未知' ? `~~${game.originalPrice}~~` : '未知';

  const embed = new EmbedBuilder()
    .setAuthor({ name: 'Epic Games 限時免費', iconURL: 'https://img.icons8.com/ios-filled/512/epic-games.png' })
    .setTitle(game.name)
    .setURL(game.url)
    .setDescription(game.description)
    .setColor(0xFFFFFF) // Epic 的品牌色系（深灰色，深色主題下清晰可見）
    .addFields(
      { name: '💰 價格資訊', value: `${priceText} ➔ **免費**`, inline: true },
      { name: '🎮 支援平台', value: game.platforms, inline: true },
      { name: '⏳ 截止時間', value: endDateDisplay, inline: false }
    )
    .setImage(game.image)
    .setTimestamp()
    .setFooter({ text: 'Epic 乞丐超人 · Mousebot' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('🔗 前往 Epic 領取').setURL(game.url).setStyle(ButtonStyle.Link)
  );

  return { embeds: [embed], components: [row] };
}

// ── 主要 Setup 函式 ────────────────────────────────────────
function setupEpicFreeNotifier(client) {

  // ── 指令 1：/epicfree ────────────────────────────────
  const epicfreeCommand = {
    data: new SlashCommandBuilder()
      .setName('epicfree')
      .setDescription('立即查詢目前 Epic Games 限免遊戲'),
    async execute(interaction) {
      await interaction.deferReply();
      try {
        const games = await getEpicFreeGames();
        if (games.length === 0) return interaction.editReply('😔 目前沒有偵測到 Epic 限免遊戲。');

        const displayGames = games.slice(0, MAX_GAMES_PER_REPLY);
        await interaction.editReply(
          `✅ 找到 **${games.length}** 款限免遊戲！` +
          (games.length > MAX_GAMES_PER_REPLY ? `（僅顯示前 ${MAX_GAMES_PER_REPLY} 款）` : '')
        );
        for (const game of displayGames) await interaction.followUp(buildMessage(game));
      } catch (err) {
        console.error('⚠️ [EpicFree] /epicfree 指令執行失敗:', err.message);
        await interaction.editReply('❌ 查詢時發生錯誤，請稍後再試。').catch(() => {});
      }
    }
  };

  // ── 指令 2：/setepicchannel ──────────────────────────
  const setChannelCommand = {
    data: new SlashCommandBuilder()
      .setName('setepicchannel')
      .setDescription('管理 Epic 限免通知頻道')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption(option =>
        option.setName('action')
          .setDescription('要執行的操作')
          .setRequired(true)
          .addChoices(
            { name: '➕ 新增頻道', value: 'add' },
            { name: '➖ 移除頻道', value: 'remove' },
            { name: '📋 查看清單', value: 'list' },
            { name: '🗑️ 清除全部', value: 'clear' },
          )
      )
      .addChannelOption(option =>
        option.setName('channel')
          .setDescription('選擇頻道（新增/移除時必填）')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false)
      ),

    async execute(interaction) {
      const action  = interaction.options.getString('action');
      const channel = interaction.options.getChannel('channel');

      if (action === 'add') {
        if (!channel) return interaction.reply({ content: '❌ 請選擇要新增的頻道！', flags: MessageFlags.Ephemeral });
        if (notifyChannelIds.includes(channel.id)) return interaction.reply({ content: `⚠️ ${channel} 已經在通知清單中了！`, flags: MessageFlags.Ephemeral });
        notifyChannelIds.push(channel.id);
        saveChannelConfig();
        return interaction.reply({ content: `✅ 已新增 ${channel} 為 Epic 限免通知頻道！\n目前共 **${notifyChannelIds.length}** 個頻道。`, flags: MessageFlags.Ephemeral });
      }

      if (action === 'remove') {
        if (!channel) return interaction.reply({ content: '❌ 請選擇要移除的頻道！', flags: MessageFlags.Ephemeral });
        const index = notifyChannelIds.indexOf(channel.id);
        if (index === -1) return interaction.reply({ content: `⚠️ ${channel} 不在通知清單中！`, flags: MessageFlags.Ephemeral });
        notifyChannelIds.splice(index, 1);
        saveChannelConfig();
        return interaction.reply({ content: `✅ 已將 ${channel} 從通知清單移除！\n目前剩 **${notifyChannelIds.length}** 個頻道。`, flags: MessageFlags.Ephemeral });
      }

      if (action === 'list') {
        if (notifyChannelIds.length === 0) return interaction.reply({ content: '📋 目前沒有設定任何通知頻道。', flags: MessageFlags.Ephemeral });
        const lines = notifyChannelIds.map((id, i) => `${i + 1}. <#${id}> (\`${id}\`)`).join('\n');
        return interaction.reply({ content: `📋 **Epic 限免通知頻道清單（共 ${notifyChannelIds.length} 個）**\n${lines}`, flags: MessageFlags.Ephemeral });
      }

      if (action === 'clear') {
        const count = notifyChannelIds.length;
        notifyChannelIds = [];
        saveChannelConfig();
        return interaction.reply({ content: `🗑️ 已清除全部 **${count}** 個通知頻道設定。`, flags: MessageFlags.Ephemeral });
      }
    }
  };

  // 註冊指令
  client.commands.set(epicfreeCommand.data.name, epicfreeCommand);
  client.commands.set(setChannelCommand.data.name, setChannelCommand);

  // ── 定時檢查並發送通知 ────────────────────────────────
  let lastLogTime = 0;
  async function checkAndNotify() {
    if (notifyChannelIds.length === 0) return;

    const now = Date.now();
    if (now - lastLogTime >= LOG_INTERVAL_MS) {
      lastLogTime = now;
      console.log(`[EpicFree] 定時檢查中... (${new Date().toLocaleString('zh-TW')})`);
    }

    const channels = (
      await Promise.all(
        notifyChannelIds.map(id =>
          client.channels.cache.get(id) || client.channels.fetch(id).catch(() => null)
        )
      )
    ).filter(Boolean);

    if (channels.length === 0)
      return console.error('⚠️ [EpicFree] 所有設定的頻道均無法存取，跳過本次檢查');

    const games = await getEpicFreeGames();
    let needsSave = false;

    for (const game of games) {
      if (notifiedGames.has(game.id)) continue;

      notifiedGames.set(game.id, Date.now());
      needsSave = true;

      const results = await Promise.allSettled(
        channels.map(ch => ch.send(buildMessage(game)))
      );

      results.forEach((result, i) => {
        if (result.status === 'fulfilled') {
          console.log(`[EpicFree] ✅ 已通知 #${channels[i].name}：${game.name}`);
        } else {
          console.error(`⚠️ [EpicFree] 發送至 #${channels[i].name} 失敗:`, result.reason?.message);
        }
      });
    }

    if (needsSave) saveNotifiedGames();
  }

  client.once('clientReady', () => {
    console.log(`[EpicFree] Bot 啟動時間：${new Date().toLocaleString('zh-TW')}`);
    if (notifyChannelIds.length === 0) {
      console.warn('⚠️ [EpicFree] 尚未設定通知頻道，請使用 /setepicchannel add 來新增。');
    } else {
      console.log(`✅ Epic 限免通知已啟用（${notifyChannelIds.length} 個頻道，每 30 分鐘檢查）`);
    }
    checkAndNotify().catch(err => console.error('⚠️ [EpicFree] 啟動時檢查失敗:', err.message));
    setInterval(() => checkAndNotify().catch(err => console.error('⚠️ [EpicFree] 定時任務發生錯誤:', err.message)), CHECK_INTERVAL_MS);
  });
}

module.exports = { setupEpicFreeNotifier };