'use strict';

const { 
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, 
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags 
} = require('discord.js');
const storage = require('../utils/storage');
const { resolveTrip } = require('../utils/tripHelper');
const { fetchRealTimeRate } = require('../utils/calculator');
const { showMainMenu } = require('../commands/splitbill');

const BASELINE_RATES = {
  TWD: 1, JPY: 0.2, USD: 32, KRW: 0.024, EUR: 34.8, THB: 0.89, HKD: 4.1, GBP: 40.5
};

/**
 * 渲染或更新「行程與外幣設定」畫面。抽成共用函式，讓按鈕與 Modal 提交後
 * 都能重複呼叫、附帶操作結果提示，不必各自重寫一份畫面組裝邏輯。
 */
async function renderTripNav(interaction, alertMsg = null) {
  const guildId = interaction.guildId;
  const guild = storage.getGuild(guildId);
  const { trip } = resolveTrip(guildId);
  const activeName = trip ? `**${trip.name}**` : '無';
  const trips = Object.values(guild.trips).filter(t => !t.archived);

  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('🧳 行程與外幣設定')
    .setDescription(`目前作用行程：${activeName}\n\n請直接由下方選單切換行程，或使用按鈕建立/刪除行程、新增幣別匯率。`);

  if (trip) {
    const rateLines = Object.entries(trip.rates)
      .map(([cur, rate]) => cur === trip.baseCurrency
        ? `\`${cur}\`（本位幣）`
        : `\`${cur}\`：1 ${cur} = ${rate} ${trip.baseCurrency}`)
      .join('\n');
    embed.addFields({ name: '🪙 目前可用幣別 / 匯率', value: rateLines || '（尚無資料）' });
  }

  const btnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('trip_btn_create_modal').setLabel('🆕 建立新行程').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('trip_btn_add_currency').setLabel('🪙 新增幣別').setStyle(ButtonStyle.Success).setDisabled(!trip),
    new ButtonBuilder().setCustomId('trip_btn_delete_ui').setLabel('❌ 刪除此行程').setStyle(ButtonStyle.Danger).setDisabled(!trip),
    new ButtonBuilder().setCustomId('nav_main').setLabel('🏠 返回主控台').setStyle(ButtonStyle.Secondary)
  );

  const components = [btnRow];

  if (trips.length > 0) {
    const selectRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('trip_select_switch')
        .setPlaceholder('🔄 快速切換其他行程...')
        .addOptions(trips.map(t => ({ label: t.name, value: t.id, description: `基準幣別: ${t.baseCurrency}` })))
    );
    components.push(selectRow);
  }

  const payload = { embeds: [embed], components, content: typeof alertMsg === 'string' ? alertMsg : '' };

  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(payload);
  } else if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
    return interaction.update(payload);
  } else {
    return interaction.reply(payload);
  }
}

module.exports = {
  async handleButton(interaction) {
    const { customId, guildId } = interaction;
    const guild = storage.getGuild(guildId);
    
    if (customId === 'nav_main') return showMainMenu(interaction);

    if (customId === 'trip_nav') {
      return renderTripNav(interaction);
    }

    if (customId === 'trip_btn_create_modal') {
      const modal = new ModalBuilder().setCustomId('trip_modal_create').setTitle('建立全新行程');
      const nameInput = new TextInputBuilder().setCustomId('name').setLabel('行程名稱').setStyle(TextInputStyle.Short).setRequired(true);
      const curInput = new TextInputBuilder().setCustomId('baseCur').setLabel('基準本位幣別 (預設 TWD)').setStyle(TextInputStyle.Short).setValue('TWD').setRequired(false);

      modal.addComponents(new ActionRowBuilder().addComponents(nameInput), new ActionRowBuilder().addComponents(curInput));
      return interaction.showModal(modal);
    }

    // 🪙 新增幣別：讓行程支援 BASELINE_RATES 預設清單以外的幣別（例如 VND、SGD）
    if (customId === 'trip_btn_add_currency') {
      const { trip } = resolveTrip(guildId);
      if (!trip) return interaction.reply({ content: '⚠️ 請先建立或選擇一個行程。', flags: MessageFlags.Ephemeral });

      const modal = new ModalBuilder().setCustomId('trip_modal_add_currency').setTitle('🪙 新增幣別匯率');
      const curInput = new TextInputBuilder()
        .setCustomId('currency')
        .setLabel('幣別代碼 (例如：VND、SGD、CNY)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(6);
      const rateInput = new TextInputBuilder()
        .setCustomId('rate')
        .setLabel(`匯率：1 該幣別 = ? ${trip.baseCurrency}`)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('💡 留空將自動抓取當下即時網路匯率')
        .setRequired(false);

      modal.addComponents(new ActionRowBuilder().addComponents(curInput), new ActionRowBuilder().addComponents(rateInput));
      return interaction.showModal(modal);
    }

    if (customId === 'trip_btn_delete_ui') {
      const { trip } = resolveTrip(guildId);
      const embed = new EmbedBuilder()
        .setColor(0xd35400)
        .setTitle(`⚠️ 警告：確定要刪除行程「${trip.name}」？`)
        .setDescription('此操作將會清除所有歷史記帳與成員關聯，**無法復原**。確認刪除？');

      const btns = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('trip_btn_delete_confirm').setLabel('💥 確定全面刪除').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('trip_nav').setLabel('🛡️ 取消安全返回').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [btns] });
    }

    if (customId === 'trip_btn_delete_confirm') {
      const { trip } = resolveTrip(guildId);
      if (guild.activeTripId === trip.id) guild.activeTripId = null;
      delete guild.trips[trip.id];
      storage.persist();

      return showMainMenu(interaction, `✅ 已徹底銷毀行程 \`${trip.name}\` 及其所有檔案。`);
    }
  },

  async handleModal(interaction) {
    if (interaction.customId === 'trip_modal_create') {
      const guildId = interaction.guildId;
      const guild = storage.getGuild(guildId);

      const name = interaction.fields.getTextInputValue('name').trim();
      const baseCur = (interaction.fields.getTextInputValue('baseCur') || 'TWD').toUpperCase();

      const baseRate = BASELINE_RATES[baseCur] ?? 1;
      const autoRates = { [baseCur]: 1 };
      for (const [cur, rateToTWD] of Object.entries(BASELINE_RATES)) {
        if (cur !== baseCur) {
          autoRates[cur] = parseFloat((rateToTWD / baseRate).toFixed(4));
        }
      }

      const newTripId = `trip_${Date.now().toString(36)}`;
      // 💡 統一透過 storage.repairTrip() 補齊預設欄位，避免手動兜物件漏掉
      // DEFAULT_TRIP 未來新增的欄位（例如先前就漏過 deposits）
      const newTrip = storage.repairTrip({
        id: newTripId,
        name,
        baseCurrency: baseCur,
        rates: autoRates,
        members: [{ id: interaction.user.id, name: interaction.user.globalName || interaction.user.username }],
      });

      guild.trips[newTripId] = newTrip;
      guild.activeTripId = newTripId;
      storage.persist();

      return showMainMenu(interaction, `🎉 成功創立新行程！\n**名稱**：${name}\n**本位幣別**：${baseCur}\n已自動帶入常用多國匯率，並切換為當前作用行程！`);
    }

    // 🪙 新增幣別：驗證格式 → 手動匯率優先，留空則嘗試即時匯率
    if (interaction.customId === 'trip_modal_add_currency') {
      const guildId = interaction.guildId;
      const { trip } = resolveTrip(guildId);
      if (!trip) return interaction.reply({ content: '⚠️ 找不到行程，請重新操作。', flags: MessageFlags.Ephemeral });

      const currency = interaction.fields.getTextInputValue('currency').trim().toUpperCase();
      const rateStr = interaction.fields.getTextInputValue('rate');

      if (!/^[A-Z]{2,6}$/.test(currency)) {
        return interaction.reply({ content: '⚠️ 幣別代碼格式錯誤，請輸入 2~6 個英文字母（例如：VND）。', flags: MessageFlags.Ephemeral });
      }

      if (trip.rates[currency] !== undefined) {
        return interaction.reply({
          content: `⚠️ 幣別 \`${currency}\` 已存在於此行程，目前匯率為 1 ${currency} = ${trip.rates[currency]} ${trip.baseCurrency}。`,
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.deferUpdate();

      const manualRate = parseFloat(rateStr);
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
          return renderTripNav(interaction, `❌ 無法自動抓取 \`${currency}\` → ${trip.baseCurrency} 的即時匯率，請重新點選「🪙 新增幣別」並手動輸入匯率。`);
        }
      }

      trip.rates[currency] = rate;
      storage.persist();

      return renderTripNav(interaction, `✅ 已新增幣別 \`${currency}\`！匯率：1 ${currency} = ${rate} ${trip.baseCurrency}（${rateSource}），現在記帳/收訂金時就能選用這個幣別了。`);
    }
  },

  async handleSelectMenu(interaction) {
    if (interaction.customId === 'trip_select_switch') {
      const guildId = interaction.guildId;
      const guild = storage.getGuild(guildId);
      const selectedTripId = interaction.values[0];

      if (!guild.trips[selectedTripId]) return interaction.reply({ content: '⚠️ 選擇的行程不存在。', flags: MessageFlags.Ephemeral });

      guild.activeTripId = selectedTripId;
      storage.persist();

      return showMainMenu(interaction, `🔄 已成功切換目前主作用行程至：**${guild.trips[selectedTripId].name}**`);
    }
  }
};