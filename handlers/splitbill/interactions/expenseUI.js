'use strict';

const { 
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, 
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags 
} = require('discord.js');
const storage = require('../utils/storage');
const { resolveTrip, memberDisplay } = require('../utils/tripHelper');
const { equalSplit, validateCustomSplit, fetchRealTimeRate, round2 } = require('../utils/calculator');
const { addDeposit } = require('../utils/deposit');
const { showMainMenu } = require('../commands/splitbill');

/**
 * 🆕 解析「總帳目清單」按鈕/選單 customId 尾端的「頁碼__來源」格式。
 * 例如：
 *   'last__set'  → { page: Infinity, source: 'set' }（從結算與淨額中心進入，跳到最後一頁）
 *   '3__exp'     → { page: 3, source: 'exp' }（從記帳管理分頁進入，第 3 頁）
 *   'last'（舊格式，沒有來源標記）→ 自動視為 source: 'exp'，維持向下相容
 *
 * 有了這個來源標記，翻頁、刪除、返回按鈕才能一路記住「使用者原本是從哪裡進來的」，
 * 讓「返回」永遠回到正確的分頁，而不是固定寫死回記帳管理分頁。
 */
function parseLedgerSuffix(suffix) {
  const [pagePart, sourcePart] = suffix.split('__');
  const source = sourcePart === 'set' ? 'set' : 'exp';
  const page = pagePart === 'last' ? Infinity : (parseInt(pagePart, 10) || 0);
  return { page, source };
}

/**
 * 依來源標記，決定「返回」按鈕要導向哪個分頁的主畫面。
 *   exp → 記帳管理分頁 (exp_nav)
 *   set → 結算與淨額中心 (set_nav)
 */
function getBackNavConfig(source) {
  if (source === 'set') {
    return { customId: 'set_nav', label: '⬅️ 返回結算與淨額中心' };
  }
  return { customId: 'exp_nav', label: '🔙 返回記帳管理' };
}

/**
 * 🆕 組出「金額 幣別」文字，只有在「該筆紀錄幣別 ≠ 行程基準幣」時，
 * 才附加「➔ 換算後金額 基準幣」——因為幣別本身就是基準幣的話，
 * 換算前後數字完全一樣，顯示出來只是廢話，徒增畫面長度。
 * 例：
 *   currency === baseCurrency → "2000 TWD"
 *   currency !== baseCurrency → "38172 JPY ➔ 7592.41 TWD"
 */
function formatAmountConversion(amount, currency, amountInBase, baseCurrency) {
  const amountText = `${round2(amount)} ${currency}`;
  if (currency === baseCurrency) return amountText;
  return `${amountText} ➔ ${round2(amountInBase)} ${baseCurrency}`;
}

/**
 * 📱 格式化分攤明細。
 * 🆕 改用 Discord 的「引言（>）」語法而非純文字+空格縮排——
 * 因為純文字縮排只對該行「第一個字」有效，一旦內容太長被 Discord
 * 自動換行，換行後的內容會直接貼齊最左邊，縮排必然消失（這是純文字
 * 排版在 Discord 上的物理限制，無法透過調整空格數量解決）。
 * 引言語法則是套用「整個區塊」的左側色條+縮排，即使自動換行，
 * 換行後的內容仍會維持在色條右側的縮排位置，徹底解決鋸齒狀排版問題。
 *
 *   - 完全平分 → 濃縮成「N人平分，每人 X」+ 姓名清單（同一引言區塊內換行）
 *   - 非平分   → 每人各自一行條列，同樣包在引言區塊內
 */
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

module.exports = {
  async handleButton(interaction, cache) {
    const { customId, guildId } = interaction;
    const { trip } = resolveTrip(guildId);
    
    if (customId === 'nav_main') return showMainMenu(interaction);

    if (customId === 'exp_nav') {
      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('💸 記帳管理分頁')
        .setDescription(`當前行程：**${trip.name}**\n請選擇您要執行的記帳操作：`);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('exp_btn_add_start').setLabel('➕ 新增花費').setStyle(ButtonStyle.Primary),
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

    // 📒 總帳目清單／刪除：完整列出行程所有花費 + 訂金紀錄，可翻頁瀏覽，並可直接刪除任一筆
    // 🆕 customId 格式改為「頁碼__來源」，例如 exp_btn_ledger_last__set，
    //    這樣不論從記帳管理分頁或結算與淨額中心進入，都能記住來源，返回時導向正確分頁。
    if (customId.startsWith('exp_btn_ledger_')) {
      const suffix = customId.substring('exp_btn_ledger_'.length);
      const { page, source } = parseLedgerSuffix(suffix);
      return renderLedgerPage(interaction, trip, page, null, source);
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

    // ✏️ 新增：非平分（自訂金額）分攤 —— 每人金額可各自指定，例如免費、部分負擔
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
    // 🟢 處理「收取訂金」流程 3/3：接收多人金額與備註並儲存
    if (interaction.customId === 'exp_modal_multi_deposit') {
      const { guildId, user } = interaction;
      const { trip } = resolveTrip(guildId);
      const state = cache.get(guildId, user.id);

      if (!state || !state.depositCurrency || !state.depositCollectorId || !state.depositPayerIds) {
        return interaction.reply({ content: '⚠️ 快取失效，請重新操作。', flags: MessageFlags.Ephemeral });
      }

      let note = '預收款/訂金';
      // 如果選擇人數小於 5，代表有備註欄位可以讀取
      if (state.depositPayerIds.length < 5) {
        try {
          const inputNote = interaction.fields.getTextInputValue('dep_note');
          if (inputNote) note = inputNote;
        } catch (e) {} // 忽略錯誤
      }

      const depositsAdded = [];
      let totalAmount = 0;

      try {
        for (let i = 0; i < state.depositPayerIds.length; i++) {
          const amountStr = interaction.fields.getTextInputValue(`dep_amount_${i}`);
          const amount = parseFloat(amountStr);
          
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
      const amount = parseFloat(interaction.fields.getTextInputValue('amount'));
      const customRateStr = interaction.fields.getTextInputValue('custom_rate');

      if (isNaN(amount) || amount <= 0) {
        return interaction.reply({ content: '⚠️ 請輸入正確的大於 0 的金額數字。', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferUpdate();

      let actualRate;
      let rateSource;

      if (customRateStr && !isNaN(parseFloat(customRateStr)) && parseFloat(customRateStr) > 0) {
        actualRate = parseFloat(customRateStr);
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
        const val = parseFloat(valStr);
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

    // ✏️ 新增：處理「自訂金額分攤」流程 —— 接收各成員應付金額，驗證加總後直接記帳
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
        const val = parseFloat(valStr);
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

    // 🟢 處理「收取訂金」流程 2/4：選擇幣別後，選擇收款人
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

    // 🟢 處理「收取訂金」流程 3/4：選擇付款人 (支援多選)
    if (customId === 'exp_select_deposit_collector') {
      const state = cache.get(guildId, user.id);
      if (!state || !state.depositCurrency) return interaction.reply({ content: '⚠️ 快取失效，請重新操作。', flags: MessageFlags.Ephemeral });
      state.depositCollectorId = values[0];
      
      const availableMembers = trip.members.filter(m => m.id !== values[0]);
      const maxSelect = Math.min(availableMembers.length, 5); // Discord Modal 最多 5 個輸入框

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

    // 🟢 處理「收取訂金」流程：動態彈出多人金額輸入 Modal
    if (customId === 'exp_select_deposit_payer') {
      const state = cache.get(guildId, user.id);
      if (!state || !state.depositCurrency || !state.depositCollectorId) {
        return interaction.reply({ content: '⚠️ 快取失效，請重新操作。', flags: MessageFlags.Ephemeral });
      }
      
      state.depositPayerIds = values; // 儲存多個付款人 ID

      const modal = new ModalBuilder()
        .setCustomId('exp_modal_multi_deposit')
        .setTitle(`💰 步驟 4/4：輸入訂金金額 (${state.depositCurrency})`);

      // 根據選擇的人數，動態產生輸入框
      values.forEach((id, idx) => {
        const memberName = trip.members.find(m => m.id === id).name;
        const amountInput = new TextInputBuilder()
          .setCustomId(`dep_amount_${idx}`)
          .setLabel(`${memberName} 付了多少 (${state.depositCurrency})？`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
      });

      // 如果選擇人數小於 5，代表還有空間放備註欄位
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

    // ✏️ 新增：處理「自訂金額分攤」流程 —— 選完成員後彈出動態 Modal 輸入各自金額
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

    // 📒 在總帳目清單分頁中選擇刪除一筆紀錄；customId 帶有「目前頁碼__來源」，刪除後回到同一頁、同一來源
    if (customId.startsWith('exp_select_delete_')) {
      const suffix = customId.substring('exp_select_delete_'.length);
      const { page, source } = parseLedgerSuffix(suffix);
      const [type, ...rest] = values[0].split('_');
      const realId = rest.join('_');

      if (type === 'expense') {
        const idx = trip.expenses.findIndex(e => e.id === realId);
        if (idx === -1) return interaction.reply({ content: '⚠️ 找不到此花費帳目，可能已被其他人刪除。', flags: MessageFlags.Ephemeral });
        const deleted = trip.expenses.splice(idx, 1)[0];
        storage.persist();
        return renderLedgerPage(interaction, trip, page, `🗑️ 已成功刪除花費：**${deleted.description}** (${deleted.amount} ${deleted.currency})`, source);
      } else if (type === 'deposit') {
        const idx = trip.deposits.findIndex(d => d.id === realId);
        if (idx === -1) return interaction.reply({ content: '⚠️ 找不到此訂金紀錄，可能已被其他人刪除。', flags: MessageFlags.Ephemeral });
        const deleted = trip.deposits.splice(idx, 1)[0];
        storage.persist();
        return renderLedgerPage(interaction, trip, page, `🗑️ 已成功刪除訂金紀錄：**${memberDisplay(trip, deleted.payerId)} 預付給 ${memberDisplay(trip, deleted.collectorId)}** (${deleted.amount} ${deleted.currency})`, source);
      }
    }
  }
};

const LEDGER_PAGE_SIZE = 8;

/**
 * 📒 總帳目清單：依時間先後（由舊到新）完整列出行程內所有花費 + 訂金紀錄，
 * 並附上依幣別 / 依類型的總計摘要，方便一次掌握全部帳目，支援翻頁瀏覽，
 * 也可直接用選單刪除本頁任一筆紀錄。
 *
 * 🆕 新增 source 參數（'exp' | 'set'），代表使用者是從哪個分頁點進來的：
 *   - 'exp'：記帳管理分頁
 *   - 'set'：結算與淨額中心
 * 翻頁按鈕、刪除選單、返回按鈕都會依此參數帶上相同的來源標記，
 * 確保整趟瀏覽過程中「返回」永遠導向正確的原始分頁。
 *
 * 🆕 每筆紀錄的金額顯示改用 formatAmountConversion：
 *   若該筆幣別本身就等於行程基準幣，就不再顯示「➔ 換算後金額」，
 *   因為換算前後數字完全相同，顯示等於重複資訊。
 *
 * 📱 每筆花費的分攤明細改用 formatParticipantsList：
 *   避免多人分攤時用「、」串成一整條長字串，在手機版超出畫面寬度後
 *   自動換行、縮排跑掉、擠成一坨難以閱讀；改為完全平分時濃縮成一行摘要，
 *   非平分時則逐一換行條列，確保排版在任何裝置寬度下都維持清晰。
 */
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

    // 🆕 排版調整：第一行只放「編號／類型／標題／金額」這些最重要的資訊，維持精簡好掃讀；
    // 次要的日期、代墊人挪到第二行；「誰分攤多少」則獨立成第三行，並改用
    // formatParticipantsList 產生——完全平分時濃縮成一行摘要 + 姓名清單，
    // 非平分時每人各自換行條列，避免手機版因單行過長自動換行而擠成一坨。
    if (r.type === 'expense') {
      const payers = r.payers.map(p => memberDisplay(trip, p.userId)).join('、');
      const participantsText = formatParticipantsList(trip, r.participants, r.currency);
      // 🆕 標題與金額分成兩行——項目名稱長、金額又要顯示雙幣別換算時，
      // 擠在同一行很容易超出手機寬度自動換行，導致「這是標題」的視覺定位被打斷。
      // 拆開後第一行永遠只放「編號/類型/標題」，第二行專門放金額，各自簡短好辨識。
      return `**#${globalIdx}** \`[花費]\` **${r.description}**\n${amountText}\n> 🕒 ${dateStr}・由 ${payers} 代墊\n> 💸 分攤：${participantsText}`;
    } else {
      const payer = memberDisplay(trip, r.payerId);
      const collector = memberDisplay(trip, r.collectorId);
      const noteText = r.note ? `\n> 📝 備註：${r.note}` : '';
      return `**#${globalIdx}** \`[訂金]\` **${payer} → ${collector}**\n${amountText}\n> 🕒 ${dateStr}${noteText}`;
    }


  }).join('\n\n');

  // 依幣別統計花費小計（僅計 expenses，訂金不列入花費總額）
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
    // 🆕 頁碼資訊與操作提示分成兩行，避免在手機較窄的 footer 區塊被擠成一長串難以閱讀
    .setFooter({ text: `第 ${safePage + 1} / ${totalPages} 頁・共 ${allRecords.length} 筆紀錄\n💡 可用下方選單直接刪除本頁任一筆` });

  // 🆕 翻頁按鈕與刪除選單的 customId 都帶上 __${source}，維持來源一致
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

/**
 * ✏️ 新增：以「自訂金額」完成記帳 —— 與 completeExpenseLogging 的差異在於
 * participants 的份額不是用 equalSplit 平均算出，而是直接採用使用者手動輸入、
 * 且已通過 validateCustomSplit 驗證加總無誤的 shares 陣列。
 * 例：ABC 共 3000，A 免費(0) * / B 付 1000 / C 付 2000。
 */
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
