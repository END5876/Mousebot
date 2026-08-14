'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags
} = require('discord.js');
const storage = require('../../utils/storage');
const { resolveTrip, resolveTripById, memberDisplay } = require('../../utils/tripHelper');
const { showMainMenu } = require('../../commands/splitbill');
const { parseLedgerSuffix } = require('./helpers');
const { stopActiveBillScan, parseScanItemSuffix, scanItemCacheUserId } = require('./billScan');
const { startBillScan } = require('./billScanFlow');
const { renderLedgerPage } = require('./ledger');
const { completeExpenseLogging } = require('./expenseCompletion');

async function handleButton(interaction, cache) {
    const { customId, guildId, user } = interaction;
    // 🔒 [修正：切換行程影響全體] 用發起互動的使用者自己的作用行程
    const { trip } = resolveTrip(guildId, null, user.id);

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
        .setCustomId(`exp_modal_add_${currency}::${trip.id}`)
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
      // 🔒 [修正：race condition] 優先用流程一開始鎖定的 tripId 寫入，避免中途漂移
      const pinnedTrip = resolveTripById(guildId, state.tripId) || trip;
      return completeExpenseLogging(interaction, pinnedTrip, state, allMemberIds, cache);
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
}

module.exports = { handleButton };
