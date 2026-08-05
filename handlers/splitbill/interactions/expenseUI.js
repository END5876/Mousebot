'use strict';

const { 
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, 
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags 
} = require('discord.js');
const storage = require('../utils/storage');
const { resolveTrip, memberDisplay } = require('../utils/tripHelper');
const { equalSplit, validateCustomSplit, fetchRealTimeRate, round2, parseMoneyInput, formatMoneyDisplay } = require('../utils/calculator');
const { addDeposit } = require('../utils/deposit');
const { showMainMenu } = require('../commands/splitbill');
const { scanBillImage } = require('../utils/billScanner');
const { SlidingWindowRateLimiter } = require('../utils/rateLimiter');
// processAttachments 內部（fetchImageAsBase64 -> fetchImageUrlAsBase64）已經會把圖片
// resize 到最長邊 1024px 以內並轉成 webp 再回傳 base64，因此帳單辨識這邊不需要再自己做壓縮。
const { processAttachments } = require('../../ai/aiUtils');

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

function parseLedgerSuffix(suffix) {
  const [pagePart, sourcePart] = suffix.split('__');
  const source = sourcePart === 'set' ? 'set' : 'exp';
  const page = pagePart === 'last' ? Infinity : (parseInt(pagePart, 10) || 0);
  return { page, source };
}

function getBackNavConfig(source) {
  if (source === 'set') {
    return { customId: 'set_nav', label: '⬅️ 返回結算與淨額中心' };
  }
  return { customId: 'exp_nav', label: '🔙 返回記帳管理' };
}

function formatAmountConversion(amount, currency, amountInBase, baseCurrency) {
  const amountText = `${round2(amount)} ${currency}`;
  if (currency === baseCurrency) return amountText;
  return `${amountText} ➔ ${round2(amountInBase)} ${baseCurrency}`;
}

function formatParticipantsList(trip, participants, currency) {
  if (!participants || !participants.length) return '無';

  const amounts = participants.map(p => round2(p.amount));
  const isEqualSplit = amounts.every(a => Math.abs(a - amounts[0]) < 0.01);

  if (isEqualSplit) {
    const names = participants.map(p => memberDisplay(trip, p.userId)).join('、');
    return `${participants.length}人平分，每人 ${amounts[0]} ${currency}\n> 　${names}`;
  }

  return participants
    .map(p => `　• ${memberDisplay(trip, p.userId)}：${round2(p.amount)} ${currency}`)
    .join('\n> ');
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

module.exports = {
  async handleButton(interaction, cache) {
    const { customId, guildId } = interaction;
    const { trip } = resolveTrip(guildId);

    // 除了「開始掃描」本身（它會在 startBillScan 內部自行處理舊 collector 的替換）之外，
    // 只要使用者點了任何其他按鈕，就視為離開了帳單掃描等待畫面，
    // 順手停掉背景 collector，避免上面提到的重複呼叫 / interaction 互搶問題。
    if (customId !== 'exp_btn_scan_start') {
      stopActiveBillScan(guildId, interaction.user.id, 'navigated_away');
    }

    if (customId === 'nav_main') return showMainMenu(interaction);

    if (customId === 'exp_nav') {
      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('💸 記帳管理分頁')
        .setDescription(`當前行程：**${trip.name}**\n請選擇您要執行的記帳操作：`);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('exp_btn_add_start').setLabel('➕ 新增花費').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('exp_btn_scan_start').setLabel('📷 掃描帳單新增').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('exp_btn_deposit_start').setLabel('💰 收取金額').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('exp_btn_ledger_last__exp').setLabel('📒 總帳目清單／刪除').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('nav_main').setLabel('🏠 返回主控台').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    if (customId === 'exp_btn_deposit_start') {
      if (!trip.members || trip.members.length < 2) {
        return interaction.reply({ content: '⚠️ 此行程成員不足兩人，無法使用訂金功能！', flags: MessageFlags.Ephemeral });
      }

      const currencies = Object.keys(trip.rates);
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('💰 步驟 1/4：選擇幣別')
        .setDescription('這筆訂金是用哪種幣別收的？\n*(訂金會保留原始幣別，不會預先換算成本位幣)*');

      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('exp_select_deposit_currency')
          .setPlaceholder('選擇訂金幣別...')
          .addOptions(
            currencies.map(c => ({
              label: `${c}${c === trip.baseCurrency ? ' (基準本位幣)' : ''}`,
              value: c
            })).slice(0, 25)
          )
      );

      const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('exp_nav').setLabel('⬅️ 取消並返回').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [selectRow, navRow] });
    }

    if (customId === 'exp_btn_add_start') {
      if (!trip.members || trip.members.length === 0) {
        return interaction.reply({ content: '⚠️ 此行程目前沒有任何成員，請先到「成員管理」新增成員！', flags: MessageFlags.Ephemeral });
      }

      const currencies = Object.keys(trip.rates);
      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('💱 步驟 1/3：請選擇幣別')
        .setDescription('為方便計算，請先由下方選單選擇此筆花費的「結帳幣別」。');

      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('exp_select_currency')
          .setPlaceholder('選擇結帳貨幣...')
          .addOptions(
            currencies.map(c => ({
              label: `${c}${c === trip.baseCurrency ? ' (基準本位幣)' : ''}`,
              description: c !== trip.baseCurrency ? `參考匯率: ${trip.rates[c]}` : '匯率: 1',
              value: c
            })).slice(0, 25)
          )
      );

      const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('exp_nav').setLabel('⬅️ 取消並返回').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [selectRow, navRow] });
    }

    if (customId === 'exp_btn_scan_start') {
      if (!trip.members || trip.members.length === 0) {
        return interaction.reply({ content: '⚠️ 此行程目前沒有任何成員，請先到「成員管理」新增成員！', flags: MessageFlags.Ephemeral });
      }

      if (!process.env.GEMINI_API_KEY) {
        return interaction.reply({ content: '⚠️ 尚未設定 GEMINI_API_KEY，帳單辨識功能目前無法使用，請改用「➕ 新增花費」手動輸入。', flags: MessageFlags.Ephemeral });
      }

      return startBillScan(interaction, trip, cache);
    }

    if (customId.startsWith('exp_btn_scan_confirm')) {
      const { batchId, index } = parseScanItemSuffix(customId, 'exp_btn_scan_confirm');
      const itemCacheUserId = scanItemCacheUserId(interaction.user.id, batchId, index);
      const state = cache.get(guildId, itemCacheUserId);
      if (!state || !state.scanResult) {
        return interaction.reply({ content: '⚠️ 辨識結果已逾期失效，請重新掃描一次。', flags: MessageFlags.Ephemeral });
      }

      const { description, amount, currency } = state.scanResult;

      const modal = new ModalBuilder()
        .setCustomId(`exp_modal_add_${currency}`)
        .setTitle(`確認並送出花費 (${currency})`);

      const descInput = new TextInputBuilder()
        .setCustomId('desc')
        .setLabel('項目名稱 (例如：計程車、晚餐)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      if (description) descInput.setValue(String(description).slice(0, 100));

      const amountInput = new TextInputBuilder()
        .setCustomId('amount')
        .setLabel(`金額 (單位: ${currency})`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      if (amount) amountInput.setValue(String(amount));

      const rateInput = new TextInputBuilder()
        .setCustomId('custom_rate')
        .setLabel(`自訂匯率 (1 ${currency} = ? ${trip.baseCurrency})`)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('💡 留空將自動抓取當下即時網路匯率')
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(descInput),
        new ActionRowBuilder().addComponents(amountInput),
        new ActionRowBuilder().addComponents(rateInput)
      );

      return interaction.showModal(modal);
    }

    if (customId.startsWith('exp_btn_ledger_')) {
      const suffix = customId.substring('exp_btn_ledger_'.length);
      const { page, source } = parseLedgerSuffix(suffix);
      return renderLedgerPage(interaction, trip, page, null, source);
    }

    // ✅ 新增：使用者在確認畫面點擊「確認刪除」，這時才真正執行刪除動作
    if (customId === 'exp_btn_confirm_delete') {
      const state = cache.get(guildId, interaction.user.id);
      if (!state || !state.pendingDelete) {
        return interaction.reply({ content: '⚠️ 確認逾時或快取失效，請重新操作一次刪除流程。', flags: MessageFlags.Ephemeral });
      }

      const { type, id: realId, page, source } = state.pendingDelete;
      cache.delete(guildId, interaction.user.id);

      if (type === 'expense') {
        const idx = trip.expenses.findIndex(e => e.id === realId);
        if (idx === -1) {
          return renderLedgerPage(interaction, trip, page, '⚠️ 找不到此花費帳目，可能已被其他人刪除。', source);
        }
        const deleted = trip.expenses.splice(idx, 1)[0];
        storage.persist();
        return renderLedgerPage(interaction, trip, page, `🗑️ 已成功刪除花費：**${deleted.description}** (${deleted.amount} ${deleted.currency})`, source);
      } else if (type === 'deposit') {
        const idx = trip.deposits.findIndex(d => d.id === realId);
        if (idx === -1) {
          return renderLedgerPage(interaction, trip, page, '⚠️ 找不到此訂金紀錄，可能已被其他人刪除。', source);
        }
        const deleted = trip.deposits.splice(idx, 1)[0];
        storage.persist();
        return renderLedgerPage(interaction, trip, page, `🗑️ 已成功刪除訂金紀錄：**${memberDisplay(trip, deleted.payerId)} 預付給 ${memberDisplay(trip, deleted.collectorId)}** (${deleted.amount} ${deleted.currency})`, source);
      }
    }

    // ✅ 新增：使用者在確認畫面點擊「取消」，放棄本次刪除，直接回到原頁面（資料不變）
    if (customId === 'exp_btn_cancel_delete') {
      const state = cache.get(guildId, interaction.user.id);
      const pending = state && state.pendingDelete;
      cache.delete(guildId, interaction.user.id);

      const page = pending ? pending.page : 0;
      const source = pending ? pending.source : 'exp';
      return renderLedgerPage(interaction, trip, page, '↩️ 已取消刪除操作，帳目未變動。', source);
    }

    if (customId === 'exp_btn_split_all') {
      const state = cache.get(guildId, interaction.user.id);
      if (!state) return interaction.reply({ content: '⚠️ 狀態過期，請重新操作。', flags: MessageFlags.Ephemeral });
      const allMemberIds = trip.members.map(m => m.id);
      return completeExpenseLogging(interaction, trip, state, allMemberIds, cache);
    }

    if (customId === 'exp_btn_split_custom') {
      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle('🎯 選擇分攤成員')
        .setDescription('請使用下方選單選擇需要一起平分這筆錢的成員：');

      const memberOptions = trip.members.slice(0, 25).map(m => ({ label: m.name, value: m.id }));
      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('exp_select_participants')
          .setPlaceholder('挑選分攤此花費的人...')
          .setMinValues(1)
          .setMaxValues(memberOptions.length)
          .addOptions(memberOptions)
      );

      return interaction.update({ embeds: [embed], components: [selectRow] });
    }

    if (customId === 'exp_btn_split_custom_amount') {
      const state = cache.get(guildId, interaction.user.id);
      if (!state) return interaction.reply({ content: '⚠️ 狀態過期，請重新操作。', flags: MessageFlags.Ephemeral });

      const maxSelect = Math.min(trip.members.length, 5);
      const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('✏️ 自訂金額分攤')
        .setDescription(
          `總花費：**${state.amount} ${state.currency}**\n\n` +
          `請選擇需要「指定各自應付金額」的成員。\n` +
          `*(⚠️ Discord 表單限制，最多可選 ${maxSelect} 人；未被選到的人視為不參與此筆分攤)*\n` +
          `*(💡 若某人不需付錢，填入 0 即可)*`
        );

      const memberOptions = trip.members.slice(0, 25).map(m => ({ label: m.name, value: m.id }));
      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('exp_select_custom_participants')
          .setPlaceholder(`選擇成員 (最多 ${maxSelect} 人)...`)
          .setMinValues(1)
          .setMaxValues(maxSelect)
          .addOptions(memberOptions)
      );

      return interaction.update({ embeds: [embed], components: [selectRow] });
    }
  },

  async handleModal(interaction, cache) {
    if (interaction.customId.startsWith('exp_modal_scan_custom_currency')) {
      const { guildId, user } = interaction;
      const { trip } = resolveTrip(guildId);
      const { batchId, index } = parseScanItemSuffix(interaction.customId, 'exp_modal_scan_custom_currency');
      const itemCacheUserId = scanItemCacheUserId(user.id, batchId, index);
      const state = cache.get(guildId, itemCacheUserId);

      if (!state || !state.scanResult) {
        return interaction.reply({ content: '⚠️ 辨識結果已逾期失效，請重新掃描一次。', flags: MessageFlags.Ephemeral });
      }

      const currency = interaction.fields.getTextInputValue('currency').trim().toUpperCase();
      const rateStr = interaction.fields.getTextInputValue('rate');

      if (!/^[A-Z]{2,6}$/.test(currency)) {
        return interaction.reply({ content: '⚠️ 幣別代碼格式錯誤，請輸入 2~6 個英文字母（例如：EUR）。', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferUpdate();

      let rateNote = '';

      // 這個幣別如果這趟行程還沒設定過，比照「行程設定」既有的新增幣別流程：
      // 手動匯率優先，留空則嘗試抓即時匯率；成功後直接寫回 trip.rates，
      // 讓它從此變成這趟行程的正式幣別（之後手動記帳、下拉選單都會看到）。
      if (trip.rates[currency] === undefined) {
        const manualRate = parseMoneyInput(rateStr);
        let rate;
        let rateSource;

        if (rateStr && !isNaN(manualRate) && manualRate > 0) {
          rate = manualRate;
          rateSource = '手動自訂';
        } else {
          const liveRate = await fetchRealTimeRate(currency, trip.baseCurrency);
          if (liveRate) {
            rate = liveRate;
            rateSource = '網路即時';
          } else {
            // 抓不到即時匯率、使用者也沒手動填，沒辦法幫他把這個幣別加進行程——
            // 保留原本的辨識結果畫面，附註告訴他怎麼補救，而不是讓整個流程卡死。
            const view = buildScanResultView(trip, state.scanResult, {
              extraFooterNote: `\n❌ 無法自動抓取 \`${currency}\` 的即時匯率，且你沒有手動輸入匯率，因此未新增此幣別。可以再選一次「➕ 其他幣別」並手動填入匯率。`
            });
            return interaction.editReply(view);
          }
        }

        trip.rates[currency] = rate;
        storage.persist();
        rateNote = `（已新增為此行程幣別，匯率 1 ${currency} = ${rate} ${trip.baseCurrency}，${rateSource}）`;
      }

      state.scanResult.currency = currency;
      const view = buildScanResultView(trip, state.scanResult, {
        currencyFieldNote: rateNote,
        extraFooterNote: '\n💡 已手動更改幣別，開啟表單後記得確認匯率是否正確（留空將自動抓即時匯率）。'
      });
      return interaction.editReply(view);
    }

    if (interaction.customId === 'exp_modal_multi_deposit') {
      const { guildId, user } = interaction;
      const { trip } = resolveTrip(guildId);
      const state = cache.get(guildId, user.id);

      if (!state || !state.depositCurrency || !state.depositCollectorId || !state.depositPayerIds) {
        return interaction.reply({ content: '⚠️ 快取失效，請重新操作。', flags: MessageFlags.Ephemeral });
      }

      let note = '預收款/訂金';
      if (state.depositPayerIds.length < 5) {
        try {
          const inputNote = interaction.fields.getTextInputValue('dep_note');
          if (inputNote) note = inputNote;
        } catch (e) {}
      }

      const depositsAdded = [];
      let totalAmount = 0;

      try {
        for (let i = 0; i < state.depositPayerIds.length; i++) {
          const amountStr = interaction.fields.getTextInputValue(`dep_amount_${i}`);
          const amount = parseMoneyInput(amountStr);
          
          if (isNaN(amount) || amount <= 0) {
            throw new Error(`第 ${i + 1} 筆金額格式錯誤，必須大於 0。`);
          }

          const deposit = addDeposit(trip, {
            collectorId: state.depositCollectorId,
            payerId: state.depositPayerIds[i],
            amount,
            currency: state.depositCurrency,
            note
          });
          
          depositsAdded.push(deposit);
          totalAmount += amount;
        }
        
        storage.persist();
        cache.delete(guildId, user.id);

        const payerMentions = depositsAdded.map(d => `<@${d.payerId}>(${d.amount})`).join('、');
        const msg = `✅ **預收款紀錄成功！** <@${state.depositCollectorId}> 共收了 ${totalAmount} ${state.depositCurrency}。\n付款人：${payerMentions}\n備註：${note}`;
        
        return showMainMenu(interaction, msg);
      } catch (err) {
        return interaction.reply({ content: `❌ 錯誤：${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    if (interaction.customId.startsWith('exp_modal_add_')) {
      const { guildId, user } = interaction;
      const { trip } = resolveTrip(guildId);

      const currency = interaction.customId.replace('exp_modal_add_', '');
      const desc = interaction.fields.getTextInputValue('desc');
      const amount = parseMoneyInput(interaction.fields.getTextInputValue('amount'));
      const customRateStr = interaction.fields.getTextInputValue('custom_rate');

      if (isNaN(amount) || amount <= 0) {
        return interaction.reply({ content: '⚠️ 請輸入正確的大於 0 的金額數字。', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferUpdate();

      let actualRate;
      let rateSource;
      const customRate = parseMoneyInput(customRateStr);

      if (customRateStr && !isNaN(customRate) && customRate > 0) {
        actualRate = customRate;
        rateSource = '手動自訂';
      } else if (currency === trip.baseCurrency) {
        actualRate = 1;
        rateSource = '本位幣';
      } else {
        const liveRate = await fetchRealTimeRate(currency, trip.baseCurrency);
        if (liveRate) {
          actualRate = liveRate;
          rateSource = '網路即時';
        } else {
          actualRate = trip.rates[currency] ?? 1;
          rateSource = '行程預設';
        }
      }

      cache.set(guildId, user.id, {
        id: `id_${Date.now().toString(36)}`,
        description: desc,
        amount,
        currency,
        exchangeRate: actualRate,
        rateSource
      });

      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle('👤 請選擇代墊者')
        .setDescription(
          `項目：**${desc}**\n` +
          `金額：**${amount} ${currency}**\n` +
          `匯率：**1 ${currency} = ${actualRate} ${trip.baseCurrency}** (${rateSource})\n\n` +
          `👉 誰先幫大家付了這筆錢？\n*(💡 若為多人合資代墊，請直接複選)*`
        );

      const memberOptions = trip.members.slice(0, 25).map(m => ({ label: m.name, value: m.id }));
      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('exp_select_payer')
          .setPlaceholder('選擇代墊者 (可多選，最多5人)...')
          .setMinValues(1)
          .setMaxValues(Math.min(memberOptions.length, 5))
          .addOptions(memberOptions)
      );

      return interaction.editReply({ embeds: [embed], components: [selectRow] });
    }

    if (interaction.customId === 'exp_modal_multi_payer') {
      const { guildId, user } = interaction;
      const { trip } = resolveTrip(guildId);
      const state = cache.get(guildId, user.id);
      
      if (!state || !state.tempPayerIds) return interaction.reply({ content: '⚠️ 快取過期，請重新開啟。', flags: MessageFlags.Ephemeral });

      let sum = 0;
      const payers = [];

      for (let i = 0; i < state.tempPayerIds.length; i++) {
        const valStr = interaction.fields.getTextInputValue(`payer_${i}`);
        const val = parseMoneyInput(valStr);
        if (isNaN(val) || val < 0) {
          return interaction.reply({ content: `⚠️ 請輸入正確的數字（不可為負數）。`, flags: MessageFlags.Ephemeral });
        }
        sum += val;
        payers.push({ userId: state.tempPayerIds[i], amount: val });
      }

      if (Math.abs(sum - state.amount) > 0.01) {
        cache.delete(guildId, user.id);
        return showMainMenu(interaction, `⚠️ **記帳已取消**：多人代墊金額加總 (**${sum}**) 不等於總花費 (**${state.amount}**)！請重新操作。`);
      }

      state.payers = payers;
      delete state.tempPayerIds;

      return renderSplitMethodUI(interaction, state);
    }

    if (interaction.customId === 'exp_modal_custom_split') {
      const { guildId, user } = interaction;
      const { trip } = resolveTrip(guildId);
      const state = cache.get(guildId, user.id);

      if (!state || !state.tempCustomParticipantIds) {
        return interaction.reply({ content: '⚠️ 快取過期，請重新開啟。', flags: MessageFlags.Ephemeral });
      }

      const shares = [];
      for (let i = 0; i < state.tempCustomParticipantIds.length; i++) {
        const valStr = interaction.fields.getTextInputValue(`share_${i}`);
        const val = parseMoneyInput(valStr);
        if (isNaN(val) || val < 0) {
          return interaction.reply({ content: '⚠️ 請輸入正確的數字（不可為負數，免費請填 0）。', flags: MessageFlags.Ephemeral });
        }
        shares.push({ userId: state.tempCustomParticipantIds[i], share: round2(val) });
      }

      try {
        validateCustomSplit(state.amount, shares);
      } catch (err) {
        cache.delete(guildId, user.id);
        return showMainMenu(interaction, `⚠️ **記帳已取消**：${err.message}`);
      }

      delete state.tempCustomParticipantIds;
      return completeExpenseLoggingWithShares(interaction, trip, state, shares, cache);
    }
  },

  async handleSelectMenu(interaction, cache) {
    const { customId, guildId, values, user } = interaction;
    const { trip } = resolveTrip(guildId);

    if (customId.startsWith('exp_select_scan_currency')) {
      const { batchId, index } = parseScanItemSuffix(customId, 'exp_select_scan_currency');
      const itemCacheUserId = scanItemCacheUserId(user.id, batchId, index);
      const state = cache.get(guildId, itemCacheUserId);
      if (!state || !state.scanResult) {
        return interaction.reply({ content: '⚠️ 辨識結果已逾期失效，請重新掃描一次。', flags: MessageFlags.Ephemeral });
      }

      const selected = values[0];

      // 使用者選了「➕ 其他幣別」：這趟行程目前的幣別清單裡沒有他要的，跳一個小 Modal
      // 讓他手動輸入代碼，流程比照「行程設定」既有的新增幣別（自動抓即時匯率／手動輸入匯率）。
      // Modal 的 customId 也要帶上 batchId/index，submit 時才知道是在改哪一張圖的結果。
      if (selected === SCAN_CURRENCY_CUSTOM_VALUE) {
        const modal = new ModalBuilder()
          .setCustomId(`exp_modal_scan_custom_currency:${batchId}:${index}`)
          .setTitle('🪙 輸入其他幣別代碼');

        const curInput = new TextInputBuilder()
          .setCustomId('currency')
          .setLabel('幣別代碼 (例如：EUR、SGD、CNY)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(6);

        const rateInput = new TextInputBuilder()
          .setCustomId('rate')
          .setLabel(`匯率：1 該幣別 = ? ${trip.baseCurrency}`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('💡 若此行程已有這個幣別可留空；沒有的話留空將自動抓即時匯率')
          .setRequired(false);

        modal.addComponents(new ActionRowBuilder().addComponents(curInput), new ActionRowBuilder().addComponents(rateInput));
        return interaction.showModal(modal);
      }

      // 直接覆寫使用者手動選擇的幣別；stateCache.get() 回傳的是同一個物件參照，
      // 且 get() 當下已經順帶延長了這筆狀態的 TTL，所以這裡不需要再呼叫 cache.set()。
      state.scanResult.currency = selected;

      // 使用者已經手動選擇了，AI 原本判讀成什麼、有沒有對應成功都不重要了，重新渲染時不再顯示那則附註；
      // 改附上一句提醒——確認表單裡的自訂匯率欄位，避免使用者以為換了幣別但金額/匯率沒對應更新。
      const view = buildScanResultView(trip, state.scanResult, {
        extraFooterNote: '\n💡 已手動更改幣別，開啟表單後記得確認匯率是否正確（留空將自動抓即時匯率）。'
      });
      return interaction.update(view);
    }

    if (customId === 'exp_select_deposit_currency') {
      const selectedCurrency = values[0];
      cache.set(guildId, user.id, { depositCurrency: selectedCurrency });

      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('💰 步驟 2/4：選擇收款人')
        .setDescription(`幣別：**${selectedCurrency}**\n\n誰負責「代收」這筆訂金？\n*(例如：負責統一訂機票/住宿的人)*`);

      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('exp_select_deposit_collector')
          .setPlaceholder('選擇收款人...')
          .addOptions(trip.members.slice(0, 25).map(m => ({ label: m.name, value: m.id })))
      );

      return interaction.update({ embeds: [embed], components: [selectRow] });
    }

    if (customId === 'exp_select_deposit_collector') {
      const state = cache.get(guildId, user.id);
      if (!state || !state.depositCurrency) return interaction.reply({ content: '⚠️ 快取失效，請重新操作。', flags: MessageFlags.Ephemeral });
      state.depositCollectorId = values[0];
      
      const availableMembers = trip.members.filter(m => m.id !== values[0]);
      const maxSelect = Math.min(availableMembers.length, 5);

      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('💰 步驟 3/4：選擇付款人')
        .setDescription(`幣別：**${state.depositCurrency}**\n\n誰「付錢」給了收款人？\n*(💡 可多選，最多 ${maxSelect} 人)*`);

      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('exp_select_deposit_payer')
          .setPlaceholder(`選擇付款人 (可多選，最多 ${maxSelect} 人)...`)
          .setMinValues(1)
          .setMaxValues(maxSelect)
          .addOptions(availableMembers.slice(0, 25).map(m => ({ label: m.name, value: m.id })))
      );

      return interaction.update({ embeds: [embed], components: [selectRow] });
    }

    if (customId === 'exp_select_deposit_payer') {
      const state = cache.get(guildId, user.id);
      if (!state || !state.depositCurrency || !state.depositCollectorId) {
        return interaction.reply({ content: '⚠️ 快取失效，請重新操作。', flags: MessageFlags.Ephemeral });
      }
      
      state.depositPayerIds = values;

      const modal = new ModalBuilder()
        .setCustomId('exp_modal_multi_deposit')
        .setTitle(`💰 步驟 4/4：輸入訂金金額 (${state.depositCurrency})`);

      values.forEach((id, idx) => {
        const memberName = trip.members.find(m => m.id === id).name;
        const amountInput = new TextInputBuilder()
          .setCustomId(`dep_amount_${idx}`)
          .setLabel(`${memberName} 付了多少 (${state.depositCurrency})？`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
      });

      if (values.length < 5) {
        const noteInput = new TextInputBuilder()
          .setCustomId('dep_note')
          .setLabel('備註 (選填，例如：機票+住宿訂金)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false);
        modal.addComponents(new ActionRowBuilder().addComponents(noteInput));
      }
      
      return interaction.showModal(modal);
    }

    if (customId === 'exp_select_currency') {
      const selectedCurrency = values[0];
      const modal = new ModalBuilder()
        .setCustomId(`exp_modal_add_${selectedCurrency}`)
        .setTitle(`步驟 2/3：新增花費 (${selectedCurrency})`);

      const descInput = new TextInputBuilder().setCustomId('desc').setLabel('項目名稱 (例如：計程車、晚餐)').setStyle(TextInputStyle.Short).setRequired(true);
      const amountInput = new TextInputBuilder().setCustomId('amount').setLabel(`金額 (單位: ${selectedCurrency})`).setStyle(TextInputStyle.Short).setRequired(true);
      const rateInput = new TextInputBuilder().setCustomId('custom_rate').setLabel(`自訂匯率 (1 ${selectedCurrency} = ? ${trip.baseCurrency})`).setStyle(TextInputStyle.Short).setPlaceholder('💡 留空將自動抓取當下即時網路匯率').setRequired(false);

      modal.addComponents(new ActionRowBuilder().addComponents(descInput), new ActionRowBuilder().addComponents(amountInput), new ActionRowBuilder().addComponents(rateInput));
      return interaction.showModal(modal);
    }

    if (customId === 'exp_select_payer') {
      const state = cache.get(guildId, user.id);
      if (!state) return interaction.reply({ content: '⚠️ 快取過期，請重新開啟。', flags: MessageFlags.Ephemeral });

      const payerIds = values;
      const invalid = payerIds.filter(id => !trip.members.some(m => m.id === id));
      if (invalid.length) {
        return interaction.reply({ content: '⚠️ 選擇的使用者不在此行程的成員名單內！', flags: MessageFlags.Ephemeral });
      }

      if (payerIds.length === 1) {
        state.payers = [{ userId: payerIds[0], amount: state.amount }];
        return renderSplitMethodUI(interaction, state);
      } else {
        state.tempPayerIds = payerIds; 
        const modal = new ModalBuilder().setCustomId('exp_modal_multi_payer').setTitle(`輸入多人代墊金額 (總計: ${state.amount})`);

        payerIds.forEach((id, idx) => {
          const memberName = trip.members.find(m => m.id === id).name;
          const input = new TextInputBuilder().setCustomId(`payer_${idx}`).setLabel(`${memberName} 付了多少？`).setStyle(TextInputStyle.Short).setRequired(true);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
        });

        return interaction.showModal(modal);
      }
    }

    if (customId === 'exp_select_participants') {
      const state = cache.get(guildId, user.id);
      if (!state) return interaction.reply({ content: '⚠️ 快取已失效。', flags: MessageFlags.Ephemeral });

      const participantIds = values.filter(id => trip.members.some(m => m.id === id));
      if (!participantIds.length) return interaction.reply({ content: '⚠️ 所選成員皆不在行程中。', flags: MessageFlags.Ephemeral });

      return completeExpenseLogging(interaction, trip, state, participantIds, cache);
    }

    if (customId === 'exp_select_custom_participants') {
      const state = cache.get(guildId, user.id);
      if (!state) return interaction.reply({ content: '⚠️ 快取過期，請重新開啟。', flags: MessageFlags.Ephemeral });

      const invalid = values.filter(id => !trip.members.some(m => m.id === id));
      if (invalid.length) {
        return interaction.reply({ content: '⚠️ 選擇的使用者不在此行程的成員名單內！', flags: MessageFlags.Ephemeral });
      }

      state.tempCustomParticipantIds = values;

      const modal = new ModalBuilder()
        .setCustomId('exp_modal_custom_split')
        .setTitle(`✏️ 輸入各自應付金額 (總計: ${state.amount})`);

      values.forEach((id, idx) => {
        const memberName = trip.members.find(m => m.id === id).name;
        const input = new TextInputBuilder()
          .setCustomId(`share_${idx}`)
          .setLabel(`${memberName} 應付多少 (免費請填 0)？`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('例如：0、1000、2000')
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
      });

      return interaction.showModal(modal);
    }

    // ✅ 修改：不再直接刪除，改為先暫存待刪除紀錄，顯示確認畫面
    // customId 仍帶有「目前頁碼__來源」，讓確認/取消按鈕都能記得回到哪一頁、哪個來源分頁
    if (customId.startsWith('exp_select_delete_')) {
      const suffix = customId.substring('exp_select_delete_'.length);
      const { page, source } = parseLedgerSuffix(suffix);
      const [type, ...rest] = values[0].split('_');
      const realId = rest.join('_');

      let record, titleText, detailText, color;

      if (type === 'expense') {
        record = trip.expenses.find(e => e.id === realId);
        if (!record) return interaction.reply({ content: '⚠️ 找不到此花費帳目，可能已被其他人刪除。', flags: MessageFlags.Ephemeral });

        const amountText = formatAmountConversion(record.amount, record.currency, record.amountInBase, trip.baseCurrency);
        const payers = record.payers.map(p => memberDisplay(trip, p.userId)).join('、');
        const participantsText = formatParticipantsList(trip, record.participants, record.currency);

        titleText = `[花費] ${record.description}`;
        color = 0xe74c3c;
        detailText =
          `💰 金額：${amountText}\n` +
          `👤 代墊：${payers}\n` +
          `📊 分攤：${participantsText}`;
      } else if (type === 'deposit') {
        record = trip.deposits.find(d => d.id === realId);
        if (!record) return interaction.reply({ content: '⚠️ 找不到此訂金紀錄，可能已被其他人刪除。', flags: MessageFlags.Ephemeral });

        const amountText = formatAmountConversion(record.amount, record.currency, record.amountInBase, trip.baseCurrency);
        titleText = `[訂金] ${memberDisplay(trip, record.payerId)} → ${memberDisplay(trip, record.collectorId)}`;
        color = 0xe74c3c;
        detailText =
          `💰 金額：${amountText}` +
          (record.note ? `\n📝 備註：${record.note}` : '');
      } else {
        return interaction.reply({ content: '⚠️ 無法識別的紀錄類型。', flags: MessageFlags.Ephemeral });
      }

      // 暫存待刪除資訊，供確認/取消按鈕使用
      cache.set(guildId, user.id, {
        pendingDelete: { type, id: realId, page, source }
      });

      const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle('⚠️ 確認刪除此筆紀錄？')
        .setDescription(
          `**${titleText}**\n${detailText}\n\n` +
          `❗ 此操作**無法復原**，請再次確認是否要刪除。`
        );

      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('exp_btn_confirm_delete').setLabel('✅ 確認刪除').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('exp_btn_cancel_delete').setLabel('↩️ 取消').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ content: '', embeds: [embed], components: [confirmRow] });
    }
  }
};

const LEDGER_PAGE_SIZE = 8;

function renderLedgerPage(interaction, trip, page, alertMsg = null, source = 'exp') {
  const allRecords = [
    ...trip.expenses.map(e => ({ ...e, type: 'expense' })),
    ...(trip.deposits || []).map(d => ({ ...d, type: 'deposit' }))
  ].sort((a, b) => a.createdAt - b.createdAt);

  const content = typeof alertMsg === 'string' ? alertMsg : '';
  const backNav = getBackNavConfig(source);

  if (!allRecords.length) {
    const embed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle(`📒 「${trip.name}」總帳目清單`)
      .setDescription('📭 目前尚無任何花費或訂金紀錄。');

    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(backNav.customId).setLabel(backNav.label).setStyle(ButtonStyle.Secondary)
    );
    return interaction.update({ content, embeds: [embed], components: [navRow] });
  }

  const totalPages = Math.max(1, Math.ceil(allRecords.length / LEDGER_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * LEDGER_PAGE_SIZE;
  const pageRecords = allRecords.slice(start, start + LEDGER_PAGE_SIZE);

  const lines = pageRecords.map((r, idx) => {
    const globalIdx = start + idx + 1;
    const dateStr = new Date(r.createdAt).toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    const amountText = formatAmountConversion(r.amount, r.currency, r.amountInBase, trip.baseCurrency);

    if (r.type === 'expense') {
      const payers = r.payers.map(p => memberDisplay(trip, p.userId)).join('、');
      const participantsText = formatParticipantsList(trip, r.participants, r.currency);
      return `**#${globalIdx}** \`[花費]\` **${r.description}**\n${amountText}\n> 🕒 ${dateStr}・由 ${payers} 代墊\n> 💸 分攤：${participantsText}`;
    } else {
      const payer = memberDisplay(trip, r.payerId);
      const collector = memberDisplay(trip, r.collectorId);
      const noteText = r.note ? `\n> 📝 備註：${r.note}` : '';
      return `**#${globalIdx}** \`[訂金]\` **${payer} → ${collector}**\n${amountText}\n> 🕒 ${dateStr}${noteText}`;
    }
  }).join('\n\n');

  const totalsByCurrency = {};
  let totalExpenseBase = 0;
  for (const e of trip.expenses) {
    totalsByCurrency[e.currency] = (totalsByCurrency[e.currency] || 0) + e.amount;
    totalExpenseBase += e.amountInBase || 0;
  }
  const breakdownText = Object.entries(totalsByCurrency)
    .map(([currency, amount]) => `${round2(amount)} ${currency}`)
    .join(' + ');
  const totalDepositBase = (trip.deposits || []).reduce((sum, d) => sum + (d.amountInBase || 0), 0);

  const embed = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setTitle(`📒 「${trip.name}」總帳目清單`)
    .setDescription(lines)
    .addFields(
      {
        name: '📊 總覽',
        value:
          `🧾 花費筆數：\`${trip.expenses.length} 筆\`\n` +
          `💰 轉帳筆數：\`${(trip.deposits || []).length} 筆\`\n` +
          `💵 花費總額：**${round2(totalExpenseBase)} ${trip.baseCurrency}**${breakdownText ? `（${breakdownText}）` : ''}\n` +
          `🏦 訂金總額：**${round2(totalDepositBase)} ${trip.baseCurrency}**`
      }
    )
    .setFooter({ text: `第 ${safePage + 1} / ${totalPages} 頁・共 ${allRecords.length} 筆紀錄\n💡 可用下方選單直接刪除本頁任一筆（刪除前會再次確認）` });

  const deleteRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`exp_select_delete_${safePage}__${source}`)
      .setPlaceholder('🗑️ 選擇本頁一筆帳目將其刪除...')
      .addOptions(pageRecords.map(r => ({
        label: r.type === 'expense'
          ? `[花費] ${r.description} (${r.amount} ${r.currency})`.slice(0, 100)
          : `[訂金] ${memberDisplay(trip, r.payerId)} 給 ${memberDisplay(trip, r.collectorId)} (${r.amount} ${r.currency})`.slice(0, 100),
        value: `${r.type}_${r.id}`
      })))
  );

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`exp_btn_ledger_${safePage - 1}__${source}`).setLabel('⬅️ 上一頁').setStyle(ButtonStyle.Primary).setDisabled(safePage <= 0),
    new ButtonBuilder().setCustomId(`exp_btn_ledger_${safePage + 1}__${source}`).setLabel('➡️ 下一頁').setStyle(ButtonStyle.Primary).setDisabled(safePage >= totalPages - 1),
    new ButtonBuilder().setCustomId(backNav.customId).setLabel(backNav.label).setStyle(ButtonStyle.Secondary)
  );

  return interaction.update({ content, embeds: [embed], components: [deleteRow, navRow] });
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

function renderSplitMethodUI(interaction, state) {
  const payerMentions = state.payers.map(p => `<@${p.userId}>(${p.amount})`).join(', ');
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('⚖️ 步驟 3/3：選擇分攤方式')
    .setDescription(`代墊者：${payerMentions}\n\n請點選下方按鈕直接完成分攤：`);

  const btnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('exp_btn_split_all').setLabel('👥 全體平分').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('exp_btn_split_custom').setLabel('🎯 部分成員平分').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('exp_btn_split_custom_amount').setLabel('✏️ 自訂金額分攤').setStyle(ButtonStyle.Danger)
  );

  return interaction.update({ embeds: [embed], components: [btnRow] });
}

async function completeExpenseLogging(interaction, trip, state, participantIds, cache) {
  try {
    const shares = equalSplit(state.amount, participantIds);
    
    const newTotal = shares.reduce((sum, s) => sum + s.share, 0);
    const extra = newTotal - state.amount;
    
    if (extra > 0) {
      state.payers[0].amount += extra;
      state.amount = newTotal;
    }

    const amountInBase = Math.round((state.amount * state.exchangeRate + Number.EPSILON) * 100) / 100;

    const newExpense = {
      id: state.id,
      description: state.description,
      amount: state.amount,
      currency: state.currency,
      exchangeRate: state.exchangeRate,
      rateSource: state.rateSource,
      amountInBase,
      payers: state.payers,
      participants: shares.map(s => ({ userId: s.userId, amount: s.share })),
      createdAt: Date.now(),
      createdBy: interaction.user.id
    };

    trip.expenses.push(newExpense);
    storage.persist();
    cache.delete(interaction.guildId, interaction.user.id);

    const payerText = newExpense.payers.map(p => `<@${p.userId}>`).join(', ');
    const amountText = formatAmountConversion(newExpense.amount, newExpense.currency, amountInBase, trip.baseCurrency);
    const msg = `✅ **記帳成功！** 項目：${newExpense.description} | 金額：${amountText} | 代墊：${payerText}`;
    
    return showMainMenu(interaction, msg);

  } catch (err) {
    const errMsg = `❌ 核心記帳計算失敗：${err.message}`;
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: errMsg });
    }
    return interaction.reply({ content: errMsg, flags: MessageFlags.Ephemeral });
  }
}

  async function completeExpenseLoggingWithShares(interaction, trip, state, shares, cache) {
    try {
      const amountInBase = Math.round((state.amount * state.exchangeRate + Number.EPSILON) * 100) / 100;

      const newExpense = {
        id: state.id,
        description: state.description,
        amount: state.amount,
        currency: state.currency,
        exchangeRate: state.exchangeRate,
        rateSource: state.rateSource,
        amountInBase,
        payers: state.payers,
        participants: shares.map(s => ({ userId: s.userId, amount: s.share })),
        createdAt: Date.now(),
        createdBy: interaction.user.id
      };

      trip.expenses.push(newExpense);
      storage.persist();
      cache.delete(interaction.guildId, interaction.user.id);

      const payerText = newExpense.payers.map(p => `<@${p.userId}>`).join(', ');
      const shareText = shares.map(s => `<@${s.userId}>(${s.share})`).join('、');
      const amountText = formatAmountConversion(newExpense.amount, newExpense.currency, amountInBase, trip.baseCurrency);
      const msg = `✅ **記帳成功（自訂分攤）！** 項目：${newExpense.description} | 金額：${amountText}\n代墊：${payerText}\n各自應付：${shareText}`;
      
      return showMainMenu(interaction, msg);

    } catch (err) {
      const errMsg = `❌ 核心記帳計算失敗：${err.message}`;
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ content: errMsg });
      }
      return interaction.reply({ content: errMsg, flags: MessageFlags.Ephemeral });
    }
  }
