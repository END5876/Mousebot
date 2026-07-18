const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { fetchJson } = require('./noticeService');
const logger = require('../../utils/logger');

// ── 常數設定 ──────────────────────────────────────────────
const MAX_DESC_LENGTH = 250;
const LABEL = 'SteamFree';

// ── 過濾規則：排除「需透過第三方兌換序號」的 Key Giveaway ──
// GamerPower 對這類贈送一律會在標題結尾加上「Key Giveaway」，
// 例如 Alienware Arena 的 ARP 點數兌換序號活動，並非真正的
// Steam 官方限免，故在第一層先用標題把它們濾掉。
const KEY_GIVEAWAY_PATTERN = /key giveaway/i;

// ── 取得最終落地 URL ──────────────────────────────────────
// 回傳 { finalUrl, resolved }：
//   resolved = true  → HEAD 請求成功，finalUrl 是真正解析後的網址
//   resolved = false → 請求失敗（網路/逾時/被擋），finalUrl 退回原始網址
// 特別區分這兩種情況，是為了避免把「暫時查不到」跟「確定不是
// Steam」混為一談而誤殺真正的限免遊戲。
async function getFinalUrl(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'MouseBot/1.0' } });
    return { finalUrl: res.url, resolved: true };
  } catch (e) {
    logger.debug(LABEL, `HEAD 請求失敗，暫時無法解析網址: ${url} (${e.message})`);
    return { finalUrl: url, resolved: false };
  }
}

// ── 從 URL 擷取 Steam AppID ───────────────────────────────
const extractSteamAppId = (url = '') => url.match(/store\.steampowered\.com\/app\/(\d+)/)?.[1] || null;

// ── 查詢 Steam 台灣區域完整資訊 ──────────────────────────
async function getSteamTWInfo(steamAppId) {
  if (!steamAppId) return {};
  try {
    const data = await fetchJson(`https://store.steampowered.com/api/appdetails?appids=${steamAppId}&cc=TW&l=tchinese`, { label: LABEL });
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
    const data = await fetchJson('https://www.gamerpower.com/api/giveaways?platform=steam', { label: LABEL });
    if (!Array.isArray(data)) return [];

    // 第一層過濾：type 必須是 'Game'，且標題不含「Key Giveaway」
    const freeGames = data.filter(game =>
      game.type === 'Game' && !KEY_GIVEAWAY_PATTERN.test(game.title)
    );

    const games = [];

    for (const game of freeGames) {
      const { finalUrl, resolved } = await getFinalUrl(game.open_giveaway_url);
      const steamAppId = extractSteamAppId(finalUrl);

      // 第二層過濾：確定解析成功、但落地網址不是 Steam 官網
      // → 代表這其實是需要透過第三方平台兌換序號的贈送，
      //   即使漏過了標題比對，這裡也能擋下來，靜默跳過即可。
      if (resolved && !steamAppId) {
        logger.debug(LABEL, `跳過非 Steam 官網的贈送: ${game.title} → ${finalUrl}`);
        continue;
      }

      // 解析失敗（單純網路問題）則保留，避免誤殺真正的限免遊戲
      const steamUrl = steamAppId ? `https://store.steampowered.com/app/${steamAppId}/` : finalUrl;
      const twInfo   = await getSteamTWInfo(steamAppId);

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

// ════════════════════════════════════════════════════════
//  純 provider 模組：/steamfree /setsteamchannel 已合併進
//  handlers/notice/noticeHandler.js 的 /notify 指令，
//  這裡只保留「取得限免遊戲」與「組訊息」給它呼叫
// ════════════════════════════════════════════════════════
module.exports = {
  label: LABEL,
  idField: 'appid',
  notifiedFileName: 'steamnotified.json',
  channelFileName: 'steamchannel.json',
  getFreeGames: getSteamFreeGames,
  buildMessage,
};