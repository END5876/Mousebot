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
