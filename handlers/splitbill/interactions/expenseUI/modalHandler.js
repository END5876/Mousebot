'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags
} = require('discord.js');
const storage = require('../../utils/storage');
const { resolveTrip, resolveTripById } = require('../../utils/tripHelper');
const { validateCustomSplit, fetchRealTimeRate, round2, parseMoneyInput } = require('../../utils/calculator');
const { addDeposit } = require('../../utils/deposit');
const { showMainMenu } = require('../../commands/splitbill');
const { parseScanItemSuffix, scanItemCacheUserId, buildScanResultView } = require('./billScan');
const { renderSplitMethodUI, completeExpenseLoggingWithShares } = require('./expenseCompletion');

async function handleModal(interaction, cache) {
    if (interaction.customId.startsWith('exp_modal_scan_custom_currency')) {
      const { guildId, user } = interaction;
      // 🔒 [修正：切換行程影響全體] 改用發起者自己的作用行程
      const { trip } = resolveTrip(guildId, null, user.id);
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
      const state = cache.get(guildId, user.id);

      if (!state || !state.depositCurrency || !state.depositCollectorId || !state.depositPayerIds) {
        return interaction.reply({ content: '⚠️ 快取失效，請重新操作。', flags: MessageFlags.Ephemeral });
      }

      // 🔒 [修正：race condition] 用流程一開始（選幣別那一步）鎖定的 tripId，
      // 而不是重新查詢「現在」的作用行程，避免這幾步操作期間使用者切換了
      // 自己的作用行程，導致訂金被寫入錯誤的行程。找不到（例如行程已被刪除）
      // 就直接中止，不寫入任何資料。
      const trip = resolveTripById(guildId, state.tripId);
      if (!trip) {
        cache.delete(guildId, user.id);
        return interaction.reply({ content: '⚠️ 找不到原本的行程（可能已被刪除），操作已取消，請重新開始。', flags: MessageFlags.Ephemeral });
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

      // 🔒 [修正：race condition] customId 可能帶有「::<tripId>」鎖定後綴
      // （見 buttonHandler.js / selectMenuHandler.js 開啟這個 Modal 的地方），
      // 代表這是「選幣別當下」就鎖定好的行程，優先用它，而不是重新查一次
      // 現在的作用行程；沒有鎖定資訊時（理論上不會發生）才退回舊行為。
      const [rawId, pinnedTripId] = interaction.customId.split('::');
      const trip = pinnedTripId
        ? resolveTripById(guildId, pinnedTripId)
        : resolveTrip(guildId, null, user.id).trip;

      if (!trip) {
        return interaction.reply({ content: '⚠️ 找不到行程（可能已被刪除），請重新操作一次。', flags: MessageFlags.Ephemeral });
      }

      const currency = rawId.replace('exp_modal_add_', '');
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
        rateSource,
        // 🔒 把鎖定的 tripId 一併存進狀態，讓「選代墊人 → 選分攤方式 → 送出」
        // 這整條後續流程都繼續鎖定在同一個行程上。
        tripId: trip.id
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
      const state = cache.get(guildId, user.id);
      
      if (!state || !state.tempPayerIds) return interaction.reply({ content: '⚠️ 快取過期，請重新開啟。', flags: MessageFlags.Ephemeral });

      // 這一步只是彙整代墊金額、還不會寫入行程資料，故不需要在此解析 trip；
      // 實際寫入（completeExpenseLoggingWithShares／completeExpenseLogging）
      // 會統一使用 state.tripId 鎖定的行程。

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
      const state = cache.get(guildId, user.id);

      if (!state || !state.tempCustomParticipantIds) {
        return interaction.reply({ content: '⚠️ 快取過期，請重新開啟。', flags: MessageFlags.Ephemeral });
      }

      // 🔒 [修正：race condition] 沿用「新增花費」流程一開始鎖定的 tripId，
      // 而不是重新查一次現在的作用行程，最終寫入時就不會跑到別的行程去。
      const trip = resolveTripById(guildId, state.tripId);
      if (!trip) {
        cache.delete(guildId, user.id);
        return showMainMenu(interaction, '⚠️ **記帳已取消**：找不到原本的行程（可能已被刪除）。');
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
}

module.exports = { handleModal };
