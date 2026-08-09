'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder, MessageFlags
} = require('discord.js');
const { equalSplit, round2, parseMoneyInput, validateCustomSplit, validatePayers } = require('../utils/calculator');
const { simplifyDebts } = require('../utils/settlement');

// ────────────────────────────────────────────────────────────────
// ⚡ 快速分帳：給「臨時只有一筆帳單要分」的情境使用，不需要事先建立行程、
// 不需要管理成員名單，也完全不會寫入任何行程的持久化資料 —— 算完即丟。
//
// 設計成「多步驟精靈」，並且盡量沿用主流程（記帳）已經在用的 UX 慣例
// （見 expenseUI.js 的 exp_select_payer / exp_select_custom_participants）：
// 該打字的地方（項目名稱、金額）用 Modal；該選人的地方一律用 Discord
// 原生的 UserSelectMenu（真正的成員選單，有頭像、有名字，不用手動打 ID）。
//
// 流程：
//   1️⃣ 「⚡ 快速分帳」按鈕 → Modal：項目名稱 / 總金額 / 幣別
//   2️⃣ 代墊人 UserSelectMenu（預設已幫你選好自己；也提供「就是我自己」快捷按鈕）
//   3️⃣ 若代墊人選了 2 人以上 → 才彈出 Modal，針對每個人各填一個金額框
//   4️⃣ 分攤對象 UserSelectMenu
//   5️⃣ 「⚖️ 平均分攤」或「✏️ 自訂金額」按鈕（自訂才會再彈 Modal 填每人金額）
//
// 因為 Discord Modal 最多只能放 5 個欄位，「一人一格填金額」的步驟
// (3️⃣、5️⃣ 的自訂金額) 最多只能容納 5 人，所以代墊人選單上限 5 人；
// 分攤對象選單則放寬到 25 人（平均分攤不受此限，只有「自訂金額」需要 ≤5 人）。
// ────────────────────────────────────────────────────────────────

const CUSTOM_SPLIT_MODAL_LIMIT = 5;

/** 從 UserSelectMenu/其後續 Modal 拿到最友善的顯示名稱（暱稱 > 全域名稱 > 帳號名稱）。 */
function displayNameOf(interaction, userId, fallbackMap) {
  const member = interaction.members && interaction.members.get(userId);
  if (member && member.displayName) return member.displayName;
  const user = interaction.users && interaction.users.get(userId);
  if (user) return user.globalName || user.username;
  if (fallbackMap && fallbackMap[userId]) return fallbackMap[userId];
  return userId;
}

function buildResultPayload(state) {
  const { item, amount, currency, payers, shares } = state;

  const net = {};
  for (const p of payers) net[p.userId] = round2((net[p.userId] || 0) + p.amount);
  for (const s of shares) net[s.userId] = round2((net[s.userId] || 0) - s.share);
  const transfers = simplifyDebts(net);

  const payerLines = payers.map(p => `　• <@${p.userId}>：代墊 ${round2(p.amount)} ${currency}`).join('\n');
  const shareLines = shares.map(s => `　• <@${s.userId}>：應分攤 ${round2(s.share)} ${currency}`).join('\n');
  const transferText = transfers.length
    ? transfers.map(t => `　➜ <@${t.from}> 轉給 <@${t.to}>：**${t.amount} ${currency}**`).join('\n')
    : '🎉 剛好互相抵銷，無需任何轉帳！';

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('⚡ 快速分帳結果')
    .setDescription(`**${item}** — 總金額 ${amount} ${currency}`)
    .addFields(
      { name: '💰 代墊', value: payerLines },
      { name: '🎯 分攤', value: shareLines },
      { name: '💸 建議轉帳', value: transferText }
    )
    .setFooter({ text: '此為臨時計算結果，不會被儲存，也不會建立任何行程。' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('qs_start').setLabel('⚡ 再算一筆').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('nav_main').setLabel('🏠 返回主控台').setStyle(ButtonStyle.Secondary)
  );

  return { content: '', embeds: [embed], components: [row] };
}

/** 2️⃣ 代墊人選單畫面（含「就是我自己」快捷按鈕） */
function buildPayerStepPayload(state) {
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('⚡ 快速分帳 · 誰先代墊了這筆錢？')
    .setDescription(
      `**${state.item}** — ${state.amount} ${state.currency}\n\n` +
      '請用下方選單選擇代墊人（已預設是你自己；若是多人合資代墊，直接複選即可，最多 5 人）。'
    );

  const selectRow = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('qs_select_payers')
      .setPlaceholder('選擇代墊人...')
      .setMinValues(1)
      .setMaxValues(CUSTOM_SPLIT_MODAL_LIMIT)
      .setDefaultUsers([state.initiatorId])
  );

  const btnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('qs_payer_self_only').setLabel('✅ 就是我自己付的').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('nav_main').setLabel('❌ 取消').setStyle(ButtonStyle.Secondary)
  );

  return { content: '', embeds: [embed], components: [selectRow, btnRow] };
}

/** 4️⃣ 分攤對象選單畫面 */
function buildParticipantStepPayload(state) {
  const payerNames = state.payers.map(p => `<@${p.userId}>`).join('、');
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('⚡ 快速分帳 · 誰要一起分攤？')
    .setDescription(
      `**${state.item}** — ${state.amount} ${state.currency}\n代墊人：${payerNames}\n\n` +
      '請用下方選單選擇「一起分攤這筆帳單的所有人」（含代墊人自己在內，若他也要分攤請一併選入）：'
    );

  const selectRow = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('qs_select_participants')
      .setPlaceholder('選擇分攤對象...')
      .setMinValues(1)
      .setMaxValues(25)
  );

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('nav_main').setLabel('❌ 取消').setStyle(ButtonStyle.Secondary)
  );

  return { content: '', embeds: [embed], components: [selectRow, navRow] };
}

/** 5️⃣ 平均分攤／自訂金額 按鈕畫面 */
function buildSplitModePayload(state) {
  const participantNames = state.participants.map(p => `<@${p.id}>`).join('、');
  const canCustom = state.participants.length <= CUSTOM_SPLIT_MODAL_LIMIT;

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('⚡ 快速分帳 · 怎麼分？')
    .setDescription(
      `**${state.item}** — ${state.amount} ${state.currency}\n分攤對象：${participantNames}\n\n` +
      '請選擇分攤方式：' +
      (canCustom ? '' : `\n*(⚠️ 分攤對象超過 ${CUSTOM_SPLIT_MODAL_LIMIT} 人，Discord 表單一次最多只能填 ${CUSTOM_SPLIT_MODAL_LIMIT} 人的金額，此時僅能使用「平均分攤」)*`)
    );

  const btnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('qs_split_equal').setLabel('⚖️ 平均分攤').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('qs_split_custom').setLabel('✏️ 自訂金額').setStyle(ButtonStyle.Secondary).setDisabled(!canCustom),
    new ButtonBuilder().setCustomId('nav_main').setLabel('❌ 取消').setStyle(ButtonStyle.Secondary)
  );

  return { content: '', embeds: [embed], components: [btnRow] };
}

// ────────────────────────────────────────────────────────────────
// 🔧 Bug fix：原本用 `interaction.isFromMessage && interaction.isFromMessage()`
// 來判斷要 update() 還是 reply()，但 isFromMessage() 其實只存在於
// ModalSubmitInteraction，ButtonInteraction／SelectMenuInteraction 上
// 根本沒有這個方法。導致按鈕、選單互動一律誤判走進 reply()，
// 在頻道中留下多餘的新訊息，而不是就地更新原本的面板。
//
// 修正後邏輯：
//   - 若本身就是「訊息元件互動」（按鈕／任何 SelectMenu），直接 update()。
//   - 若是 Modal 送出：只有「由訊息元件觸發、要接續編輯原面板」的情況
//     （isFromMessage() 為 true）才 update()，其餘（例如 /slash 指令
//     直接觸發的 Modal）才 reply()。
// ────────────────────────────────────────────────────────────────
async function respond(interaction, payload) {
  if (interaction.isMessageComponent && interaction.isMessageComponent()) {
    return interaction.update(payload);
  }
  if (interaction.isModalSubmit && interaction.isModalSubmit() && interaction.isFromMessage()) {
    return interaction.update(payload);
  }
  return interaction.reply(payload);
}

module.exports = {
  async handleButton(interaction, cache) {
    const { customId, guildId, user } = interaction;

    // 1️⃣ 主控面板點「⚡ 快速分帳」→ 彈出項目/金額/幣別 Modal
    if (customId === 'qs_start') {
      const modal = new ModalBuilder().setCustomId('qs_modal_bill').setTitle('⚡ 快速分帳（免建立行程）');

      const itemInput = new TextInputBuilder()
        .setCustomId('item').setLabel('項目名稱').setStyle(TextInputStyle.Short)
        .setPlaceholder('例如：計程車、晚餐').setRequired(true);

      const amountInput = new TextInputBuilder()
        .setCustomId('amount').setLabel('總金額').setStyle(TextInputStyle.Short)
        .setPlaceholder('例如：1200').setRequired(true);

      const currencyInput = new TextInputBuilder()
        .setCustomId('currency').setLabel('幣別代碼（可留空，預設 TWD）').setStyle(TextInputStyle.Short)
        .setPlaceholder('例如：JPY、USD').setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(itemInput),
        new ActionRowBuilder().addComponents(amountInput),
        new ActionRowBuilder().addComponents(currencyInput)
      );

      return interaction.showModal(modal);
    }

    // 2️⃣ 「就是我自己付的」快捷按鈕：跳過選單，直接代墊人＝發起者、金額＝全額
    if (customId === 'qs_payer_self_only') {
      const state = cache.get(guildId, user.id);
      if (!state || state.flow !== 'qs') {
        return interaction.reply({ content: '⚠️ 這筆快速分帳的資料已逾時失效，請重新從主控台點擊「⚡ 快速分帳」再試一次。', flags: MessageFlags.Ephemeral });
      }

      state.payers = [{ userId: user.id, amount: state.amount }];
      cache.set(guildId, user.id, state);

      return respond(interaction, buildParticipantStepPayload(state));
    }

    // 5️⃣ 平均分攤
    if (customId === 'qs_split_equal') {
      const state = cache.get(guildId, user.id);
      if (!state || state.flow !== 'qs' || !state.participants) {
        return interaction.reply({ content: '⚠️ 這筆快速分帳的資料已逾時失效，請重新從主控台點擊「⚡ 快速分帳」再試一次。', flags: MessageFlags.Ephemeral });
      }

      state.shares = equalSplit(state.amount, state.participants.map(p => p.id));
      const payload = buildResultPayload(state);
      cache.delete(guildId, user.id);
      return respond(interaction, payload);
    }

    // 5️⃣ 自訂金額（非對稱分攤）→ 彈出每人一格的金額 Modal
    if (customId === 'qs_split_custom') {
      const state = cache.get(guildId, user.id);
      if (!state || state.flow !== 'qs' || !state.participants) {
        return interaction.reply({ content: '⚠️ 這筆快速分帳的資料已逾時失效，請重新從主控台點擊「⚡ 快速分帳」再試一次。', flags: MessageFlags.Ephemeral });
      }
      if (state.participants.length > CUSTOM_SPLIT_MODAL_LIMIT) {
        return interaction.reply({ content: `⚠️ 分攤對象超過 ${CUSTOM_SPLIT_MODAL_LIMIT} 人時無法使用自訂金額，請改用平均分攤。`, flags: MessageFlags.Ephemeral });
      }

      const modal = new ModalBuilder()
        .setCustomId('qs_modal_custom_shares')
        .setTitle(`✏️ 各自應付多少 (總計: ${state.amount})`);

      state.participants.forEach((p, idx) => {
        const input = new TextInputBuilder()
          .setCustomId(`share_${idx}`)
          .setLabel(`${p.name} 應付多少（免費請填 0）？`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('例如：0、300、700')
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
      });

      return interaction.showModal(modal);
    }
  },

  async handleModal(interaction, cache) {
    const { customId, guildId, user } = interaction;

    // 1️⃣ 項目/金額/幣別 Modal 送出 → 進入 2️⃣ 代墊人選單
    if (customId === 'qs_modal_bill') {
      const item = interaction.fields.getTextInputValue('item').trim();
      const amount = round2(parseMoneyInput(interaction.fields.getTextInputValue('amount')));
      const currency = (interaction.fields.getTextInputValue('currency') || 'TWD').trim().toUpperCase() || 'TWD';

      if (!(amount > 0)) {
        return interaction.reply({ content: '⚠️ 金額必須是大於 0 的數字。', flags: MessageFlags.Ephemeral });
      }

      const state = { flow: 'qs', item, amount, currency, initiatorId: user.id };
      cache.set(guildId, user.id, state);

      return respond(interaction, buildPayerStepPayload(state));
    }

    // 3️⃣ 多人代墊金額 Modal 送出 → 進入 4️⃣ 分攤對象選單
    if (customId === 'qs_modal_payer_amounts') {
      const state = cache.get(guildId, user.id);
      if (!state || state.flow !== 'qs' || !state.tempPayers) {
        return interaction.reply({ content: '⚠️ 這筆快速分帳的資料已逾時失效，請重新從主控台點擊「⚡ 快速分帳」再試一次。', flags: MessageFlags.Ephemeral });
      }

      const payers = [];
      for (let i = 0; i < state.tempPayers.length; i++) {
        const raw = interaction.fields.getTextInputValue(`amt_${i}`);
        const val = parseMoneyInput(raw);
        if (isNaN(val) || val < 0) {
          return interaction.reply({ content: '⚠️ 請輸入正確的數字（不可為負數）。', flags: MessageFlags.Ephemeral });
        }
        payers.push({ userId: state.tempPayers[i].id, amount: round2(val) });
      }

      try {
        validatePayers(state.amount, payers);
      } catch (err) {
        cache.delete(guildId, user.id);
        return interaction.reply({ content: `❌ 快速分帳已取消：${err.message}`, flags: MessageFlags.Ephemeral });
      }

      state.payers = payers;
      delete state.tempPayers;
      cache.set(guildId, user.id, state);

      return respond(interaction, buildParticipantStepPayload(state));
    }

    // 5️⃣ 自訂金額 Modal 送出 → 直接算出結果
    if (customId === 'qs_modal_custom_shares') {
      const state = cache.get(guildId, user.id);
      if (!state || state.flow !== 'qs' || !state.participants) {
        return interaction.reply({ content: '⚠️ 這筆快速分帳的資料已逾時失效，請重新從主控台點擊「⚡ 快速分帳」再試一次。', flags: MessageFlags.Ephemeral });
      }

      const shares = [];
      for (let i = 0; i < state.participants.length; i++) {
        const raw = interaction.fields.getTextInputValue(`share_${i}`);
        const val = parseMoneyInput(raw);
        if (isNaN(val) || val < 0) {
          return interaction.reply({ content: '⚠️ 請輸入正確的數字（不可為負數，免費請填 0）。', flags: MessageFlags.Ephemeral });
        }
        shares.push({ userId: state.participants[i].id, share: round2(val) });
      }

      try {
        validateCustomSplit(state.amount, shares);
      } catch (err) {
        cache.delete(guildId, user.id);
        return interaction.reply({ content: `❌ 快速分帳已取消：${err.message}`, flags: MessageFlags.Ephemeral });
      }

      state.shares = shares;
      const payload = buildResultPayload(state);
      cache.delete(guildId, user.id);
      return respond(interaction, payload);
    }
  },

  async handleSelectMenu(interaction, cache) {
    const { customId, guildId, user, values } = interaction;

    // 2️⃣ 代墊人選單送出
    if (customId === 'qs_select_payers') {
      const state = cache.get(guildId, user.id);
      if (!state || state.flow !== 'qs') {
        return interaction.reply({ content: '⚠️ 這筆快速分帳的資料已逾時失效，請重新從主控台點擊「⚡ 快速分帳」再試一次。', flags: MessageFlags.Ephemeral });
      }

      const payerIds = values;

      // 只選 1 人代墊 → 金額顯然就是全額，不需要再彈 Modal 問
      if (payerIds.length === 1) {
        state.payers = [{ userId: payerIds[0], amount: state.amount }];
        cache.set(guildId, user.id, state);
        return respond(interaction, buildParticipantStepPayload(state));
      }

      // 2 人以上代墊 → 彈出「每人一格」的金額 Modal（欄位標籤用真實顯示名稱，不是 ID）
      state.tempPayers = payerIds.map(id => ({ id, name: displayNameOf(interaction, id) }));
      cache.set(guildId, user.id, state);

      const modal = new ModalBuilder().setCustomId('qs_modal_payer_amounts').setTitle(`多人代墊金額 (總計: ${state.amount})`);
      state.tempPayers.forEach((p, idx) => {
        const input = new TextInputBuilder()
          .setCustomId(`amt_${idx}`)
          .setLabel(`${p.name} 付了多少？`)
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('例如：300')
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
      });

      return interaction.showModal(modal);
    }

    // 4️⃣ 分攤對象選單送出 → 進入 5️⃣ 平均分攤／自訂金額
    if (customId === 'qs_select_participants') {
      const state = cache.get(guildId, user.id);
      if (!state || state.flow !== 'qs' || !state.payers) {
        return interaction.reply({ content: '⚠️ 這筆快速分帳的資料已逾時失效，請重新從主控台點擊「⚡ 快速分帳」再試一次。', flags: MessageFlags.Ephemeral });
      }

      state.participants = values.map(id => ({ id, name: displayNameOf(interaction, id) }));
      cache.set(guildId, user.id, state);

      return respond(interaction, buildSplitModePayload(state));
    }
  }
};