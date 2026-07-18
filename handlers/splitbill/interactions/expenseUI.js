'use strict';

const { 
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, 
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags 
} = require('discord.js');
const storage = require('../utils/storage');
const { resolveTrip, memberDisplay } = require('../utils/tripHelper');
const { equalSplit, fetchRealTimeRate, round2 } = require('../utils/calculator');
const { addDeposit } = require('../utils/deposit');
const { showMainMenu } = require('../commands/splitbill');

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
        new ButtonBuilder().setCustomId('exp_btn_list').setLabel('🧾 歷史與刪除').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('exp_btn_ledger_0').setLabel('📒 總帳目清單').setStyle(ButtonStyle.Secondary),
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

    if (customId === 'exp_btn_list') {
      if (!trip.expenses.length && (!trip.deposits || !trip.deposits.length)) {
        return interaction.reply({ content: '📭 目前尚無任何記帳或訂金紀錄。', flags: MessageFlags.Ephemeral });
      }

      const allRecords = [
        ...trip.expenses.map(e => ({ ...e, type: 'expense' })),
        ...(trip.deposits || []).map(d => ({ ...d, type: 'deposit' }))
      ].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);

      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(`🧾 「${trip.name}」最近 10 筆帳目紀錄`)
        .setDescription(
          allRecords.map(r => {
            if (r.type === 'expense') {
              const payers = r.payers.map(p => memberDisplay(trip, p.userId)).join('、');
              return `\`[花費]\` **${r.description}** — ${r.amount} ${r.currency} (${payers} 代墊)`;
            } else {
              const payer = memberDisplay(trip, r.payerId);
              const collector = memberDisplay(trip, r.collectorId);
              return `\`[訂金]\` **${payer} 預付給 ${collector}** — ${r.amount} ${r.currency} ${r.note ? `(${r.note})` : ''}`;
            }
          }).join('\n')
        );

      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('exp_select_delete')
          .setPlaceholder('選擇一筆帳目將其刪除...')
          .addOptions(allRecords.map(r => ({
            label: r.type === 'expense' ? `[花費] ${r.description} (${r.amount} ${r.currency})` : `[訂金] ${memberDisplay(trip, r.payerId, true)} 給 ${memberDisplay(trip, r.collectorId, true)} (${r.amount})`,
            value: `${r.type}_${r.id}`
          })))
      );

      const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('exp_nav').setLabel('⬅️ 返回記帳管理').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [selectRow, navRow] });
    }

    // 📒 總帳目清單：完整列出行程所有花費 + 訂金紀錄（可翻頁瀏覽，唯讀不含刪除）
    if (customId.startsWith('exp_btn_ledger_')) {
      const page = parseInt(customId.substring('exp_btn_ledger_'.length), 10) || 0;
      return renderLedgerPage(interaction, trip, page);
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

    if (customId === 'exp_select_delete') {
      const [type, id] = values[0].split('_', 2);
      const realId = values[0].substring(type.length + 1);

      if (type === 'expense') {
        const idx = trip.expenses.findIndex(e => e.id === realId);
        if (idx === -1) return interaction.reply({ content: '⚠️ 找不到此花費帳目。', flags: MessageFlags.Ephemeral });
        const deleted = trip.expenses.splice(idx, 1)[0];
        storage.persist();
        return showMainMenu(interaction, `🗑️ 已成功刪除花費：**${deleted.description}** (${deleted.amount} ${deleted.currency})`);
      } else if (type === 'deposit') {
        const idx = trip.deposits.findIndex(d => d.id === realId);
        if (idx === -1) return interaction.reply({ content: '⚠️ 找不到此訂金紀錄。', flags: MessageFlags.Ephemeral });
        const deleted = trip.deposits.splice(idx, 1)[0];
        storage.persist();
        return showMainMenu(interaction, `🗑️ 已成功刪除訂金紀錄：**${memberDisplay(trip, deleted.payerId, true)} 預付給 ${memberDisplay(trip, deleted.collectorId, true)}** (${deleted.amount} ${deleted.currency})`);
      }
    }
  }
};

const LEDGER_PAGE_SIZE = 8;

/**
 * 📒 總帳目清單：依時間先後（由舊到新）完整列出行程內所有花費 + 訂金紀錄，
 * 並附上依幣別 / 依類型的總計摘要，方便一次掌握全部帳目，支援翻頁瀏覽。
 * 純唯讀畫面（不提供刪除，刪除請至「🧾 歷史與刪除」)。
 */
function renderLedgerPage(interaction, trip, page) {
  const allRecords = [
    ...trip.expenses.map(e => ({ ...e, type: 'expense' })),
    ...(trip.deposits || []).map(d => ({ ...d, type: 'deposit' }))
  ].sort((a, b) => a.createdAt - b.createdAt);

  if (!allRecords.length) {
    const embed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle(`📒 「${trip.name}」總帳目清單`)
      .setDescription('📭 目前尚無任何花費或訂金紀錄。');

    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('exp_nav').setLabel('⬅️ 返回記帳管理').setStyle(ButtonStyle.Secondary)
    );
    return interaction.update({ embeds: [embed], components: [navRow] });
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

    if (r.type === 'expense') {
      const payers = r.payers.map(p => memberDisplay(trip, p.userId)).join('、');
      return `**#${globalIdx}** \`${dateStr}\` \`[花費]\` **${r.description}** — ${r.amount} ${r.currency} ➔ ${round2(r.amountInBase)} ${trip.baseCurrency}\n　　由 ${payers} 代墊，${r.participants.length} 人分攤`;
    } else {
      const payer = memberDisplay(trip, r.payerId);
      const collector = memberDisplay(trip, r.collectorId);
      return `**#${globalIdx}** \`${dateStr}\` \`[訂金]\` **${payer} → ${collector}** — ${r.amount} ${r.currency} ➔ ${round2(r.amountInBase)} ${trip.baseCurrency}${r.note ? `\n　　備註：${r.note}` : ''}`;
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
          `🧾 花費筆數：\`${trip.expenses.length} 筆\`　💰 訂金筆數：\`${(trip.deposits || []).length} 筆\`\n` +
          `💵 花費總額：**${round2(totalExpenseBase)} ${trip.baseCurrency}**${breakdownText ? `（${breakdownText}）` : ''}\n` +
          `🏦 訂金總額：**${round2(totalDepositBase)} ${trip.baseCurrency}**`
      }
    )
    .setFooter({ text: `第 ${safePage + 1} / ${totalPages} 頁　共 ${allRecords.length} 筆紀錄` });

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`exp_btn_ledger_${safePage - 1}`).setLabel('⬅️ 上一頁').setStyle(ButtonStyle.Primary).setDisabled(safePage <= 0),
    new ButtonBuilder().setCustomId(`exp_btn_ledger_${safePage + 1}`).setLabel('➡️ 下一頁').setStyle(ButtonStyle.Primary).setDisabled(safePage >= totalPages - 1),
    new ButtonBuilder().setCustomId('exp_nav').setLabel('🔙 返回記帳管理').setStyle(ButtonStyle.Secondary)
  );

  return interaction.update({ embeds: [embed], components: [navRow] });
}

function renderSplitMethodUI(interaction, state) {
  const payerMentions = state.payers.map(p => `<@${p.userId}>(${p.amount})`).join(', ');
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('⚖️ 步驟 3/3：選擇分攤方式')
    .setDescription(`代墊者：${payerMentions}\n\n請點選下方按鈕直接完成分攤：`);

  const btnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('exp_btn_split_all').setLabel('👥 全體平分').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('exp_btn_split_custom').setLabel('🎯 部分成員平分').setStyle(ButtonStyle.Primary)
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
    const msg = `✅ **記帳成功！** 項目：${newExpense.description} | 金額：${newExpense.amount} ${newExpense.currency} ➔ ${amountInBase} ${trip.baseCurrency} | 代墊：${payerText}`;
    
    return showMainMenu(interaction, msg);

  } catch (err) {
    const errMsg = `❌ 核心記帳計算失敗：${err.message}`;
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: errMsg });
    }
    return interaction.reply({ content: errMsg, flags: MessageFlags.Ephemeral });
  }
}