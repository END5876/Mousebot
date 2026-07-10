const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { fetchJson } = require('./noticeService');

// ── 常數設定 ──────────────────────────────────────────────
const MAX_DESC_LENGTH = 250;
const LABEL = 'EpicFree';

// ── 取得 Epic 限免遊戲清單 (官方 API) ──────────────────────
// 註：此函式不再印出「取得 N elements / 篩選完成」routine log，
//     只保留真正異常狀況（API 格式跑掉）的警告，
//     routine 摘要 log 改由 checkAndNotify() 在「有新遊戲」時才印。
async function getEpicFreeGames() {
  try {
    const url = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=zh-Hant&country=TW&allowCountries=TW';
    const data = await fetchJson(url, { label: LABEL });

    const elements = data?.data?.Catalog?.searchStore?.elements;
    if (!Array.isArray(elements)) {
      console.warn('[EpicFree] ⚠️ API 回傳格式異常，elements 非陣列，實際結構:', JSON.stringify(data)?.slice(0, 200));
      return [];
    }

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

      if (!isInWindow || !isFree) continue;

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
      const y = dateObj.getFullYear();
      const m = dateObj.getMonth() + 1;
      const d = dateObj.getDate();
      endDateDisplay = `${y}年${m}月${d}日 (<t:${endTimestamp}:R>)`;
    }
  }

  const priceText = game.originalPrice !== '未知' ? `~~${game.originalPrice}~~` : '未知';

  const embed = new EmbedBuilder()
    .setAuthor({ name: 'Epic Games 限時免費', iconURL: 'https://img.icons8.com/ios-filled/512/epic-games.png' })
    .setTitle(game.name)
    .setURL(game.url)
    .setDescription(game.description)
    .setColor(0xFFFFFF)
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

// ════════════════════════════════════════════════════════
//  純 provider 模組：/epicfree /setepicchannel 已合併進
//  handlers/notice/noticeHandler.js 的 /notify 指令，
//  這裡只保留「取得限免遊戲」與「組訊息」給它呼叫
// ════════════════════════════════════════════════════════
module.exports = {
  label: LABEL,
  idField: 'id',
  notifiedFileName: 'epicnotified.json',
  channelFileName: 'epicchannel.json',
  getFreeGames: getEpicFreeGames,
  buildMessage,
};
