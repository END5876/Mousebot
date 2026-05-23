const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');

// ── 常數設定 ──────────────────────────────────────────────
const MAX_DESC_LENGTH = 250;
const MAX_GAMES_PER_REPLY = 10;
const MAX_AGE_DAYS = 90;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const LOG_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ── 已通知過的 AppID 存檔設定 ────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const NOTIFIED_FILE = path.join(DATA_DIR, 'steamnotified.json');

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

function saveNotifiedGames() {
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  for (const [id, timestamp] of notifiedGames) {
    if (timestamp < cutoff) notifiedGames.delete(id);
  }
  fs.writeFile(NOTIFIED_FILE, JSON.stringify([...notifiedGames]), (e) => {
    if (e) console.error('⚠️ [SteamFree] 儲存已通知清單失敗:', e.message);
  });
}

// ── HTTP GET 封裝（含 Retry，需 Node.js 18+）─────────────
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

// ── 取得最終落地 URL (利用 fetch 自動跟隨 Redirect) ────────
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

// ── 查詢 Steam 台灣區域完整資訊（名稱 + 描述 + 價格）────────
async function getSteamTWInfo(steamAppId) {
  if (!steamAppId) return {};
  try {
    const data = await fetchJson(`https://store.steampowered.com/api/appdetails?appids=${steamAppId}&cc=TW&l=tchinese`);
    const gameData = data?.[steamAppId]?.data;
    if (!gameData) return {};

    let description = gameData.short_description?.trim();
    if (description?.length > MAX_DESC_LENGTH) {
      description = description.substring(0, MAX_DESC_LENGTH) + '...';
    }

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
      const steamAppId = extractSteamAppId(resolvedUrl);

      const steamUrl = steamAppId ? `https://store.steampowered.com/app/${steamAppId}/` : game.open_giveaway_url;
      const twInfo = await getSteamTWInfo(steamAppId);

      let finalDesc = twInfo.description ?? game.description ?? '快去 Steam 領取！';
      if (finalDesc.length > MAX_DESC_LENGTH) finalDesc = finalDesc.substring(0, MAX_DESC_LENGTH) + '...';

      games.push({
        appid: game.id,
        steamAppId,
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
    const endTimestamp = Math.floor(new Date(game.endDate).getTime() / 1000);
    if (!isNaN(endTimestamp)) endDateDisplay = `<t:${endTimestamp}:f> (<t:${endTimestamp}:R>)`;
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
  const command = {
    data: new SlashCommandBuilder()
      .setName('steamfree')
      .setDescription('立即查詢目前 Steam 限免遊戲'),
    async execute(interaction) {
      await interaction.deferReply();
      try {
        const games = await getSteamFreeGames();
        if (games.length === 0) return interaction.editReply('😔 目前沒有偵測到限免遊戲。');

        const displayGames = games.slice(0, MAX_GAMES_PER_REPLY);
        await interaction.editReply(`✅ 找到 **${games.length}** 款限免遊戲！${games.length > MAX_GAMES_PER_REPLY ? `（僅顯示前 ${MAX_GAMES_PER_REPLY} 款）` : ''}`);

        for (const game of displayGames) await interaction.followUp(buildMessage(game));
      } catch (err) {
        console.error('⚠️ [SteamFree] /steamfree 指令執行失敗:', err.message);
        await interaction.editReply('❌ 查詢時發生錯誤，請稍後再試。').catch(() => {});
      }
    }
  };

  client.commands.set(command.data.name, command);

  const NOTIFY_CHANNEL_ID = process.env.STEAM_NOTIFY_CHANNEL_ID;
  if (!NOTIFY_CHANNEL_ID) {
    return console.warn('⚠️ [SteamFree] 未設定 STEAM_NOTIFY_CHANNEL_ID，自動通知已停用');
  }

  let lastLogTime = 0;
  async function checkAndNotify() {
    const channel = client.channels.cache.get(NOTIFY_CHANNEL_ID) || await client.channels.fetch(NOTIFY_CHANNEL_ID).catch(() => null);
    if (!channel) return console.error('⚠️ [SteamFree] 找不到通知頻道，跳過本次檢查');

    const now = Date.now();
    if (now - lastLogTime >= LOG_INTERVAL_MS) {
      lastLogTime = now;
      console.log(`[SteamFree] 定時檢查中... (${new Date().toLocaleString('zh-TW')})`);
    }

    const games = await getSteamFreeGames();
    let needsSave = false;

    for (const game of games) {
      if (!notifiedGames.has(game.appid)) {
        notifiedGames.set(game.appid, Date.now());
        try {
          await channel.send(buildMessage(game));
          console.log(`[SteamFree] ✅ 已通知：${game.name} → ${game.url}`);
          needsSave = true;
        } catch (err) {
          console.error(`⚠️ [SteamFree] 發送通知失敗 (${game.name}):`, err.message);
          notifiedGames.delete(game.appid);
        }
      }
    }
    if (needsSave) saveNotifiedGames();
  }

  client.once('clientReady', () => {
    console.log(`[SteamFree] Bot 啟動時間：${new Date().toLocaleString('zh-TW')}`);
    checkAndNotify().catch(err => console.error('⚠️ [SteamFree] 啟動時檢查失敗:', err.message));
    setInterval(() => checkAndNotify().catch(err => console.error('⚠️ [SteamFree] 定時任務發生錯誤:', err.message)), CHECK_INTERVAL_MS);
  });

  console.log(`✅ Steam 限免通知已啟用（頻道：${NOTIFY_CHANNEL_ID}，每 30 分鐘檢查）`);
}

module.exports = { setupSteamFreeNotifier };