// handlers/localMusicHandler.js（重構版）
// 職責：本地音訊播放 + 檔案列表 + /locallist 指令
// 佇列 / 指令 / 控制面板 → 全部交由 unifiedQueue.js 管理

const {
  createAudioResource,
  StreamType,
} = require('@discordjs/voice');
const {
  EmbedBuilder,
  SlashCommandBuilder,
} = require('discord.js');
const fs   = require('fs');
const path = require('path');

const { registerEngine, handleAutocomplete } = require('./unifiedQueue');

// ── 音樂資料夾路徑 ────────────────────────────────────────
const MUSIC_DIR = path.join(__dirname, '..', 'music');

// ── 支援的音訊格式 ────────────────────────────────────────
const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];

// ════════════════════════════════════════════════════════
//  工具函式
// ════════════════════════════════════════════════════════
function getMusicFiles() {
  try {
    if (!fs.existsSync(MUSIC_DIR)) {
      console.warn('⚠️ music 資料夾不存在，嘗試建立...');
      fs.mkdirSync(MUSIC_DIR, { recursive: true });
      return [];
    }
    return fs.readdirSync(MUSIC_DIR)
      .filter(file => SUPPORTED_EXTENSIONS.includes(path.extname(file).toLowerCase()))
      .map(file => ({
        name:     path.basename(file, path.extname(file)),
        filename: file,
        filePath: path.join(MUSIC_DIR, file),
      }));
  } catch (err) {
    console.error('❌ 讀取 music 資料夾失敗:', err);
    return [];
  }
}

function getFileSize(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return (stat.size / 1024 / 1024).toFixed(2) + ' MB';
  } catch { return '未知'; }
}

// ── 根據 filename 取得完整 trackInfo ─────────────────────
function getTrackInfo(filename) {
  const files = getMusicFiles();
  const found = files.find(f => f.filename === filename);
  if (!found) return null;
  return {
    ...found,
    fileSize: getFileSize(found.filePath),
  };
}

// ════════════════════════════════════════════════════════
//  playStream（由 unifiedQueue 呼叫）
// ════════════════════════════════════════════════════════
function playStream(guildId, item, player) {
  if (!fs.existsSync(item.filePath)) {
    console.error(`❌ [LocalMusic] 找不到檔案: ${item.filePath}`);
    // 觸發 error → unifiedQueue 的 error handler 會跳過
    player.emit('error', new Error(`找不到檔案: ${item.filename}`));
    return;
  }

  const resource = createAudioResource(item.filePath, {
    inputType:    StreamType.Arbitrary,
    inlineVolume: true,
  });
  resource.volume.setVolume(0.5);
  player.play(resource);
  console.log(`🎵 [LocalMusic] 播放: ${item.filename} (${guildId})`);
}

// ════════════════════════════════════════════════════════
//  setupLocalMusicEngine
// ════════════════════════════════════════════════════════
function setupLocalMusicEngine(client) {

  // 注入引擎到 unifiedQueue
  registerEngine('local', {
    playStream,
    getInfo:      getTrackInfo, // 統一介面（unifiedQueue 會呼叫 getInfo）
    getTrackInfo,
    getMusicFiles,
  });

  // ── Autocomplete（轉交 unifiedQueue 處理）────────────
  client.on('interactionCreate', async interaction => {
    if (!interaction.isAutocomplete()) return;
    handleAutocomplete(interaction);
  });

  // ── /locallist ────────────────────────────────────────
  client.commands.set('locallist', {
    data: new SlashCommandBuilder()
      .setName('locallist')
      .setDescription('列出 music 資料夾內所有可播放的音訊檔案'),
    async execute(interaction) {
      const musicFiles = getMusicFiles();

      if (musicFiles.length === 0) {
        return interaction.reply({
          content:   '❌ music 資料夾內沒有可播放的音訊檔案\n支援格式：`.mp3` `.wav` `.ogg` `.flac` `.m4a` `.aac`',
          ephemeral: true,
        });
      }

      const listText = musicFiles
        .map((f, i) => `${i + 1}. **${f.name}** — \`${f.filename}\` (${getFileSize(f.filePath)})`)
        .join('\n');

      const embed = new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle(`📁 本地音樂清單 (共 ${musicFiles.length} 首)`)
        .setDescription(listText.length > 4096 ? listText.slice(0, 4093) + '...' : listText)
        .setFooter({ text: '使用 /play 選擇播放' })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    },
  });

  console.log('✅ [LocalMusic] 引擎已就緒');
}

module.exports = { setupLocalMusicEngine };