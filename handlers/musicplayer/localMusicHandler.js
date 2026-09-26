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
const libraryClient = require('./musicLibraryClient');

// ── 音樂資料夾路徑 ────────────────────────────────────────
// 多 Bot 共用音樂庫模式下，這裡是「本地小快取磁碟」的路徑，不再是音樂庫
// 本身——真正的音樂庫由 library-service/ 統一管理。沒有設定 MUSIC_LIB_URL
// 時（例如單一 Bot 部署 / 本機開發），維持過去「這裡就是音樂庫本身」的行為。
const MUSIC_DIR = path.join(__dirname, '..', '..', 'data', 'music');

// ── 支援的音訊格式 ────────────────────────────────────────
const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];

// ── 共用音樂庫模式下，本地清單快取的刷新頻率 ──────────────
const LIBRARY_LIST_REFRESH_MS = 20_000;

// ════════════════════════════════════════════════════════
//  播放次數持久化（僅在「未設定共用音樂庫」時使用的 fallback）
//  ── 每次本地曲目被實際播放時 +1，清單依此由高到低排序 ──
//  ⚠️ 循環重播（單曲循環 / 列表循環繞圈）不計入，由呼叫端
//     （unifiedQueue/playback.js）透過 countPlay 參數控制。
//  ★ 設定了 MUSIC_LIB_URL 之後，播放次數改由 library-service 集中管理
//    （見 libraryClient.incrementPlayCount()），這裡的 JSON 檔就不會再
//    被寫入，避免多台 Bot 各自累積出不一致的次數。
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

// 未設定共用音樂庫時的舊行為：直接掃描本地 data/music。
function _getMusicFilesLocalWalk() {
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
          playCount: getPlayCount(filename),            // 播放次數，供排序 / 顯示使用
        };
      });

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

// ════════════════════════════════════════════════════════
//  共用音樂庫模式：本地維護一份定期刷新的清單快取，讓
//  getMusicFiles() 保持同步呼叫介面（autocomplete 等呼叫端
//  不用改成 async），實際內容則來自 library-service 的 /list。
// ════════════════════════════════════════════════════════
let _libraryListCache = [];
let _libraryListRefreshTimer = null;
let _libraryListRefreshInFlight = null;

function _libraryFileToLocalEntry(f) {
  const parts = f.filename.split('/');
  return {
    name: f.name,
    filename: f.filename,
    filePath: path.join(MUSIC_DIR, ...parts), // 本地鏡像路徑，播放時若不存在會即時向共用音樂庫下載
    playCount: f.playCount,
  };
}

async function _refreshLibraryList() {
  if (!libraryClient.isConfigured()) return;
  if (_libraryListRefreshInFlight) return _libraryListRefreshInFlight;

  _libraryListRefreshInFlight = libraryClient.fetchList()
    .then((files) => {
      _libraryListCache = files;
    })
    .catch((err) => {
      logger.warn('LocalMusic', `向共用音樂庫取得清單失敗，暫時沿用舊清單：${err.message}`);
    })
    .finally(() => {
      _libraryListRefreshInFlight = null;
    });

  return _libraryListRefreshInFlight;
}

function getMusicFiles() {
  if (!libraryClient.isConfigured()) {
    return _getMusicFilesLocalWalk();
  }
  return _libraryListCache.map(_libraryFileToLocalEntry);
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
//  ★ 共用音樂庫模式：本地沒有這個檔案時（例如這台 Bot 剛啟動、
//    本地快取還是空的，或是曲目是別台 Bot 下載的），先向
//    library-service 下載一份到本地小快取磁碟，再播放。
//    playback.js 呼叫這裡時本來就有 await，所以改成 async 不影響呼叫端。
// ════════════════════════════════════════════════════════
async function playStream(guildId, item, player, { silent = false, countPlay = true } = {}) {
  if (!fs.existsSync(item.filePath)) {
    if (libraryClient.isConfigured()) {
      try {
        if (!silent) console.log(`⬇️ [LocalMusic] 本地無此檔案，向共用音樂庫下載: ${item.filename}`);
        await libraryClient.downloadToFile(item.filename, item.filePath);
      } catch (err) {
        console.error(`❌ [LocalMusic] 向共用音樂庫下載失敗: ${item.filename} (${err.message})`);
        player.emit('error', new Error(`找不到檔案: ${item.filename}`));
        return;
      }
    } else {
      console.error(`❌ [LocalMusic] 找不到檔案: ${item.filePath}`);
      player.emit('error', new Error(`找不到檔案: ${item.filename}`));
      return;
    }
  }

  const resource = createAudioResource(item.filePath, {
    inputType: StreamType.Arbitrary,
    inlineVolume: true,
  });
  player.play(resource);

  // 只有「真正輪到的新播放」才計入次數；單曲/列表循環的重複播放（由呼叫端
  // 透過 countPlay: false 標記）不計，避免開著循環放整晚把次數洗爆
  if (item.filename && countPlay) {
    if (libraryClient.isConfigured()) {
      libraryClient.incrementPlayCount(item.filename).catch((err) => {
        logger.warn('LocalMusic', `播放次數同步至共用音樂庫失敗（不影響播放）：${err.message}`);
      });
      // 樂觀更新本地清單快取，讓 /music local list 不用等下一輪 20 秒刷新
      // 就能看到最新次數；下一輪刷新會用 library-service 的權威數字覆蓋回來。
      const cached = _libraryListCache.find(f => f.filename === item.filename);
      if (cached) cached.playCount += 1;
    } else {
      incrementPlayCount(item.filename);
    }
  }

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

  if (libraryClient.isConfigured()) {
    // 立即抓一次（不 await，避免拖慢啟動流程；剛開機的極短時間內
    // getMusicFiles() 可能還是空陣列，屬於可接受的暫時性狀態），
    // 之後每 20 秒背景刷新一次。
    _refreshLibraryList();
    _libraryListRefreshTimer = setInterval(_refreshLibraryList, LIBRARY_LIST_REFRESH_MS);
    logger.debug('LocalMusic', `已啟用共用音樂庫模式（${process.env.MUSIC_LIB_URL}），本地清單每 ${LIBRARY_LIST_REFRESH_MS / 1000} 秒刷新一次`);
  } else {
    logger.debug('LocalMusic', '未設定 MUSIC_LIB_URL，使用原本的本地磁碟音樂庫模式');
  }

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