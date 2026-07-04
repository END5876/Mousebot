// handlers/onlineMusicHandler.js
// 職責：引擎初始化、playStream、getInfo、快取流程、串流 fallback、重試邏輯、線上搜尋(searchMulti)
// 依賴：musicCache.js、musicAntiBot.js、unifiedQueue.js

const {
  createAudioResource,
  StreamType,
} = require('@discordjs/voice');
const { spawn, exec } = require('child_process');
const { promisify }   = require('util');
const path = require('path');

const { registerEngine, stopAll } = require('./unifiedQueue');

const cache   = require('./musicCache');
const antiBot = require('./musicAntiBot');

const execAsync = promisify(exec);
const ytdlpPath = 'yt-dlp';

// ── 重試配置 ──────────────────────────────────────────────
const MAX_RETRIES            = 3;
const RETRY_DELAY            = 3000;
const MAX_CONSECUTIVE_ERRORS = 5;

// ── 超過此秒數則只串流，不下載快取 ───────────────────────
const MAX_CACHE_DURATION_SEC = 7 * 60; // 420 秒

// ── 搜尋逾時保護（避免 yt-dlp 卡住導致整個搜尋流程無限等待）──
const SEARCH_TIMEOUT_MS = 15_000;

// ── 新增：getInfo 逾時保護 ────────────────────────────────
const GET_INFO_TIMEOUT_MS = 15_000;

// ── 進程 & 錯誤計數 ───────────────────────────────────────
const activeProcesses = new Map(); // guildId -> ChildProcess
const errorCounts     = new Map(); // guildId -> number

// ── 下載鎖（防止同一 URL 同時下載兩次）──────────────────
const downloadingUrls = new Set();

// ════════════════════════════════════════════════════════
//  環境檢查
// ════════════════════════════════════════════════════════
async function checkYtDlp() {
  try {
    const { stdout } = await execAsync(`${ytdlpPath} --version`);
    console.log(`✅ yt-dlp 版本: ${stdout.trim()}`);
    return true;
  } catch {
    console.error('❌ yt-dlp 未安裝');
    return false;
  }
}

async function checkFFmpeg() {
  for (const p of ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    try { await execAsync(`${p} -version`); console.log(`✅ FFmpeg: ${p}`); return true; }
    catch {}
  }
  console.error('❌ FFmpeg 未找到');
  return false;
}

// ════════════════════════════════════════════════════════
//  工具
// ════════════════════════════════════════════════════════
function formatDuration(seconds) {
  if (!seconds) return '未知';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

function cleanupProcess(guildId) {
  const old = activeProcesses.get(guildId);
  if (old && !old.killed) {
    console.log('🧹 清理舊的 yt-dlp 進程');
    try {
      old.kill('SIGTERM');
      setTimeout(() => { if (!old.killed) old.kill('SIGKILL'); }, 1000);
    } catch {}
    activeProcesses.delete(guildId);
  }
}

// ════════════════════════════════════════════════════════
//  getInfo（取得影片資訊）— YouTube + Bilibili
// ════════════════════════════════════════════════════════
async function getInfo(url) {
  return new Promise((resolve, reject) => {
    const args  = antiBot.buildInfoArgs(url);
    const ytdlp = spawn(ytdlpPath, args);
    let data = '', errorData = '';
    let finished = false; // ★ 新增

    // ★ 新增：逾時保護
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      console.warn(`⚠️ [getInfo] 逾時（超過 ${GET_INFO_TIMEOUT_MS / 1000}s），強制終止: ${url}`);
      try { ytdlp.kill('SIGKILL'); } catch {}
      reject(new Error('取得影片資訊逾時，請確認網址是否正確或稍後再試'));
    }, GET_INFO_TIMEOUT_MS);

    ytdlp.stdout.on('data', c => { data      += c.toString(); });
    ytdlp.stderr.on('data', c => { errorData += c.toString(); });

    ytdlp.on('close', code => {
      if (finished) return;   // ★ 新增
      finished = true;        // ★ 新增
      clearTimeout(timer);    // ★ 新增

      if (code !== 0) {
        console.error('yt-dlp 錯誤輸出:', errorData);
        if (antiBot.isYouTubeUrl(url)) {
          const classified = antiBot.classifyYouTubeError(errorData);
          reject(new Error(`[YouTube] ${classified.msg}`));
        } else {
          const classified = antiBot.classifyBilibiliError(errorData);
          reject(new Error(`[Bilibili] ${classified.msg}`));
        }
        return;
      }
      try {
        const info = JSON.parse(data.trim().split('\n').pop());
        resolve({
          url,
          title      : info.title    || '未知標題',
          author     : info.uploader || info.channel || info.creator || '未知作者',
          duration   : formatDuration(info.duration),
          durationSec: info.duration || 0,   // 保留原始秒數，供快取判斷使用
          thumbnail  : info.thumbnail || null,
        });
      } catch { reject(new Error('解析影片資訊失敗')); }
    });

    ytdlp.on('error', err => {
      if (finished) return;   // ★ 新增
      finished = true;        // ★ 新增
      clearTimeout(timer);    // ★ 新增
      reject(new Error('執行 yt-dlp 失敗: ' + err.message));
    });
  });
}

// ════════════════════════════════════════════════════════
//  searchOnePlatform — 搜尋單一平台（內部工具，不對外匯出）
//
//  ⚠️ 注意：這裡刻意不呼叫 antiBot.buildInfoArgs()，因為該函式
//  內部依賴 antiBot.isYouTubeUrl(url) 判斷平台以套用對應 headers/cookies，
//  而搜尋時傳入的是 "ytsearch5:關鍵字" 這種偽 URL，不是真正網址，
//  isYouTubeUrl() 的正規表達式比對不到，行為不可預期。
//  因此搜尋改用最基本的 yt-dlp 參數，若日後遇到搜尋被平台擋
//  （出現驗證碼 / 403 等錯誤），需要另外補上對應的 headers/cookies 參數。
// ════════════════════════════════════════════════════════
function _searchOnePlatform(searchPrefix, keyword, limit) {
  return new Promise((resolve) => {
    const query = `${searchPrefix}${limit}:${keyword}`;
    const args = [
      query,
      '--flat-playlist',   // 只拿列表資訊，不逐筆完整解析 → 速度快，但時長多半是「未知」
      '--dump-json',
      '--no-warnings',
      '--socket-timeout', '10',
    ];

    const ytdlp = spawn(ytdlpPath, args, { windowsHide: true });
    let data = '', errorData = '';
    let finished = false;

    // ── 逾時保護：避免 yt-dlp 卡住讓整個 searchMulti 永久等待 ──
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      console.warn(`⚠️ [Search] ${searchPrefix} 搜尋逾時（超過 ${SEARCH_TIMEOUT_MS / 1000}s），強制終止`);
      try { ytdlp.kill('SIGKILL'); } catch {}
      resolve([]);
    }, SEARCH_TIMEOUT_MS);

    ytdlp.stdout.on('data', c => { data      += c.toString(); });
    ytdlp.stderr.on('data', c => { errorData += c.toString(); });

    ytdlp.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0 || !data.trim()) {
        console.warn(`⚠️ [Search] ${searchPrefix} 搜尋失敗 (code=${code}): ${errorData.slice(0, 200)}`);
        resolve([]); // 失敗回空陣列，不讓另一平台的搜尋結果被拖累
        return;
      }

      const lines = data.trim().split('\n').filter(Boolean);
      const results = [];
      const isYT = searchPrefix === 'ytsearch';

      for (const line of lines) {
        try {
          const info = JSON.parse(line);

          const url = info.webpage_url
            || info.url
            || (isYT  && info.id ? `https://www.youtube.com/watch?v=${info.id}` : null)
            || (!isYT && info.id ? `https://www.bilibili.com/video/${info.id}`   : null);

          if (!url) continue;

          const thumb = info.thumbnail
            || (Array.isArray(info.thumbnails) && info.thumbnails.length
                  ? info.thumbnails[info.thumbnails.length - 1].url
                  : null);

          results.push({
            platform : isYT ? 'YouTube' : 'Bilibili',
            title    : info.title || '未知標題',
            author   : info.uploader || info.channel || info.creator || '未知作者',
            duration : formatDuration(info.duration), // flat-playlist 模式下通常是「未知」
            url,
            thumbnail: thumb,
          });
        } catch {
          // 忽略單行解析錯誤，不影響其他結果
        }
      }
      resolve(results);
    });

    ytdlp.on('error', err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      console.warn(`⚠️ [Search] ${searchPrefix} 執行 yt-dlp 失敗: ${err.message}`);
      resolve([]);
    });
  });
}

// ════════════════════════════════════════════════════════
//  searchMulti — 僅搜尋 YouTube
//  @param {string} keyword  搜尋關鍵字
//  @param {number} limit    抓取筆數（預設 5）
//  @returns {Promise<Array>} YouTube 搜尋結果
// ════════════════════════════════════════════════════════
async function searchMulti(keyword, limit = 5) {
  const ytResults = await _searchOnePlatform('ytsearch', keyword, limit);
  return ytResults;
}

// ════════════════════════════════════════════════════════
//  playStream（由 unifiedQueue 呼叫）
// ════════════════════════════════════════════════════════
async function playStream(guildId, item, player, { retryCount = 0, silent = false } = {}) {
  cleanupProcess(guildId);

  const platform = antiBot.isYouTubeUrl(item.url) ? 'YouTube' : 'Bilibili';

  // 判斷是否要跳過快取下載：
  // 1. durationSec 不存在或為 0 (通常是直播或未知長度)
  // 2. durationSec 超過 420 秒
  const tooLongToCache = !item.durationSec || item.durationSec > MAX_CACHE_DURATION_SEC;

  try {
    // ── 1. 永遠先檢查快取 (即使超過 7 分鐘，若以前載過還是直接用) ──
    const cachedPath = cache.getCachedPath(item.url, item.title);

    if (cachedPath) {
      if (!silent) console.log(`✅ [Cache] 快取命中，直接播放: ${path.basename(cachedPath)}`);
      _playFromFile(guildId, item, player, cachedPath, silent);
      return;
    }

    // ── 2. 快取未命中，一律啟動即時串流播放 ──
    if (tooLongToCache) {
      const reason = !item.durationSec ? '未知長度/直播' : `長度超過 7 分鐘`;
      if (!silent) console.log(`⏭️ [${platform}] ${reason}，跳過背景下載，僅串流: ${item.title}`);
    } else {
      if (!silent) console.log(`🔄 [${platform}] 快取未命中，啟動即時串流播放: ${item.title}`);
    }

    _fallbackStream(guildId, item, player, retryCount, silent);

    // ── 3. 背景下載快取（僅限 ≤ 7 分鐘且非直播）──
    if (!tooLongToCache) {
      if (!downloadingUrls.has(item.url)) {
        downloadingUrls.add(item.url);

        if (!silent) console.log(`⬇️ [${platform}] 背景開始下載快取...`);

        const dlArgs = antiBot.isYouTubeUrl(item.url)
          ? antiBot.buildYouTubeArgs(
              item.url,
              antiBot.YT_CLIENT_STRATEGIES.find(s => s.name === 'default') || antiBot.YT_CLIENT_STRATEGIES[0],
              false,
            )
          : antiBot.buildBilibiliArgs(item.url, false);

        let lastProgress = 0;

        cache.downloadAndCache(
          item.url,
          item.title,
          dlArgs,
          (progress) => {
            if (progress - lastProgress >= 20) {
              lastProgress = progress;
              if (!silent) console.log(`⬇️ [${platform}] 背景下載進度: ${progress.toFixed(1)}%`);
            }
          },
        )
        .then((filePath) => {
          if (!silent) console.log(`✅ [Cache] 背景下載完成，已儲存至: ${path.basename(filePath)}`);
        })
        .catch((err) => {
          if (!silent) console.error(`⚠️ [Cache] 背景下載失敗: ${err.message}`);
        })
        .finally(() => {
          downloadingUrls.delete(item.url);
        });

      } else {
        if (!silent) console.log(`⏳ 此 URL 已經在背景下載中，跳過重複下載任務。`);
      }
    }

  } catch (err) {
    if (!silent) console.error(`❌ [${platform}] 播放前發生錯誤: ${err.message}`);
    _handleStreamError(guildId, item, player, retryCount, err.message, silent);
  }
}

function _playFromFile(guildId, item, player, filePath, silent) {
  try {
    const resource = createAudioResource(filePath, {
      inputType:    StreamType.Arbitrary,
      inlineVolume: false,
    });

    player.play(resource);
    errorCounts.set(guildId, 0);
    if (!silent) console.log(`🎵 [OnlineMusic] 本地播放: ${path.basename(filePath)}`);
  } catch (err) {
    if (!silent) console.error('❌ [OnlineMusic] 本地播放失敗:', err);
    _handleStreamError(guildId, item, player, 0, err.message, silent);
  }
}

function _fallbackStream(guildId, item, player, retryCount, silent) {
  const isYT     = antiBot.isYouTubeUrl(item.url);
  const platform = isYT ? 'YouTube' : 'Bilibili';

  if (!silent) console.log(`🔄 [${platform}] 切換串流模式: ${item.title}`);

  let streamArgs;

  if (isYT) {
    const { strategy } = antiBot.getYtClientStrategy(guildId);
    if (!silent) console.log(`🎯 [YouTube] 使用 client: ${strategy.name} (${strategy.desc})`);
    streamArgs = antiBot.buildYouTubeArgs(item.url, strategy, true);
  } else {
    streamArgs = antiBot.buildBilibiliArgs(item.url, true);
  }

  const ytdlp = spawn(ytdlpPath, streamArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  activeProcesses.set(guildId, ytdlp);

  let hasError = false, errorOutput = '', dataReceived = false;

  ytdlp.stdout.on('data', () => { dataReceived = true; });
  ytdlp.stderr.on('data', data => {
    const err = data.toString();
    if (!err.includes('Deleting original file')) {
      if (!silent) console.error(`[${platform}] yt-dlp stderr:`, err);
      errorOutput += err;
      if (!err.includes('unable to write data') &&
          !err.includes('Broken pipe') &&
          !err.includes('Invalid argument')) {
        hasError = true;
      }
    }
  });

  ytdlp.on('error', err => { hasError = true; errorOutput = err.message; });

  ytdlp.on('close', (code, signal) => {
    if (!silent) console.log(`[${platform}] yt-dlp 進程結束 (code: ${code}, signal: ${signal})`);

    if (code !== 0 && !dataReceived && hasError) {
      if (isYT) {
        const classified = antiBot.classifyYouTubeError(errorOutput);
        if (!silent) console.warn(`⚠️ [YouTube] ${classified.msg}`);

        if (classified.rotate && antiBot.rotateYtClient(guildId)) {
          if (!silent) console.log('🔄 [YouTube] 使用備用 client 重試...');
          setTimeout(() => _fallbackStream(guildId, item, player, retryCount, silent), 1000);
          return;
        }
      }
      _handleStreamError(guildId, item, player, retryCount, errorOutput, silent);
    }
  });

  const resource = createAudioResource(ytdlp.stdout, {
    inputType:    StreamType.Arbitrary,
    inlineVolume: false,
  });

  resource.playStream?.on('error', err => {
    if (!silent) console.error('音頻流錯誤:', err);
  });

  player.play(resource);
  errorCounts.set(guildId, 0);
}

function _handleStreamError(guildId, item, player, retryCount, errorMessage, silent = false) {
  const currentErrors = (errorCounts.get(guildId) || 0) + 1;
  errorCounts.set(guildId, currentErrors);

  if (!silent) {
    console.error(`❌ 串流錯誤 (${currentErrors}/${MAX_CONSECUTIVE_ERRORS}): ${errorMessage}`);
  }

  if (currentErrors >= MAX_CONSECUTIVE_ERRORS) {
    if (!silent) console.error('❌ 連續錯誤過多，停止播放');
    player.emit('error', new Error(`連續發生 ${currentErrors} 次錯誤，已停止播放`));
    stopAll(guildId);
    return;
  }

  if (retryCount < MAX_RETRIES) {
    if (!silent) console.log(`⏳ ${RETRY_DELAY / 1000} 秒後重試 (${retryCount + 1}/${MAX_RETRIES})...`);
    setTimeout(
      () => playStream(guildId, item, player, { retryCount: retryCount + 1, silent }),
      RETRY_DELAY,
    );
  } else {
    if (!silent) console.error('❌ 重試次數已用盡，通知上層跳過');
    player.emit('error', new Error(`播放失敗（已重試 ${MAX_RETRIES} 次）：${errorMessage.substring(0, 100)}`));
  }
}

// ★ 新增：清理指定 guild 的錯誤計數，供 stopAll 呼叫，避免長期累積
function clearErrorCount(guildId) {
  errorCounts.delete(guildId);
}

async function setupOnlineMusicEngine() {
  antiBot.initCookies();
  cache.ensureCacheDir();

  const [ytdlpOk, ffmpegOk] = await Promise.all([checkYtDlp(), checkFFmpeg()]);

  if (ytdlpOk && ffmpegOk) {
    const { bilibili, youtube, poToken } = antiBot.getCookieStatus();
    console.log('✅ [OnlineMusic] 引擎已就緒');
    console.log(bilibili ? '✅ Bilibili Cookies 已配置'  : '⚠️ 未配置 Bilibili Cookies');
    console.log(youtube  ? '✅ YouTube Cookies 已配置'   : '⚠️ 未配置 YouTube Cookies（使用無帳號模式）');
    console.log(poToken  ? '✅ YouTube PO Token 已配置'  : '⚠️ 未配置 YouTube PO Token（mweb client 將跳過）');
    console.log(`📂 [Cache] 快取資料夾: ${cache.CACHE_DIR} (上限 ${cache.MAX_CACHE_SIZE_MB} MB)`);
  } else {
    console.warn('⚠️ [OnlineMusic] 引擎可能無法正常運作');
  }

  // ── 引擎注入：補上缺漏的 clearErrorCount 與 resetYtClient，
  //   避免 playback.js 透過 _engines.bilibili 呼叫時永遠是 undefined ──
  registerEngine('bilibili', {
    playStream,
    getInfo,
    searchMulti,
    clearErrorCount,                          // ★ 補上
    resetYtClient: antiBot.resetYtClient,      // ★ 補上（需確認 musicAntiBot.js 是否已定義此函式）
  });
}

// ════════════════════════════════════════════════════════
//  防殭屍進程保護 (Zombie Process Protection)
// ════════════════════════════════════════════════════════
process.on('exit', () => {
  for (const [guildId, childProcess] of activeProcesses.entries()) {
    if (!childProcess.killed) {
      try {
        childProcess.kill('SIGKILL');
      } catch (e) {}
    }
  }
});

process.on('uncaughtException', (err) => {
  console.error('❌ [OnlineMusic] 發生未捕捉的錯誤:', err);
});

// ════════════════════════════════════════════════════════
//  匯出模組
// ════════════════════════════════════════════════════════
module.exports = {
  setupOnlineMusicEngine,
  cleanupProcess,
  clearErrorCount,
  resetYtClient: antiBot.resetYtClient,   // ★ 新增（同上，需確認 musicAntiBot.js 是否已定義此函式）
  getInfo,
  searchMulti,
  getCachedPath: cache.getCachedPath,
  downloadAndCache: (url, title, onProgress) => {
    const args = antiBot.isYouTubeUrl(url)
      ? antiBot.buildYouTubeArgs(url, antiBot.YT_CLIENT_STRATEGIES[0], false)
      : antiBot.buildBilibiliArgs(url, false);
    return cache.downloadAndCache(url, title, args, onProgress);
  },
};