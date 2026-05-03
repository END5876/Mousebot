const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── 常數設定 ──────────────────────────────────────────────
const MAX_DESC_LENGTH = 250;       // 描述最大字元數
const MAX_GAMES_PER_REPLY = 10;    // /steamfree 指令最多顯示幾款
const MAX_AGE_DAYS = 90;           // notifiedGames 保留天數
const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 分鐘

// ── 已通知過的 AppID 存檔設定 ────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'steam_cache');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const NOTIFIED_FILE = path.join(DATA_DIR, 'notifiedGames.json');

// 改為 Map<id, timestamp>，方便之後清理過期資料
let notifiedGames = new Map();

// 讀取檔案
if (fs.existsSync(NOTIFIED_FILE)) {
  try {
    const data = fs.readFileSync(NOTIFIED_FILE, 'utf8');
    const parsed = JSON.parse(data);

    // 相容舊格式（純陣列）與新格式（Map entries）
    if (Array.isArray(parsed) && parsed.length > 0 && Array.isArray(parsed[0])) {
      notifiedGames = new Map(parsed); // 新格式：[[id, timestamp], ...]
    } else if (Array.isArray(parsed)) {
      // 舊格式：[id, id, ...] → 補上當前時間戳
      for (const id of parsed) notifiedGames.set(id, Date.now());
    }

    console.log(`[SteamFree] 已載入 ${notifiedGames.size} 筆通知記錄`);
  } catch (e) {
    console.error('⚠️ [SteamFree] 讀取已通知清單失敗:', e.message);
  }
}

// 清理超過 MAX_AGE_DAYS 的舊記錄
function pruneOldNotifications() {
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const [id, timestamp] of notifiedGames) {
    if (timestamp < cutoff) {
      notifiedGames.delete(id);
      pruned++;
    }
  }
  if (pruned > 0) {
    console.log(`[SteamFree] 已清理 ${pruned} 筆過期通知記錄`);
  }
}

// 儲存檔案（非同步，避免阻塞）
function saveNotifiedGames() {
  pruneOldNotifications();
  const payload = JSON.stringify([...notifiedGames.entries()]);
  fs.writeFile(NOTIFIED_FILE, payload, (e) => {
    if (e) console.error('⚠️ [SteamFree] 儲存已通知清單失敗:', e.message);
  });
}

// ── HTTP GET 封裝（含 Retry 機制）────────────────────────
function httpsGet(url, retries = 3, delayMs = 3000) {
  return new Promise((resolve, reject) => {
    const attempt = (remaining) => {
      https.get(url, { headers: { 'User-Agent': 'MouseBot/1.0' } }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume(); // 釋放記憶體
          const err = new Error(`HTTP Status Code: ${res.statusCode}`);
          if (remaining > 1) {
            console.warn(`⚠️ [SteamFree] 請求失敗（${res.statusCode}），${delayMs / 1000}s 後重試，剩餘 ${remaining - 1} 次`);
            return setTimeout(() => attempt(remaining - 1), delayMs);
          }
          return reject(err);
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      }).on('error', (err) => {
        if (remaining > 1) {
          console.warn(`⚠️ [SteamFree] 網路錯誤（${err.message}），${delayMs / 1000}s 後重試，剩餘 ${remaining - 1} 次`);
          return setTimeout(() => attempt(remaining - 1), delayMs);
        }
        reject(err);
      });
    };
    attempt(retries);
  });
}

// ── 取得 Steam 限免遊戲清單 ───────────────────────────────
async function getSteamFreeGames() {
  try {
    const data = await httpsGet('https://www.gamerpower.com/api/giveaways?platform=steam');

    if (!Array.isArray(data)) return [];
    const freeGames = data.filter(game => game.type === 'Game');

    return freeGames.map(game => ({
      appid: game.id,
      name: game.title,
      originalPrice: game.worth === 'N/A' ? '未知' : game.worth,
      url: game.open_giveaway_url,
      image: game.image || '',
      description: game.description
        ? (game.description.length > MAX_DESC_LENGTH
            ? game.description.substring(0, MAX_DESC_LENGTH) + '...'
            : game.description)
        : '快去 Steam 領取！',
      endDate: game.end_date === 'N/A' ? '未知 / 隨時結束' : game.end_date,
      platforms: game.platforms || 'Steam',
    }));
  } catch (e) {
    console.error('⚠️ [SteamFree] 獲取限免遊戲失敗（已耗盡重試次數）:', e.message);
    return [];
  }
}

// ── 建立 Embed 與按鈕 ─────────────────────────────────────
function buildMessage(game) {
  const embed = new EmbedBuilder()
    .setAuthor({
      name: 'Steam 限時免費活動',
      iconURL: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Steam_icon_logo.svg/512px-Steam_icon_logo.svg.png'
    })
    .setTitle(`🎉 ${game.name}`)
    .setURL(game.url)
    .setDescription(game.description)
    .setColor(0x66c0f4)
    .addFields(
      { name: '💰 原價', value: `~~${game.originalPrice}~~`, inline: true },
      { name: '🆓 現在', value: '**免費**', inline: true },
      { name: '🎮 平台', value: game.platforms, inline: true },
      { name: '⏳ 截止時間', value: `\`${game.endDate}\``, inline: false }
    )
    .setImage(game.image)
    .setTimestamp()
    .setFooter({ text: 'Steam 限免通知 · Mousebot' });

  const button = new ButtonBuilder()
    .setLabel('🔗 立即前往領取')
    .setURL(game.url)
    .setStyle(ButtonStyle.Link);

  const row = new ActionRowBuilder().addComponents(button);

  return { embeds: [embed], components: [row] };
}

// ── 主要 Setup 函式 ────────────────────────────────────────
function setupSteamFreeNotifier(client) {

  // ── Slash Command：/steamfree ────────────────────────
  const command = {
    data: new SlashCommandBuilder()
      .setName('steamfree')
      .setDescription('立即查詢目前 Steam 限免遊戲'),
    async execute(interaction) {
      await interaction.deferReply();

      try {
        const games = await getSteamFreeGames();

        if (games.length === 0) {
          return interaction.editReply('😔 目前沒有偵測到限免遊戲。');
        }

        const displayGames = games.slice(0, MAX_GAMES_PER_REPLY);
        const truncated = games.length > MAX_GAMES_PER_REPLY;

        await interaction.editReply(
          `✅ 找到 **${games.length}** 款限免遊戲！` +
          (truncated ? `（僅顯示前 ${MAX_GAMES_PER_REPLY} 款）` : '')
        );

        for (const game of displayGames) {
          await interaction.followUp(buildMessage(game));
        }
      } catch (err) {
        console.error('⚠️ [SteamFree] /steamfree 指令執行失敗:', err.message);
        await interaction.editReply('❌ 查詢時發生錯誤，請稍後再試。').catch(() => {});
      }
    }
  };

  client.commands.set(command.data.name, command);

  // ── 定時自動通知 ───────────────────────────────────────
  const NOTIFY_CHANNEL_ID = process.env.STEAM_NOTIFY_CHANNEL_ID;

  if (!NOTIFY_CHANNEL_ID) {
    console.warn('⚠️ [SteamFree] 未設定 STEAM_NOTIFY_CHANNEL_ID，自動通知已停用');
    return;
  }

  async function checkAndNotify() {
    // 優先從快取取得，若無則嘗試 fetch
    let channel = client.channels.cache.get(NOTIFY_CHANNEL_ID);
    if (!channel) {
      try {
        channel = await client.channels.fetch(NOTIFY_CHANNEL_ID);
      } catch (err) {
        console.error('⚠️ [SteamFree] 找不到通知頻道，跳過本次檢查:', err.message);
        return;
      }
    }

    console.log(`[SteamFree] 定時檢查中... (${new Date().toLocaleString('zh-TW')})`);
    const games = await getSteamFreeGames();
    let hasNewGames = false;

    for (const game of games) {
      if (!notifiedGames.has(game.appid)) {
        notifiedGames.set(game.appid, Date.now()); // 記錄時間戳
        hasNewGames = true;

        try {
          await channel.send(buildMessage(game));
          console.log(`[SteamFree] ✅ 已通知：${game.name}`);
        } catch (err) {
          console.error(`⚠️ [SteamFree] 發送通知失敗 (${game.name}):`, err.message);
          // 發送失敗時從 Set 移除，下次重試
          notifiedGames.delete(game.appid);
          hasNewGames = false;
        }
      }
    }

    if (hasNewGames) {
      saveNotifiedGames();
    }
  }

  client.once('clientReady', () => {
    console.log(`[SteamFree] Bot 啟動時間：${new Date().toLocaleString('zh-TW')}`);

    // 啟動時立刻檢查一次
    checkAndNotify().catch(err =>
      console.error('⚠️ [SteamFree] 啟動時檢查失敗:', err.message)
    );

    // 之後每 30 分鐘檢查，包上 try/catch 防止 interval 中斷
    setInterval(async () => {
      try {
        await checkAndNotify();
      } catch (err) {
        console.error('⚠️ [SteamFree] 定時任務發生未預期錯誤:', err.message);
      }
    }, CHECK_INTERVAL_MS);
  });

  console.log(`✅ Steam 限免通知已啟用（頻道：${NOTIFY_CHANNEL_ID}，每 30 分鐘檢查）`);
}

module.exports = { setupSteamFreeNotifier };