'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const storage = require('../utils/storage');
const { resolveTrip, memberDisplay, ensureMembersExist } = require('../utils/tripHelper');
const { equalSplit, fetchRealTimeRate, round2 } = require('../utils/calculator');
const { parsePayerField, parseSplitField } = require('../utils/parse');

/**
 * ⚡ /splitbill-quick —— 免開面板的一行記帳指令。
 * 給熟悉語法的重度使用者：常見情境（單一代墊人 + 全體或部分成員平分）
 * 一行打完就能記一筆帳；複雜情境（多人不等額代墊、自訂分攤金額）
 * 也支援用 <@id1>=金額,<@id2>=金額 語法直接輸入，不必跳 4 層按鈕。
 *
 * 想要完整的引導式操作（含收訂金、結算、成員管理），還是請用 /splitbill 開面板。
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('splitbill-quick')
    .setDescription('⚡ 快速新增一筆花費（免開面板，適合單一代墊人的簡單情境）')
    .addStringOption(opt =>
      opt.setName('item').setDescription('項目名稱（例如：計程車、晚餐）').setRequired(true))
    .addNumberOption(opt =>
      opt.setName('amount').setDescription('金額').setRequired(true).setMinValue(0.01))
    .addStringOption(opt =>
      opt.setName('currency').setDescription('幣別代碼（預設使用行程本位幣）').setRequired(false))
    .addUserOption(opt =>
      opt.setName('payer').setDescription('代墊人（預設為你自己；多人代墊請改用 multi_payers）').setRequired(false))
    .addStringOption(opt =>
      opt.setName('split').setDescription('分攤方式：equal（預設全體平分）、equal:<@id1>,<@id2>、或 <@id1>=300,<@id2>=700').setRequired(false))
    .addStringOption(opt =>
      opt.setName('multi_payers').setDescription('多人代墊（會覆蓋 payer）：<@id1>=600,<@id2>=400').setRequired(false)),

  async execute(interaction) {
    const { guildId, user } = interaction;
    const { trip, error } = resolveTrip(guildId);

    if (!trip) {
      return interaction.reply({
        content: `⚠️ ${error || '尚未指定行程，請先用 /splitbill 面板建立或選擇行程。'}`,
        flags: MessageFlags.Ephemeral
      });
    }

    const description = interaction.options.getString('item').trim();
    const amount = round2(interaction.options.getNumber('amount'));
    const currency = (interaction.options.getString('currency') || trip.baseCurrency).toUpperCase();
    const payerUser = interaction.options.getUser('payer');
    const multiPayersText = interaction.options.getString('multi_payers');
    const splitText = interaction.options.getString('split');

    if (!(amount > 0)) {
      return interaction.reply({ content: '⚠️ 金額必須大於 0。', flags: MessageFlags.Ephemeral });
    }

    if (!trip.rates[currency]) {
      return interaction.reply({
        content: `⚠️ 此行程尚未設定幣別 \`${currency}\` 的匯率。請先到 \`/splitbill\` 面板「🧳 行程設定 → 🪙 新增幣別」加入這個幣別後再試一次。`,
        flags: MessageFlags.Ephemeral
      });
    }

    await interaction.deferReply();

    try {
      // 1. 解析代墊人：優先採用 multi_payers 的文字語法，否則用 payer 選項（預設為指令發起人）
      let payers;
      if (multiPayersText) {
        payers = parsePayerField(multiPayersText, amount);
        ensureMembersExist(trip, payers.map(p => p.userId));
        const payerSum = round2(payers.reduce((s, p) => s + p.amount, 0));
        if (Math.abs(payerSum - amount) > 0.01) {
          throw new Error(`multi_payers 金額加總 (${payerSum}) 與總花費 (${amount}) 不相符，差額 ${round2(Math.abs(payerSum - amount))}`);
        }
      } else {
        const payerId = payerUser ? payerUser.id : user.id;
        ensureMembersExist(trip, [payerId]);
        payers = [{ userId: payerId, amount }];
      }

      // 2. 解析分攤方式：預設 equal（全體平分）
      const allMemberIds = trip.members.map(m => m.id);
      const splitInfo = parseSplitField(splitText, allMemberIds);
      ensureMembersExist(trip, splitInfo.ids);

      let shares;
      if (splitInfo.mode === 'equal') {
        shares = equalSplit(amount, splitInfo.ids);
      } else {
        const shareSum = round2(splitInfo.customShares.reduce((s, p) => s + p.amount, 0));
        if (Math.abs(shareSum - amount) > 0.01) {
          throw new Error(`split 自訂金額加總 (${shareSum}) 與總花費 (${amount}) 不相符，差額 ${round2(Math.abs(shareSum - amount))}`);
        }
        shares = splitInfo.customShares.map(p => ({ userId: p.userId, share: p.amount }));
      }

      // 3. 匯率：非本位幣時嘗試即時匯率，抓不到就退回行程預設匯率
      let exchangeRate;
      let rateSource;
      if (currency === trip.baseCurrency) {
        exchangeRate = 1;
        rateSource = '本位幣';
      } else {
        const liveRate = await fetchRealTimeRate(currency, trip.baseCurrency);
        if (liveRate) {
          exchangeRate = liveRate;
          rateSource = '網路即時';
        } else {
          exchangeRate = trip.rates[currency];
          rateSource = '行程預設';
        }
      }

      const amountInBase = round2(amount * exchangeRate);

      const newExpense = {
        id: storage.genId('exp'),
        description,
        amount,
        currency,
        exchangeRate,
        rateSource,
        amountInBase,
        payers,
        participants: shares.map(s => ({ userId: s.userId, amount: s.share })),
        createdAt: Date.now(),
        createdBy: user.id
      };

      trip.expenses.push(newExpense);
      storage.persist();

      const payerText = payers.map(p => `${memberDisplay(trip, p.userId)}(${p.amount})`).join('、');
      const participantText = newExpense.participants.map(s => `${memberDisplay(trip, s.userId)}(${s.amount})`).join('、');

      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('⚡ 快速記帳成功！')
        .setDescription(
          `**${description}** — ${amount} ${currency} ➔ ${amountInBase} ${trip.baseCurrency}（匯率來源：${rateSource}）\n\n` +
          `💰 代墊：${payerText}\n` +
          `🎯 分攤：${participantText}`
        )
        .setFooter({ text: `行程：${trip.name}` });

      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      return interaction.editReply({ content: `❌ 記帳失敗：${err.message}` });
    }
  }
};