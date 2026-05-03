const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── 已通知過的 AppID 存檔設定 ────────────────────────────
// 優先讀取環境變數 DATA_DIR，如果沒有則預設在當前目錄的 data 資料夾
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'steam_cache');

// 確保資料夾存在，如果沒有就建立它
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 設定最終的檔案路徑
const NOTIFIED_FILE = path.join(DATA_DIR, 'notifiedGames.json');
let notifiedGames = new Set();

// 讀取檔案
if (fs.existsSync(NOTIFIED_FILE)) {
  try {
    const data = fs.readFileSync(NOTIFIED_FILE, 'utf8');
    notifiedGames = new Set(JSON.parse(data));
  } catch (e) {
    console.error('⚠️ [SteamFree] 讀取已通知清單失敗:', e.message);
  }
}

// 儲存檔案
function saveNotifiedGames() {
  try {
    fs.writeFileSync(NOTIFIED_FILE, JSON.stringify([...notifiedGames]));
  } catch (e) {
    console.error('⚠️ [SteamFree] 儲存已通知清單失敗:', e.message);
  }
}

// ── HTTP GET 封裝 ─────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'MouseBot/1.0' } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP Status Code: ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── 取得 Steam 限免遊戲清單 (擴充抓取欄位) ────────────────
async function getSteamFreeGames() {
  try {
    const data = await httpsGet('https://www.gamerpower.com/api/giveaways?platform=steam');
    
    if (!Array.isArray(data)) return [];
    const freeGames = data.filter(game => game.type === 'Game');
    
    return freeGames.map(game => ({
      appid: game.id,
      name: game.title,
      originalPrice: game.worth === "N/A" ? "未知" : game.worth,
      url: game.open_giveaway_url,
      image: game.image || '',
      // 限制描述長度，避免版面過長
      description: game.description ? (game.description.length > 250 ? game.description.substring(0, 250) + '...' : game.description) : '快去 Steam 領取！',
      endDate: game.end_date === "N/A" ? "未知 / 隨時結束" : game.end_date,
      platforms: game.platforms || 'Steam',
    }));
  } catch (e) {
    console.error('⚠️ [SteamFree] 獲取限免遊戲失敗:', e.message);
    return [];
  }
}

// ── 建立 Embed 與 按鈕 (重新設計樣式) ─────────────────────
function buildMessage(game) {
  // 1. 建立 Embed
  const embed = new EmbedBuilder()
    .setAuthor({ 
      name: 'Steam 限時免費活動', 
      iconURL: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Steam_icon_logo.svg/512px-Steam_icon_logo.svg.png' 
    })
    .setTitle(`🎉 ${game.name}`)
    .setURL(game.url)
    .setDescription(game.description)
    .setColor(0x66c0f4) // Steam 經典淺藍色
    .addFields(
      { name: '💰 原價', value: `~~${game.originalPrice}~~`, inline: true },
      { name: '🆓 現在', value: '**免費**', inline: true },
      { name: '🎮 平台', value: game.platforms, inline: true },
      { name: '⏳ 截止時間', value: `\`${game.endDate}\``, inline: false }
    )
    .setImage(game.image)
    .setTimestamp()
    .setFooter({ text: 'Steam 限免通知 · Mousebot' });

  // 2. 建立按鈕
  const button = new ButtonBuilder()
    .setLabel('🔗 立即前往領取')
    .setURL(game.url)
    .setStyle(ButtonStyle.Link);

  const row = new ActionRowBuilder().addComponents(button);

  // 回傳包含 Embed 和 Components(按鈕) 的物件
  return { embeds: [embed], components: [row] };
}

// ── 主要 Setup 函式 ────────────────────────────────────────
function setupSteamFreeNotifier(client) {

  // ── Slash Command：/steamfree ──────────────────────────
  const command = {
    data: new SlashCommandBuilder()
      .setName('steamfree')
      .setDescription('立即查詢目前 Steam 限免遊戲'),
    async execute(interaction) {
      await interaction.deferReply();
      const games = await getSteamFreeGames();

      if (games.length === 0) {
        return interaction.editReply('😔 目前沒有偵測到限免遊戲。');
      }

      await interaction.editReply(`✅ 找到 **${games.length}** 款限免遊戲！`);
      for (const game of games) {
        // 使用更新後的 buildMessage
        await interaction.followUp(buildMessage(game));
      }
    }
  };

  client.commands.set(command.data.name, command);

  // ── 定時自動通知 ─────────────────────────────────────────
  const NOTIFY_CHANNEL_ID = process.env.STEAM_NOTIFY_CHANNEL_ID;
  const CHECK_INTERVAL_MS = 30 * 60 * 1000;

  if (!NOTIFY_CHANNEL_ID) {
    console.warn('⚠️ [SteamFree] 未設定 STEAM_NOTIFY_CHANNEL_ID，自動通知已停用');
    return;
  }

  async function checkAndNotify() {
    const channel = client.channels.cache.get(NOTIFY_CHANNEL_ID);
    if (!channel) return;

    console.log('[SteamFree] 定時檢查中...');
    const games = await getSteamFreeGames();
    let hasNewGames = false;

    for (const game of games) {
      if (!notifiedGames.has(game.appid)) {
        notifiedGames.add(game.appid);
        hasNewGames = true;
        
        try {
          // 使用更新後的 buildMessage
          await channel.send(buildMessage(game));
          console.log(`[SteamFree] 已通知：${game.name}`);
        } catch (err) {
          console.error(`⚠️ [SteamFree] 發送通知失敗 (${game.name}):`, err.message);
        }
      }
    }

    if (hasNewGames) {
      saveNotifiedGames();
    }
  }

  client.once('clientReady', () => {
    checkAndNotify(); // 啟動時立刻檢查一次
    setInterval(checkAndNotify, CHECK_INTERVAL_MS); // 之後每 30 分鐘檢查一次
  });

  console.log(`✅ Steam 限免通知已啟用（頻道：${NOTIFY_CHANNEL_ID}，每 30 分鐘檢查）`);
}

module.exports = { setupSteamFreeNotifier };
