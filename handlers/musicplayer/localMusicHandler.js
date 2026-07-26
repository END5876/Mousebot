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
const logger = require('../../utils/logger');

// ── 音樂資料夾路徑 ────────────────────────────────────────
const MUSIC_DIR = path.join(__dirname, '..', '..', 'data', 'music');

// ── 支援的音訊格式 ────────────────────────────────────────
const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];

// ════════════════════════════════════════════════════════
//  播放次數持久化（用 filename 當 key，跨伺服器共用同一份統計）
//  ── 每次本地曲目被實際播放時 +1，清單依此由高到低排序 ──
//  ⚠️ 循環重播（單曲循環 / 列表循環繞圈）不計入，由呼叫端
//     （unifiedQueue/playback.js）透過 countPlay 參數控制。
// ════════════════════════════════════════════════════════
const PLAYCOUNT_PATH = path.join(__dirname, '..', '..', 'data', 'musicPlayCount.json');

/** @type {Map<string, number>} filename → 播放次數 */
let playCountMap = new Map();

function ensureDataDir() {
  const dir = path.dirname(PLAYCOUNT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadPlayCounts() {
  try {
    if (fs.existsSync(PLAYCOUNT_PATH)) {
      const raw = JSON.parse(fs.readFileSync(PLAYCOUNT_PATH, 'utf-8'));
      playCountMap = new Map(Object.entries(raw));
      logger.debug('LocalMusic', `已載入 ${playCountMap.size} 筆播放次數紀錄`);
    }
  } catch (err) {
    logger.warn('LocalMusic', `播放次數紀錄載入失敗：${err.message}`);
    playCountMap = new Map();
  }
}

function savePlayCounts() {
  try {
    ensureDataDir();
    fs.writeFileSync(PLAYCOUNT_PATH, JSON.stringify(Object.fromEntries(playCountMap), null, 2), 'utf-8');
  } catch (err) {
    console.error('❌ [LocalMusic] 播放次數紀錄儲存失敗：', err.message);
  }
}

function getPlayCount(filename) {
  return playCountMap.get(normalizePath(filename)) || 0;
}

function incrementPlayCount(filename) {
  const key = normalizePath(filename);
  const next = (playCountMap.get(key) || 0) + 1;
  playCountMap.set(key, next);
  savePlayCounts();
  logger.debug('LocalMusic', `播放次數 +1：${key} → ${next}`);
}

// 啟動時載入既有紀錄
loadPlayCounts();

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

    const files = allFiles
      .filter(filePath =>
        SUPPORTED_EXTENSIONS.includes(path.extname(filePath).toLowerCase())
      )
      .map(filePath => {
        const relPath = path.relative(MUSIC_DIR, filePath); // e.g. cache/xxx.mp3
        const ext = path.extname(filePath);
        const baseName = path.basename(filePath, ext);

        // 若在子資料夾，先加來源前綴再清理（清理函式會拿掉前綴，只作中間資訊保留）
        const sourcePrefix = relPath.includes(path.sep) ? `[${relPath.split(path.sep)[0]}] ` : '';
        const displayNameRaw = `${sourcePrefix}${baseName}`;
        const filename = normalizePath(relPath);

        return {
          name: cleanLocalTitle(displayNameRaw),        // 給 UI 顯示的乾淨名稱
          filename,                                     // 真正辨識用（保留副檔名）
          filePath,                                     // 實體路徑
          playCount: getPlayCount(filename),            // 🆕 播放次數，供排序 / 顯示使用
        };
      });

    // 🆕 依播放次數由高到低排序；次數相同則依名稱排序，維持穩定、好預期的順序
    files.sort((a, b) => {
      if (b.playCount !== a.playCount) return b.playCount - a.playCount;
      return a.name.localeCompare(b.name, 'zh-Hant');
    });

    return files;
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
function playStream(guildId, item, player, { silent = false, countPlay = true } = {}) {
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

  // 🆕 只有「真正輪到的新播放」才計入次數；單曲/列表循環的重複播放（由呼叫端
  //    透過 countPlay: false 標記）不計，避免開著循環放整晚把次數洗爆
  if (item.filename && countPlay) incrementPlayCount(item.filename);

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
    .map((f, i) => `${i + 1}. **${f.name}** — \`${f.filename}\` (${getFileSize(f.filePath)}) · ▶️ ${f.playCount} 次`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(0x1DB954)
    .setTitle(`📁 本地音樂清單 (共 ${musicFiles.length} 首，依播放次數排序)`)
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

  logger.debug('LocalMusic', '引擎已載入（清單功能已合併進 /music local list，並依播放次數排序）');
}

module.exports = {
  setupLocalMusicEngine,
  getMusicFiles,
  getTrackInfo,
  playStream,
  buildLocalListReply,
};