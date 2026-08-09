'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const { scanBillImage } = require('../../utils/billScanner');
// processAttachments 內部（fetchImageAsBase64 -> fetchImageUrlAsBase64）已經會把圖片
// resize 到最長邊 1024px 以內並轉成 webp 再回傳 base64，因此帳單辨識這邊不需要再自己做壓縮。
const { processAttachments } = require('../../../ai/aiUtils');
const {
  BILL_SCAN_TIMEOUT_MS,
  BILL_SCAN_MAX_IMAGES_PER_BATCH,
  BILL_SCAN_RATE_LIMIT_WINDOW_MS,
  BILL_SCAN_RATE_LIMIT_MAX,
  billScanRateLimiter,
  isImageAttachment,
  billScanKey,
  stopActiveBillScan,
  activeBillScanCollectors,
  generateBatchId,
  scanItemCacheUserId,
  buildScanResultView
} = require('./billScan');

async function startBillScan(interaction, trip, cache) {
  const { guildId, user } = interaction;

  // 若使用者連續點兩次「掃描帳單新增」（例如手滑重複點擊），先停掉前一個尚未結束的
  // collector 再建立新的，避免同時存在兩個監聽器（詳見上方 stopActiveBillScan 註解）。
  stopActiveBillScan(guildId, user.id, 'superseded');

  const waitEmbed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('📷 掃描帳單新增花費')
    .setDescription(
      `請在 **${BILL_SCAN_TIMEOUT_MS / 1000} 秒內**，直接在本頻道傳送帳單／收據照片（拍照或截圖皆可）。\n` +
      `我會自動幫你判讀項目名稱、金額與幣別，稍後仍可再手動確認或修改！\n` +
      `*(可以一次夾帶多張圖片，每一張會各自算成一筆花費，單則訊息最多處理 ${BILL_SCAN_MAX_IMAGES_PER_BATCH} 張；僅接受圖片格式。這則訊息稍後會被刪除，辨識結果會直接回覆在你上傳的照片下方)*`
    );

  const cancelRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('exp_nav').setLabel('⬅️ 取消並返回').setStyle(ButtonStyle.Secondary)
  );

  await interaction.update({ embeds: [waitEmbed], components: [cancelRow] });

  const channel = interaction.channel;
  if (!channel) return;

  const collector = channel.createMessageCollector({
    filter: (m) => m.author.id === user.id && m.attachments.some((a) => isImageAttachment(a)),
    time: BILL_SCAN_TIMEOUT_MS,
    max: 1
  });

  // 掛進追蹤表，讓「取消並返回」或「重新點擊掃描」時可以正確 stop() 掉這個 collector。
  activeBillScanCollectors.set(billScanKey(guildId, user.id), collector);

  collector.on('collect', async (msg) => {
    // 頻道訊息量一多，原本那個面板訊息很容易被洗到畫面上方看不到，使用者往往找不到結果在哪。
    // 因此這裡不再「編輯」面板訊息，而是直接刪除它，改成用 msg.reply() 建立一則新訊息，
    // 直接回覆在使用者剛剛上傳的那張照片下面——不管頻道多熱鬧，使用者的目光本來就會停在
    // 自己剛傳的圖片附近，結果就直接錨定在那裡，也不會留下一則過時、多餘的面板訊息。
    // 另外搭配在該訊息上加表情符號反應，讓使用者第一時間就知道機器人有收到、正在處理。
    await interaction.deleteReply().catch(() => {});
    await msg.react('⏳').catch(() => {});

    // 統一的「送出結果」函式：優先直接回覆在使用者的圖片訊息下面；
    // 萬一因權限等問題 reply 失敗，才退而求其次用 followUp() 補發一則新訊息——
    // 面板已經被刪除了，這裡不能再用 editReply（沒有訊息可編輯）。一次批次裡每張圖／
    // 每個提示訊息都會各自呼叫一次，彼此獨立送出。
    const deliverResult = async (payload) => {
      try {
        await msg.reply(payload);
      } catch (replyErr) {
        console.error('⚠️ 回覆使用者圖片訊息失敗，改用 followUp 補發新訊息:', replyErr.message);
        await interaction.followUp(payload).catch(() => {});
      }
    };

    // 一次訊息可能夾帶多張圖片，每一張都各自算一筆花費；這裡取所有符合圖片格式的附件，
    // 依訊息中原本的順序處理，並限制單次批次最多處理的張數（見 BILL_SCAN_MAX_IMAGES_PER_BATCH 說明）。
    const allImageAttachments = [...msg.attachments.values()].filter((a) => isImageAttachment(a));
    const imageAttachments = allImageAttachments.slice(0, BILL_SCAN_MAX_IMAGES_PER_BATCH);
    const truncatedCount = allImageAttachments.length - imageAttachments.length;

    if (!imageAttachments.length) {
      await msg.react('❌').catch(() => {});
      await deliverResult({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle('❌ 辨識失敗')
            .setDescription('無法讀取您上傳的檔案，請確認上傳的是常見圖片格式 (png/jpg/webp)。')
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('exp_btn_scan_start').setLabel('🔄 重新掃描').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('exp_btn_add_start').setLabel('✏️ 改用手動輸入').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('nav_main').setLabel('🏠 返回主控台').setStyle(ButtonStyle.Secondary)
          )
        ]
      });
      return;
    }

    const batchId = generateBatchId();
    const batchTotal = imageAttachments.length;
    const tripCurrencies = Object.keys(trip.rates);

    let successCount = 0;
    let failCount = 0;
    let rateLimitedFrom = -1; // 從第幾張（0-based）開始被節流擋下；-1 表示整批都沒被擋

    for (let i = 0; i < imageAttachments.length; i++) {
      const imageAttachment = imageAttachments[i];

      // 每一張圖＝一次真正的 Gemini 呼叫，額度算在這裡逐張檢查，而不是算在「按下開始掃描」
      // 這個動作本身——這樣才能準確反映實際的 API 成本，也才擋得住「一次塞很多張圖」這種
      // 用量突然暴增的情況。一旦被擋下，後面剩下的張數就不再繼續處理，直接跳出迴圈。
      const rateCheck = billScanRateLimiter.check(billScanKey(guildId, user.id));
      if (!rateCheck.allowed) {
        rateLimitedFrom = i;
        break;
      }

      const itemCacheUserId = scanItemCacheUserId(user.id, batchId, i);
      const itemLabel = batchTotal > 1 ? `第 ${i + 1}／${batchTotal} 張：` : '';

      try {
        const imageParts = await processAttachments(new Map([[imageAttachment.id, imageAttachment]]));
        if (!imageParts.length) {
          throw new Error('無法讀取這張圖片，請確認是常見圖片格式 (png/jpg/webp)。');
        }

        const result = await scanBillImage(imageParts, tripCurrencies, trip.baseCurrency);

        const matchedCurrency = tripCurrencies.find((c) => c.toUpperCase() === result.currency) || trip.baseCurrency;
        const currencyNote = matchedCurrency !== result.currency && result.currency
          ? `（AI 判讀為 \`${result.currency}\`，已自動對應至此行程使用的 \`${matchedCurrency}\`）`
          : '';

        const scanResult = {
          description: result.description,
          amount: result.amount,
          currency: matchedCurrency,
          confidence: result.confidence,
          date: result.date,
          imageUrl: imageAttachment.url,
          batchId,
          index: i,
          batchTotal
        };
        cache.set(guildId, itemCacheUserId, { scanResult });

        const view = buildScanResultView(trip, scanResult, { currencyFieldNote: currencyNote });
        await deliverResult(view);
        successCount++;
      } catch (err) {
        console.error(`⚠️ 帳單辨識失敗（${itemLabel || '單張'}）:`, err);
        const errEmbed = new EmbedBuilder()
          .setColor(0xe74c3c)
          .setTitle(`❌ ${itemLabel}辨識失敗`)
          .setDescription(`發生錯誤：${err.message || '未知錯誤'}\n這張可以重新上傳再試一次，或改用手動輸入；不影響同一批次裡的其他張。`);

        const retryRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('exp_btn_scan_start').setLabel('🔄 重新掃描').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('exp_btn_add_start').setLabel('✏️ 改用手動輸入').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('nav_main').setLabel('🏠 返回主控台').setStyle(ButtonStyle.Secondary)
        );

        await deliverResult({ embeds: [errEmbed], components: [retryRow] });
        failCount++;
      }
    }

    // 批次裡有任何「訊息夾帶超過上限張數」或「中途被節流擋下」的情況，額外補一則簡短說明，
    // 讓使用者清楚知道少了哪些張數、該怎麼補救，而不是自己去猜為什麼少了幾張的結果。
    if (truncatedCount > 0 || rateLimitedFrom >= 0) {
      const noteLines = [];
      if (truncatedCount > 0) {
        noteLines.push(`📦 這則訊息夾帶了 ${allImageAttachments.length} 張圖片，單次批次最多處理 ${BILL_SCAN_MAX_IMAGES_PER_BATCH} 張，其餘 ${truncatedCount} 張未處理，請再傳一次。`);
      }
      if (rateLimitedFrom >= 0) {
        const skipped = imageAttachments.length - rateLimitedFrom;
        noteLines.push(`⚠️ 已達到目前的辨識次數上限（每人每 ${BILL_SCAN_RATE_LIMIT_WINDOW_MS / 1000} 秒最多 ${BILL_SCAN_RATE_LIMIT_MAX} 次），這批還有 ${skipped} 張未處理，請稍後再試。`);
      }
      await deliverResult({ content: noteLines.join('\n') });
    }

    // 整批的最終反應：全部成功給 ✅、全部失敗給 ❌、有成功有失敗給 ⚠️，讓使用者不用逐一點開訊息
    // 也能從反應圖示大致看出這批處理得順不順利。
    if (failCount === 0 && rateLimitedFrom < 0) {
      await msg.react('✅').catch(() => {});
    } else if (successCount === 0) {
      await msg.react('❌').catch(() => {});
    } else {
      await msg.react('⚠️').catch(() => {});
    }
  });

  collector.on('end', (collected, reason) => {
    // 只有在追蹤表裡目前仍然是「自己」時才清除，避免不小心刪掉後來新建立的 collector 紀錄
    // （例如：這個 collector 已經被 stopActiveBillScan 換掉並移除，此時 map 裡存的已是新的一筆）。
    const key = billScanKey(guildId, user.id);
    if (activeBillScanCollectors.get(key) === collector) {
      activeBillScanCollectors.delete(key);
    }

    if (collected.size > 0) return; // 已在 collect 事件中處理完成，無需再顯示逾時訊息

    // 使用者主動離開等待畫面（點了其他按鈕）或被新的一次掃描取代時，
    // 畫面早已被那個操作換掉了，這裡不該再用舊的 interaction 蓋回一個「已逾時」訊息，
    // 否則輕則畫面被覆蓋、重則因為 interaction token 情境不對而噴錯。
    if (reason === 'navigated_away' || reason === 'superseded') return;

    const timeoutEmbed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle('⌛ 已逾時')
      .setDescription('未在時間內收到帳單照片，本次掃描已自動取消。');

    const retryRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('exp_btn_scan_start').setLabel('🔄 重新掃描').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('nav_main').setLabel('🏠 返回主控台').setStyle(ButtonStyle.Secondary)
    );

    // 跟收到圖片時一樣的處理原則：先刪掉舊面板，再用 followUp() 補一則新訊息，
    // 而不是原地 editReply——如果 90 秒等待期間頻道還有其他訊息，原地編輯一樣會被洗上去看不到。
    (async () => {
      await interaction.deleteReply().catch(() => {});
      await interaction.followUp({ embeds: [timeoutEmbed], components: [retryRow] }).catch(() => {});
    })();
  });
}

module.exports = { startBillScan };
