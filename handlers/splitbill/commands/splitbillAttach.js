'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const splitbillClient = require('../utils/splitbillClient');

/**
 * 🔗 /splitbill-attach —— 把網頁上建立的行程綁定到這個伺服器。
 *
 * 流程：行程建立者在網頁「設定 → Discord 綁定」產生綁定碼 → 在要綁定的伺服器
 * 執行 /splitbill-attach code:<綁定碼>。綁定後這個伺服器的 /splitbill 面板就能
 * 操作該行程，網頁那邊的網址、分享連結都不受影響。
 *
 * 做成獨立指令而不是 /splitbill 的子指令：Discord 一旦替指令加了子指令，原本
 * 的 /splitbill 就不能再單獨執行，會破壞既有的「直接打 /splitbill 開面板」用法。
 *
 * 權限完全由 splitbill-service 判斷（執行者必須是行程建立者或 OWNER_USER_ID），
 * 這裡只負責把 Discord 端的身分（x-actor-id）與伺服器 ID 帶過去。
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('splitbill-attach')
    .setDescription('把網頁上建立的分帳行程綁定到這個伺服器（需要網頁產生的綁定碼）')
    .addStringOption(opt =>
      opt.setName('code').setDescription('網頁「Discord 綁定」產生的 8 碼綁定碼').setRequired(true).setMaxLength(20)),

  async execute(interaction) {
    if (!interaction.guildId) {
      return interaction.reply({ content: '⚠️ 請在要綁定的伺服器裡執行這個指令。', flags: MessageFlags.Ephemeral });
    }
    if (!splitbillClient.isConfigured()) {
      return interaction.reply({ content: '⚠️ 分帳服務尚未設定（SPLITBILL_SERVICE_URL），無法綁定。', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const code = interaction.options.getString('code');
    const actorName = (interaction.member && interaction.member.displayName)
      || interaction.user.globalName || interaction.user.username;

    try {
      const result = await splitbillClient.attachTrip(interaction.guildId, code, interaction.user.id, actorName);
      const trip = result.trip;
      const lines = [
        result.alreadyAttached
          ? `行程「**${trip.name}**」原本就綁在這個伺服器了。`
          : `已把行程「**${trip.name}**」綁定到這個伺服器！`,
        `👥 成員 ${trip.members.length} 人（其中 ${trip.members.filter(m => !m.discordId).length} 人尚未連結 Discord）`,
      ];
      if (result.joined) lines.push('🙋 你已自動加入為這個行程的成員。');
      lines.push('', '已切換為你的作用行程，輸入 `/splitbill` 即可開始操作。');
      lines.push('尚未連結 Discord 的成員：本人可以用網頁的邀請連結認領，或由任何成員在「👥 成員管理 → 🔗 連結 Discord 帳號」替他連結。');

      const embed = new EmbedBuilder().setColor(0x2ecc71).setTitle('🔗 綁定成功').setDescription(lines.join('\n'));
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      // service 的錯誤訊息本身就是給使用者看的中文說明（綁定碼錯誤、不是建立者、已綁別的伺服器…）
      const msg = err.status && err.status < 500 ? err.message : `綁定失敗：${err.message}`;
      return interaction.editReply({ content: `❌ ${msg}` });
    }
  }
};
