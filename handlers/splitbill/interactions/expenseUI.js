'use strict';

const { 
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, 
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags 
} = require('discord.js');
const storage = require('../utils/storage');
const { resolveTrip, memberDisplay } = require('../utils/tripHelper');
const { equalSplit, fetchRealTimeRate } = require('../utils/calculator');
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
        new ButtonBuilder().setCustomId('exp_btn_deposit_start').setLabel('💰 收取訂金').setStyle(ButtonStyle.Success), // 🟢 新增預收款按鈕
        new ButtonBuilder().setCustomId('exp_btn_list').setLabel('🧾 歷史與刪除').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('nav_main').setLabel('🏠 返回主控台').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    // 處理「收取訂金」流程 1/3：選擇收款人
    if (customId === 'exp_btn_deposit_start') {
      if (!trip.members || trip.members.length < 2) {
        return interaction.reply({ content: '⚠️ 此行程成員不足兩人，無法使用訂金功能！', flags: MessageFlags.Ephemeral });
      }

      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('💰 步驟 1/3：選擇收款人')
        .setDescription('誰負責「代收」這筆訂金？\n*(例如：負責統一訂機票/住宿的人)*');

      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('exp_select_deposit_collector')
          .setPlaceholder('選擇收款人...')
          .addOptions(trip.members.slice(0, 25).map(m => ({ label: m.name, value: m.id })))
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

      // 合併 expenses 和 deposits 來顯示歷史紀錄
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

    if (customId === 'exp_btn_split_all') {
      const state = cache.get(interaction.user.id);
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
    // 🟢 處理「收取訂金」流程 3/3：接收金額與備註並儲存
    if (interaction.customId === 'exp_modal_deposit') {
      const { guildId, user } = interaction;
      const { trip } = resolveTrip(guildId);
      const state = cache.get(user.id);

      if (!state || !state.depositCollectorId || !state.depositPayerId) {
        return interaction.reply({ content: '⚠️ 快取失效，請重新操作。', flags: MessageFlags.Ephemeral });
      }

      const amount = parseFloat(interaction.fields.getTextInputValue('amount'));
      const note = interaction.fields.getTextInputValue('note');

      if (isNaN(amount) || amount <= 0) {
        return interaction.reply({ content: '⚠️ 請輸入正確的大於 0 的金額數字。', flags: MessageFlags.Ephemeral });
      }

      try {
        const deposit = addDeposit(trip, {
          collectorId: state.depositCollectorId,
          payerId: state.depositPayerId,
          amount,
          currency: trip.baseCurrency, // 訂金預設使用基準幣別
          note
        });
        
        storage.persist();
        cache.delete(user.id);

        const msg = `✅ **預收款紀錄成功！** <@${deposit.payerId}> 預付了 ${deposit.amount} ${deposit.currency} 給 <@${deposit.collectorId}> ${note ? `(${note})` : ''}`;
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

      cache.set(user.id, {
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
      const state = cache.get(user.id);
      
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

      // 💡 新需求：若多人代墊金額總和錯誤，清空快取並直接跳回主選單
      if (Math.abs(sum - state.amount) > 0.01) {
        cache.delete(user.id);
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

    // 🟢 處理「收取訂金」流程 2/3：選擇付款人
    if (customId === 'exp_select_deposit_collector') {
      cache.set(user.id, { depositCollectorId: values[0] });
      
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('💰 步驟 2/3：選擇付款人')
        .setDescription('誰「付錢」給了收款人？');

      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('exp_select_deposit_payer')
          .setPlaceholder('選擇付款人...')
          .addOptions(trip.members.filter(m => m.id !== values[0]).slice(0, 25).map(m => ({ label: m.name, value: m.id })))
      );

      return interaction.update({ embeds: [embed], components: [selectRow] });
    }

    // 🟢 處理「收取訂金」流程：彈出金額輸入 Modal
    if (customId === 'exp_select_deposit_payer') {
      const state = cache.get(user.id);
      if (!state) return interaction.reply({ content: '⚠️ 快取失效。', flags: MessageFlags.Ephemeral });
      
      state.depositPayerId = values[0];

      const modal = new ModalBuilder()
        .setCustomId('exp_modal_deposit')
        .setTitle('💰 步驟 3/3：輸入訂金金額');

      const amountInput = new TextInputBuilder()
        .setCustomId('amount')
        .setLabel(`金額 (單位: ${trip.baseCurrency})`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
        
      const noteInput = new TextInputBuilder()
        .setCustomId('note')
        .setLabel('備註 (選填，例如：機票+住宿訂金)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(amountInput), 
        new ActionRowBuilder().addComponents(noteInput)
      );
      
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
      const state = cache.get(user.id);
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
      const state = cache.get(user.id);
      if (!state) return interaction.reply({ content: '⚠️ 快取已失效。', flags: MessageFlags.Ephemeral });

      const participantIds = values.filter(id => trip.members.some(m => m.id === id));
      if (!participantIds.length) return interaction.reply({ content: '⚠️ 所選成員皆不在行程中。', flags: MessageFlags.Ephemeral });

      return completeExpenseLogging(interaction, trip, state, participantIds, cache);
    }

    if (customId === 'exp_select_delete') {
      const [type, id] = values[0].split('_', 2);
      const realId = values[0].substring(type.length + 1); // 取得真正的 ID

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
    // 取得無條件進位後的分攤結果
    const shares = equalSplit(state.amount, participantIds);
    
    // 💡 新需求：計算進位後的總和，並將多出的零頭補給第一位代墊者
    const newTotal = shares.reduce((sum, s) => sum + s.share, 0);
    const extra = newTotal - state.amount;
    
    if (extra > 0) {
      state.payers[0].amount += extra; // 將多收的錢算給第一位代墊者
      state.amount = newTotal;         // 更新總花費以維持帳目平衡
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
    cache.delete(interaction.user.id);

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
