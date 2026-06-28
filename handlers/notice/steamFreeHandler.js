const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');

// ── 常數設定 ──────────────────────────────────────────────
const MAX_DESC_LENGTH = 250;
const MAX_GAMES_PER_REPLY = 10;
const MAX_AGE_DAYS = 90;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const LOG_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ── 資料存檔設定 ──────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const NOTIFIED_FILE = path.join(DATA_DIR, 'steamnotified.json');
const CONFIG_FILE   = path.join(DATA_DIR, 'steamchannel.json');

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
    console.log(`[SteamFree] 已載入 ${notifiedGames.size} 筆通知記錄`);
  } catch (e) {
    console.error('⚠️ [SteamFree] 讀取已通知清單失敗:', e.message);
  }
}

// ── 讀取頻道設定 ──────────────────────────────────────────
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    // 兼容舊版單頻道格式 { channelId: "..." }
    if (Array.isArray(config.channelIds)) {
      notifyChannelIds = config.channelIds;
    } else if (config.channelId) {
      notifyChannelIds = [config.channelId];
    }
    if (notifyChannelIds.length > 0)
      console.log(`[SteamFree] 已載入 ${notifyChannelIds.length} 個通知頻道`);
  } catch (e) {
    console.error('⚠️ [SteamFree] 讀取頻道設定失敗:', e.message);
  }
}
// ↑ 移除了 else if (process.env.STEAM_NOTIFY_CHANNEL_ID) 的 fallback

// ── 儲存頻道設定 ──────────────────────────────────────────
function saveChannelConfig() {
  fs.writeFile(CONFIG_FILE, JSON.stringify({ channelIds: notifyChannelIds }, null, 2), (e) => {
    if (e) console.error('⚠️ [SteamFree] 儲存頻道設定失敗:', e.message);
  });
}

// ── 儲存已通知清單 ────────────────────────────────────────
function saveNotifiedGames() {
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  for (const [id, timestamp] of notifiedGames) {
    if (timestamp < cutoff) notifiedGames.delete(id);
  }
  fs.writeFile(NOTIFIED_FILE, JSON.stringify([...notifiedGames]), (e) => {
    if (e) console.error('⚠️ [SteamFree] 儲存已通知清單失敗:', e.message);
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
      console.warn(`⚠️ [SteamFree] 請求失敗，${delayMs / 1000}s 後重試，剩餘 ${retries - i - 1} 次`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ── 取得最終落地 URL ──────────────────────────────────────
async function getFinalUrl(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'MouseBot/1.0' } });
    return res.url;
  } catch {
    return url;
  }
}

// ── 從 URL 擷取 Steam AppID ───────────────────────────────
const extractSteamAppId = (url = '') => url.match(/store\.steampowered\.com\/app\/(\d+)/)?.[1] || null;

// ── 查詢 Steam 台灣區域完整資訊 ──────────────────────────
async function getSteamTWInfo(steamAppId) {
  if (!steamAppId) return {};
  try {
    const data = await fetchJson(`https://store.steampowered.com/api/appdetails?appids=${steamAppId}&cc=TW&l=tchinese`);
    const gameData = data?.[steamAppId]?.data;
    if (!gameData) return {};

    let description = gameData.short_description?.trim();
    if (description?.length > MAX_DESC_LENGTH)
      description = description.substring(0, MAX_DESC_LENGTH) + '...';

    return {
      name: gameData.name?.trim() || null,
      price: gameData.price_overview ? `NT$${(gameData.price_overview.initial / 100).toFixed(0)}` : null,
      description: description || null
    };
  } catch (e) {
    console.warn(`⚠️ [SteamFree] 查詢 Steam 台灣資訊失敗 (AppID: ${steamAppId}):`, e.message);
    return {};
  }
}

// ── 取得 Steam 限免遊戲清單 ───────────────────────────────
async function getSteamFreeGames() {
  try {
    const data = await fetchJson('https://www.gamerpower.com/api/giveaways?platform=steam');
    if (!Array.isArray(data)) return [];

    const freeGames = data.filter(game => game.type === 'Game');
    const games = [];

    for (const game of freeGames) {
      const resolvedUrl = await getFinalUrl(game.open_giveaway_url);
      const steamAppId  = extractSteamAppId(resolvedUrl);
      const steamUrl    = steamAppId ? `https://store.steampowered.com/app/${steamAppId}/` : game.open_giveaway_url;
      const twInfo      = await getSteamTWInfo(steamAppId);

      let finalDesc = twInfo.description ?? game.description ?? '快去 Steam 領取！';
      if (finalDesc.length > MAX_DESC_LENGTH) finalDesc = finalDesc.substring(0, MAX_DESC_LENGTH) + '...';

      games.push({
        appid: game.id, steamAppId,
        name: twInfo.name ?? game.title,
        isSteamName: !!twInfo.name,
        originalPrice: twInfo.price ?? (game.worth === 'N/A' ? '未知' : game.worth),
        isTWPrice: !!twInfo.price,
        url: steamUrl,
        image: game.image || '',
        description: finalDesc,
        isTWDesc: !!twInfo.description,
        endDate: game.end_date === 'N/A' ? '未知 / 隨時結束' : game.end_date,
        platforms: game.platforms || 'Steam',
      });
    }
    return games;
  } catch (e) {
    console.error('⚠️ [SteamFree] 獲取限免遊戲失敗（已耗盡重試次數）:', e.message);
    return [];
  }
}

// ── 建立 Embed 與按鈕 ─────────────────────────────────────
function buildMessage(game) {
  let endDateDisplay = game.endDate;
  if (!['未知 / 隨時結束', 'N/A'].includes(game.endDate)) {
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
    .setAuthor({ name: 'Steam 限時免費', iconURL: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Steam_icon_logo.svg/512px-Steam_icon_logo.svg.png' })
    .setTitle(game.name)
    .setURL(game.url)
    .setDescription(game.description)
    .setColor(0x43B581)
    .addFields(
      { name: '💰 價格資訊', value: `${priceText} ➔ **免費**`, inline: true },
      { name: '🎮 支援平台', value: game.platforms, inline: true },
      { name: '⏳ 截止時間', value: endDateDisplay, inline: false }
    )
    .setImage(game.image)
    .setTimestamp()
    .setFooter({ text: 'Steam 乞丐超人 · Mousebot' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('🔗 前往 Steam 領取').setURL(game.url).setStyle(ButtonStyle.Link)
  );

  return { embeds: [embed], components: [row] };
}

// ── 主要 Setup 函式 ────────────────────────────────────────
function setupSteamFreeNotifier(client) {

  // ── 指令 1：/steamfree ────────────────────────────────
  const steamfreeCommand = {
    data: new SlashCommandBuilder()
      .setName('steamfree')
      .setDescription('立即查詢目前 Steam 限免遊戲'),
    async execute(interaction) {
      await interaction.deferReply();
      try {
        const games = await getSteamFreeGames();
        if (games.length === 0) return interaction.editReply('😔 目前沒有偵測到限免遊戲。');

        const displayGames = games.slice(0, MAX_GAMES_PER_REPLY);
        await interaction.editReply(
          `✅ 找到 **${games.length}** 款限免遊戲！` +
          (games.length > MAX_GAMES_PER_REPLY ? `（僅顯示前 ${MAX_GAMES_PER_REPLY} 款）` : '')
        );
        for (const game of displayGames) await interaction.followUp(buildMessage(game));
      } catch (err) {
        console.error('⚠️ [SteamFree] /steamfree 指令執行失敗:', err.message);
        await interaction.editReply('❌ 查詢時發生錯誤，請稍後再試。').catch(() => {});
      }
    }
  };

  // ── 指令 2：/setsteamchannel ──────────────────────────
  const setChannelCommand = {
    data: new SlashCommandBuilder()
      .setName('setsteamchannel')
      .setDescription('管理 Steam 限免通知頻道')
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

      // ── add ──
      if (action === 'add') {
        if (!channel)
          return interaction.reply({ content: '❌ 請選擇要新增的頻道！', flags: MessageFlags.Ephemeral });
        if (notifyChannelIds.includes(channel.id))
          return interaction.reply({ content: `⚠️ ${channel} 已經在通知清單中了！`, flags: MessageFlags.Ephemeral });

        notifyChannelIds.push(channel.id);
        saveChannelConfig();
        return interaction.reply({
          content: `✅ 已新增 ${channel} 為 Steam 限免通知頻道！\n目前共 **${notifyChannelIds.length}** 個頻道。`,
          flags: MessageFlags.Ephemeral
        });
      }

      // ── remove ──
      if (action === 'remove') {
        if (!channel)
          return interaction.reply({ content: '❌ 請選擇要移除的頻道！', flags: MessageFlags.Ephemeral });

        const index = notifyChannelIds.indexOf(channel.id);
        if (index === -1)
          return interaction.reply({ content: `⚠️ ${channel} 不在通知清單中！`, flags: MessageFlags.Ephemeral });

        notifyChannelIds.splice(index, 1);
        saveChannelConfig();
        return interaction.reply({
          content: `✅ 已將 ${channel} 從通知清單移除！\n目前剩 **${notifyChannelIds.length}** 個頻道。`,
          flags: MessageFlags.Ephemeral
        });
      }

      // ── list ──
      if (action === 'list') {
        if (notifyChannelIds.length === 0)
          return interaction.reply({ content: '📋 目前沒有設定任何通知頻道。', flags: MessageFlags.Ephemeral });

        const lines = notifyChannelIds.map((id, i) => `${i + 1}. <#${id}> (\`${id}\`)`).join('\n');
        return interaction.reply({
          content: `📋 **Steam 限免通知頻道清單（共 ${notifyChannelIds.length} 個）**\n${lines}`,
          flags: MessageFlags.Ephemeral
        });
      }

      // ── clear ──
      if (action === 'clear') {
        const count = notifyChannelIds.length;
        notifyChannelIds = [];
        saveChannelConfig();
        return interaction.reply({
          content: `🗑️ 已清除全部 **${count}** 個通知頻道設定。`,
          flags: MessageFlags.Ephemeral
        });
      }
    }
  };

  // 註冊指令
  client.commands.set(steamfreeCommand.data.name, steamfreeCommand);
  client.commands.set(setChannelCommand.data.name, setChannelCommand);

  // ── 定時檢查並發送通知 ────────────────────────────────
  let lastLogTime = 0;
  async function checkAndNotify() {
    if (notifyChannelIds.length === 0) return;

    const now = Date.now();
    if (now - lastLogTime >= LOG_INTERVAL_MS) {
      lastLogTime = now;
      console.log(`[SteamFree] 定時檢查中... (${new Date().toLocaleString('zh-TW')})`);
    }

    const channels = (
      await Promise.all(
        notifyChannelIds.map(id =>
          client.channels.cache.get(id) || client.channels.fetch(id).catch(() => null)
        )
      )
    ).filter(Boolean);

    if (channels.length === 0)
      return console.error('⚠️ [SteamFree] 所有設定的頻道均無法存取，跳過本次檢查');

    const games = await getSteamFreeGames();
    let needsSave = false;

    for (const game of games) {
      if (notifiedGames.has(game.appid)) continue;

      notifiedGames.set(game.appid, Date.now());
      needsSave = true;

      const results = await Promise.allSettled(
        channels.map(ch => ch.send(buildMessage(game)))
      );

      results.forEach((result, i) => {
        if (result.status === 'fulfilled') {
          console.log(`[SteamFree] ✅ 已通知 #${channels[i].name}：${game.name}`);
        } else {
          console.error(`⚠️ [SteamFree] 發送至 #${channels[i].name} 失敗:`, result.reason?.message);
        }
      });
    }

    if (needsSave) saveNotifiedGames();
  }

  client.once('clientReady', () => {
    console.log(`[SteamFree] Bot 啟動時間：${new Date().toLocaleString('zh-TW')}`);
    if (notifyChannelIds.length === 0) {
      console.warn('⚠️ [SteamFree] 尚未設定通知頻道，請使用 /setsteamchannel add 來新增。');
    } else {
      console.log(`✅ Steam 限免通知已啟用（${notifyChannelIds.length} 個頻道，每 30 分鐘檢查）`);
    }
    checkAndNotify().catch(err => console.error('⚠️ [SteamFree] 啟動時檢查失敗:', err.message));
    setInterval(() => checkAndNotify().catch(err => console.error('⚠️ [SteamFree] 定時任務發生錯誤:', err.message)), CHECK_INTERVAL_MS);
  });
}

module.exports = { setupSteamFreeNotifier };