// handlers/localMusicHandler.js（重構版 + 遞迴掃描 + title 清理）
// 職責：本地音訊播放 + 檔案列表 + /locallist 指令
// 佇列 / 指令 / 控制面板 → 全部交由 unifiedQueue.js 管理

const {
  createAudioResource,
  StreamType,
} = require('@discordjs/voice');
const {
  EmbedBuilder,
  SlashCommandBuilder,
  MessageFlags,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const { registerEngine, handleAutocomplete } = require('./unifiedQueue');
const { CACHE_DIR } = require('./musicCache');
const logger = require('../../utils/logger');

// ── 音樂資料夾路徑 ────────────────────────────────────────
const MUSIC_DIR = path.join(__dirname, '..', '..', 'data', 'music');

// ── 快取資料夾在 MUSIC_DIR 底下的資料夾名稱（例如 'cache'） ──
// 用來判斷掃到的檔案是「使用者手動放的本地音樂」還是「線上快取」，
// 快取檔案會依 cache/<作者>/<標題>.mp3 的結構分類，清單顯示時
// 會在標題後方加註作者，並讓同作者的曲目集中呈現
const CACHE_FOLDER_NAME = path.basename(CACHE_DIR);

// ── 支援的音訊格式 ────────────────────────────────────────
const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];

// ════════════════════════════════════════════════════════
//  工具函式
// ════════════════════════════════════════════════════════
function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

function cleanLocalTitle(raw) {
  let t = String(raw || '').trim();

  // 1) 去副檔名（保險）
  t = t.replace(/\.(mp3|wav|ogg|flac|m4a|aac)$/i, '');

  // 2) 去掉 bilibili / youtube 常見快取尾巴
  //    [BVxxxx], [av123], [yt_xxxxx]
  t = t.replace(/\s*\[(?:BV[\w]+|av\d+|yt_[A-Za-z0-9_-]{6,})\]\s*$/i, '');

  // 3) 也去掉括號版尾巴
  //    (BVxxxx), (av123), (yt_xxxxx)
  t = t.replace(/\s*\((?:BV[\w]+|av\d+|yt_[A-Za-z0-9_-]{6,})\)\s*$/i, '');

  // 4) 去掉前綴來源標籤（例如 [cache] xxx）
  t = t.replace(/^\[[^\]]+\]\s*/i, '');

  // 5) 底線 -> 空白，壓縮多空白
  t = t.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

  return t || '未知標題';
}

function walkFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let out = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(walkFiles(fullPath));
    } else {
      out.push(fullPath);
    }
  }

  return out;
}

function getMusicFiles() {
  try {
    if (!fs.existsSync(MUSIC_DIR)) {
      console.warn('⚠️ data/music 資料夾不存在，嘗試建立...');
      fs.mkdirSync(MUSIC_DIR, { recursive: true });
      return [];
    }

    const allFiles = walkFiles(MUSIC_DIR);

    return allFiles
      .filter(filePath =>
        SUPPORTED_EXTENSIONS.includes(path.extname(filePath).toLowerCase())
      )
      .map(filePath => {
        const relPath = path.relative(MUSIC_DIR, filePath); // e.g. cache/作者/xxx.mp3
        const ext = path.extname(filePath);
        const baseName = path.basename(filePath, ext);
        const relParts = relPath.split(path.sep);
        const isCacheFile = relParts[0] === CACHE_FOLDER_NAME;

        let displayName;

        if (isCacheFile && relParts.length >= 3) {
          // 新版快取結構：cache/<作者>/<標題 [ID]>.mp3
          // → 清單顯示「標題 — 作者」，同作者的曲目會因為在同一層
          //   資料夾而在排序後自然聚在一起，不再與本地檔案混雜
          const authorFolder = relParts[relParts.length - 2];
          displayName = `${cleanLocalTitle(baseName)} — ${authorFolder}`;
        } else if (isCacheFile) {
          // 舊版快取（升級前，未分類作者資料夾），維持原本清理邏輯即可，
          // 這類殘留檔案會隨快取 LRU 清理機制逐漸被新結構取代
          displayName = cleanLocalTitle(baseName);
        } else {
          // 使用者手動放置的本地音樂（或其他非快取子資料夾）
          const sourcePrefix = relPath.includes(path.sep) ? `[${relParts[0]}] ` : '';
          displayName = cleanLocalTitle(`${sourcePrefix}${baseName}`);
        }

        return {
          name: displayName,                            // 給 UI 顯示的名稱
          filename: normalizePath(relPath),             // 真正辨識用（保留副檔名）
          filePath,                                     // 實體路徑
        };
      })
      // 依路徑排序：讓 cache/<作者>/ 底下的曲目彼此相鄰，
      // 本地手動音樂與各作者的快取分類會呈現穩定、可預期的分組順序
      .sort((a, b) => a.filename.localeCompare(b.filename, 'zh-Hant'));
  } catch (err) {
    console.error('❌ 讀取 data/music 資料夾失敗:', err);
    return [];
  }
}

function getFileSize(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return (stat.size / 1024 / 1024).toFixed(2) + ' MB';
  } catch {
    return '未知';
  }
}

function getTrackInfo(filename) {
  const files = getMusicFiles();

  const target = normalizePath(filename);
  const found = files.find(f => normalizePath(f.filename) === target);
  if (!found) return null;

  return {
    ...found,
    title: cleanLocalTitle(found.name), // 再保險清理一次
    fileSize: getFileSize(found.filePath),
  };
}

// ════════════════════════════════════════════════════════
//  playStream（由 unifiedQueue 呼叫）
// ════════════════════════════════════════════════════════
function playStream(guildId, item, player, { silent = false } = {}) {
  if (!fs.existsSync(item.filePath)) {
    console.error(`❌ [LocalMusic] 找不到檔案: ${item.filePath}`);
    player.emit('error', new Error(`找不到檔案: ${item.filename}`));
    return;
  }

  const resource = createAudioResource(item.filePath, {
    inputType: StreamType.Arbitrary,
    inlineVolume: true,
  });
  resource.volume.setVolume(0.5);
  player.play(resource);

  if (!silent) {
    console.log(`🎵 [LocalMusic] 播放: ${item.title} (${guildId})`);
  }
}

// ════════════════════════════════════════════════════════
//  buildLocalListReply：組出「本地音樂清單」的回覆內容
//  供 unifiedQueue/commands.js 的 /music local list 呼叫
//  （/locallist 已合併進 /music local list）
// ════════════════════════════════════════════════════════
function buildLocalListReply() {
  const musicFiles = getMusicFiles();

  if (musicFiles.length === 0) {
    return {
      content: '❌ data/music 資料夾內沒有可播放的音訊檔案\n支援格式：`.mp3` `.wav` `.ogg` `.flac` `.m4a` `.aac`',
      flags: MessageFlags.Ephemeral,
    };
  }

  const listText = musicFiles
    .map((f, i) => `${i + 1}. **${f.name}** — \`${f.filename}\` (${getFileSize(f.filePath)})`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x1DB954)
    .setTitle(`📁 本地音樂清單 (共 ${musicFiles.length} 首)`)
    .setDescription(listText.length > 4096 ? listText.slice(0, 4093) + '...' : listText)
    .setFooter({ text: '可使用 /play 指令播放（可直接選擇自動完成）' })
    .setTimestamp();

  return { embeds: [embed] };
}

// ════════════════════════════════════════════════════════
//  setupLocalMusicEngine
// ════════════════════════════════════════════════════════
function setupLocalMusicEngine(client) {
  // 注入引擎到 unifiedQueue
  registerEngine('local', {
    playStream,
    getInfo: getTrackInfo,
    getTrackInfo,
    getMusicFiles,
  });

  // ── Autocomplete ──────────────────────────────────────
  client.on('interactionCreate', async interaction => {
    if (!interaction.isAutocomplete()) return;
    handleAutocomplete(interaction);
  });

  logger.debug('LocalMusic', '引擎已載入（清單功能已合併進 /music local list）');
}

module.exports = {
  setupLocalMusicEngine,
  getMusicFiles,
  getTrackInfo,
  playStream,
  buildLocalListReply,
};