// handlers/musicplayer/unifiedQueue/commands/playCommand.js
// 職責：/play 獨立頂層指令（依需求維持原樣，不併入 /music）

const { SlashCommandBuilder } = require('discord.js');
const { handlePlay } = require('../search');

async function handleMusicPlay(interaction) {
  await interaction.deferReply();
  const input = interaction.options.getString('input');
  const shuffleOpt = interaction.options.getString('shuffle') ?? 'no';
  await handlePlay(interaction, input, shuffleOpt);
}

const playCommand = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('播放 Bilibili / YouTube 影片，或本地音訊檔案')
    .addStringOption(opt =>
      opt.setName('input')
        .setDescription('影片網址 或 本地檔名（輸入關鍵字可搜尋；選「全部本地音樂」一次加入所有）')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(opt =>
      opt.setName('shuffle')
        .setDescription('全部加入時的排序方式（單首播放時忽略此選項）')
        .setRequired(false)
        .addChoices(
          { name: '📋 依檔名順序（預設）', value: 'no' },
          { name: '🔀 隨機排序', value: 'yes' },
        )
    ),
  async execute(interaction) {
    return handleMusicPlay(interaction);
  }
};

module.exports = { playCommand, handleMusicPlay };
