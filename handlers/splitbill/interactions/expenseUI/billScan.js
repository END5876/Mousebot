'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder
} = require('discord.js');
const { formatMoneyDisplay } = require('../../utils/calculator');
const { SlidingWindowRateLimiter } = require('../../utils/rateLimiter');

// ────────────────────────────────────────────────────────────────
// ⏱️ 帳單掃描相關的時間/數量限制與共用小工具
// ────────────────────────────────────────────────────────────────

const BILL_SCAN_TIMEOUT_MS = 90 * 1000;

// 一次訊息最多處理幾張圖片（每張＝一筆花費）。Discord 單則訊息最多可以夾帶 10 個附件，
// 但這裡刻意設低一點：一次掃太多張會拉長使用者等待時間、也讓 Gemini API 費用一次噴出去，
// 5 張對大多數「一天的收據一次補登」的情境已經很夠用。
const BILL_SCAN_MAX_IMAGES_PER_BATCH = 5;

// 每人（依 guildId+userId）在時間窗口內最多能觸發幾次「實際的 Gemini 呼叫」，避免手滑連點/
// 惡意灌爆造成費用無上限累加。改成一次可以上傳多張圖之後，額度是算在「每一張圖」上
// （在下面的批次迴圈裡逐張檢查），而不是算在「按下開始掃描」這個動作本身——
// 畢竟真正花錢的是每一次 Gemini 呼叫，不是使用者點了幾次按鈕。
const BILL_SCAN_RATE_LIMIT_MAX = 8;
const BILL_SCAN_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const billScanRateLimiter = new SlidingWindowRateLimiter(BILL_SCAN_RATE_LIMIT_MAX, BILL_SCAN_RATE_LIMIT_WINDOW_MS);

// Discord 附件的 contentType 有時會缺失（例如用戶端未回傳），因此除了檢查 MIME type，
// 也用副檔名做保底判斷，兩者符合其一即視為圖片附件。
const BILL_SCAN_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif'];

function isImageAttachment(attachment) {
  if (attachment.contentType && attachment.contentType.startsWith('image/')) return true;
  const name = (attachment.name || '').toLowerCase();
  return BILL_SCAN_IMAGE_EXTENSIONS.some((ext) => name.endsWith(`.${ext}`));
}

// ────────────────────────────────────────────────────────────────
// 📷 帳單掃描：追蹤每個「guildId:userId」目前是否有一個尚未結束的
// MessageCollector 在背景監聽上傳圖片。
//
// 這是必要的，因為：
//   1. 使用者點「取消並返回」時，畫面雖然換掉了，但 collector 若不主動 stop()，
//      仍會繼續跑到 90 秒逾時才結束，白白佔用資源。
//   2. 若使用者取消後又重新點「掃描帳單新增」，或是連續快速點兩次，
//      沒有這層防護的話會同時存在兩個 collector：只要上傳一張圖，
//      兩個 collector 的 filter 都會命中，導致 Gemini API 被呼叫兩次
//      （token 費用加倍），而且兩個不同的 interaction 物件會搶著
//      editReply()，較舊的 interaction token 可能已失效而噴錯。
// ────────────────────────────────────────────────────────────────
const activeBillScanCollectors = new Map(); // key: `${guildId}:${userId}` -> MessageCollector

function billScanKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

/**
 * 停止（若存在）該使用者目前正在跑的帳單掃描 collector，並從追蹤表移除。
 * 可安全地重複呼叫；沒有作用中的 collector 時直接 no-op。
 */
function stopActiveBillScan(guildId, userId, reason = 'superseded') {
  const key = billScanKey(guildId, userId);
  const existing = activeBillScanCollectors.get(key);
  if (existing) {
    activeBillScanCollectors.delete(key);
    if (!existing.ended) existing.stop(reason);
  }
}

// ────────────────────────────────────────────────────────────────
// 📦 一次上傳多張帳單圖片：每張圖各自獨立辨識、各自成為一筆待確認的花費。
//
// stateCache 原本的設計是「每個使用者同時只有一筆進行中的資料」（用 guildId+userId 當 key），
// 對手動輸入一筆花費來說夠用，但一次掃描多張帳單時，每張圖都需要各自獨立暫存辨識結果，
// 讓使用者可以各自修改幣別、各自決定要不要送出，彼此不能互相覆蓋。
// 這裡不改動 stateCache 本身的 API，而是把「批次 ID + 這張圖在批次中的序號」
// 一起編進原本的 userId 欄位，讓現有的 (guildId, userId) 兩參數介面就能安全地
// 區分出每一張圖各自的儲存格。
// ────────────────────────────────────────────────────────────────

function generateBatchId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function scanItemCacheUserId(userId, batchId, index) {
  return `${userId}:scanbatch:${batchId}:${index}`;
}

/**
 * 從像 `exp_btn_scan_confirm:${batchId}:${index}` 這種帶批次資訊的 customId 裡，
 * 把 batchId 跟 index 解析出來。
 */
function parseScanItemSuffix(customId, prefix) {
  const rest = customId.slice(prefix.length); // 例如 ":a1b2c3:2"
  const parts = rest.split(':').filter(Boolean); // ['a1b2c3', '2']
  return { batchId: parts[0] || '', index: parseInt(parts[1], 10) || 0 };
}

/**
 * 📷 帳單圖片辨識流程
 * 1. 把面板改為「等待上傳」狀態
 * 2. 在頻道中監聽該使用者下一則帶有附件的訊息
 * 3. 收到圖片後丟給 Gemini 辨識，結果暫存進 stateCache
 * 4. 顯示辨識結果，並提供「開啟表單確認並送出」按鈕（沿用既有的手動輸入 Modal 與送出邏輯）
 */

// 幣別下拉選單裡「手動輸入其他幣別」選項的特殊值，跟真正的幣別代碼（一定是英文字母）區隔開來。
const SCAN_CURRENCY_CUSTOM_VALUE = '__custom__';

// 依信心程度決定結果卡片的顏色與提示文字。信心低（或完全沒辨識到東西）時要讓使用者一眼就看出
// 「這次不太可靠，請自己再檢查一次」，而不是跟辨識成功的結果用同一種讓人安心的綠色。
const SCAN_CONFIDENCE_META = {
  high: { color: 0x2ecc71, badge: '' },
  medium: { color: 0x2ecc71, badge: '🔎 AI 信心中等，建議再次核對金額與幣別。' },
  low: { color: 0xe67e22, badge: '⚠️ AI 對這次辨識信心較低（或幾乎沒認出東西），請務必仔細核對，必要時直接手動輸入！' }
};

/**
 * 產生「辨識完成」畫面的 embed + components（包含可手動修正幣別的下拉選單）。
 * 初次顯示辨識結果、以及使用者透過下拉選單手動改幣別後重新渲染，都共用這個函式，
 * 避免兩處各寫一份容易漏改、UI 不一致。
 *
 * @param {object} trip 行程物件（需要 trip.rates 取得可選幣別清單）
 * @param {{description: string, amount: number|null, currency: string, confidence?: string, date?: string, imageUrl?: string, batchId: string, index: number, batchTotal?: number}} scanResult
 *   目前的辨識結果（幣別可能已被使用者手動覆寫）。batchId/index 用來把這張圖對應到 stateCache
 *   裡專屬於它的儲存格，也會編進下面元件的 customId，讓多張圖各自的按鈕/選單不會互相干擾。
 * @param {object} [options]
 * @param {string} [options.currencyFieldNote] 附加在「💱 幣別」欄位值後面的短註記（例如「AI 判讀為 X，已自動對應至 Y」）
 * @param {string} [options.extraFooterNote] 附加在頁尾提示文字後面的額外提醒（例如「已手動更改幣別，記得確認匯率」）
 */
function buildScanResultView(trip, scanResult, options = {}) {
  const { currencyFieldNote = '', extraFooterNote = '' } = options;
  const tripCurrencies = Object.keys(trip.rates);
  const idSuffix = `:${scanResult.batchId}:${scanResult.index}`;

  const meta = SCAN_CONFIDENCE_META[scanResult.confidence] || SCAN_CONFIDENCE_META.medium;
  const amountDisplay = formatMoneyDisplay(scanResult.amount, scanResult.currency);

  // 一次掃多張時，在標題標明「這是第幾張」，讓使用者在一串訊息裡不會搞混是在確認哪一張帳單。
  const titlePrefix = scanResult.batchTotal && scanResult.batchTotal > 1
    ? `✅ 第 ${scanResult.index + 1}／${scanResult.batchTotal} 張辨識完成！`
    : '✅ 辨識完成！';

  const resultEmbed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${titlePrefix}請確認以下內容`)
    .addFields(
      { name: '📝 項目名稱', value: scanResult.description, inline: false },
      { name: '💰 金額', value: amountDisplay !== null ? amountDisplay : '⚠️ 無法辨識，請於表單中手動填寫', inline: true },
      { name: '💱 幣別', value: `${scanResult.currency}${currencyFieldNote}`, inline: true }
    )
    .setFooter({ text: `若幣別判斷錯誤，可在下方選單手動修改；確認無誤後點擊按鈕開啟表單送出。${extraFooterNote}` });

  if (meta.badge) resultEmbed.setDescription(meta.badge);

  // 帳單上的日期只當作「給使用者核對用的參考資訊」顯示，不會拿去覆蓋花費紀錄本身的建立時間
  // （那是系統時間戳記，語意上跟帳單印的日期是兩件事，這裡刻意不混用）。
  if (scanResult.date) {
    resultEmbed.addFields({ name: '🗓️ 帳單日期（僅供參考）', value: scanResult.date, inline: true });
  }

  // 附上原圖縮圖，讓使用者不用再往上滑找圖片比對，同一則訊息就能核對辨識結果對不對。
  if (scanResult.imageUrl) resultEmbed.setThumbnail(scanResult.imageUrl);

  // 帳單辨識最容易出錯的地方就是幣別（例如日幣/韓幣的符號、或圖片沒拍到幣別資訊），
  // 因此這裡額外提供一個下拉選單，讓使用者可以直接手動覆寫 AI 判斷的幣別，不用整張重掃。
  // 選單最後固定加一個「➕ 其他幣別」選項，涵蓋「這趟行程根本還沒設定過這個幣別」的情況
  // （例如行程只設過 TWD/JPY，但這張帳單其實是歐元）——選了之後會跳一個小 Modal 讓使用者
  // 輸入代碼，並比照「行程設定」既有的新增幣別流程自動抓即時匯率或手動輸入匯率。
  const currencyOptions = tripCurrencies.slice(0, 24).map((c) => ({
    label: c === trip.baseCurrency ? `${c}（本位幣）` : c,
    value: c,
    default: c === scanResult.currency
  }));
  currencyOptions.push({
    label: '➕ 其他幣別（手動輸入代碼）',
    value: SCAN_CURRENCY_CUSTOM_VALUE,
    description: '若清單裡沒有這趟行程要用的幣別'
  });

  // customId 都帶上 `:batchId:index` 後綴，讓每張圖各自的下拉選單/按鈕互相獨立，
  // 不會因為使用者同時開著好幾張的確認卡片，而互相蓋掉彼此的暫存資料。
  const currencySelectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`exp_select_scan_currency${idSuffix}`)
      .setPlaceholder('💱 若幣別辨識錯誤，可在這裡手動修改')
      .addOptions(currencyOptions)
  );

  const btnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`exp_btn_scan_confirm${idSuffix}`).setLabel('📝 開啟表單確認並送出').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('exp_btn_scan_start').setLabel('🔄 重新掃描').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nav_main').setLabel('🏠 返回主控台').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [resultEmbed], components: [currencySelectRow, btnRow] };
}


module.exports = {
  BILL_SCAN_TIMEOUT_MS,
  BILL_SCAN_MAX_IMAGES_PER_BATCH,
  BILL_SCAN_RATE_LIMIT_MAX,
  BILL_SCAN_RATE_LIMIT_WINDOW_MS,
  billScanRateLimiter,
  isImageAttachment,
  billScanKey,
  stopActiveBillScan,
  activeBillScanCollectors,
  generateBatchId,
  scanItemCacheUserId,
  parseScanItemSuffix,
  SCAN_CURRENCY_CUSTOM_VALUE,
  SCAN_CONFIDENCE_META,
  buildScanResultView
};
