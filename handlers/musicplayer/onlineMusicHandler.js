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
const { nowPlaying } = require('./unifiedQueue/state');

const cache   = require('./musicCache');
const antiBot = require('./musicAntiBot');
const logger  = require('../../utils/logger');
const bootSummary = require('../../utils/bootSummary');

const execAsync = promisify(exec);
const ytdlpPath = 'yt-dlp';

// ── 重試配置 ──────────────────────────────────────────────
const MAX_RETRIES            = 3;
const RETRY_DELAY            = 3000;
const MAX_CONSECUTIVE_ERRORS = 5;

// ── 超過此秒數則只串流，不下載快取 ───────────────────────
const MAX_CACHE_DURATION_SEC = 7 * 60; // 420 秒

// ── 搜尋逾時保護 ─────────────────────────────────────────
const SEARCH_TIMEOUT_MS_YT   = 15_000;
const SEARCH_TIMEOUT_MS_BILI = 25_000;

// ── getInfo 逾時保護 ──────────────────────────────────────
const GET_INFO_TIMEOUT_MS = 15_000;

// ── 進程 & 錯誤計數 ───────────────────────────────────────
const activeProcesses = new Map(); // guildId -> ChildProcess
const errorCounts     = new Map(); // guildId -> number

// ── 下載鎖（防止同一首同時下載兩次）──────────────────────
// 🐛 [暫存檔互寫] 以快取檔名當 key，不用原始網址：同一支影片的不同網址（&t=30、youtu.be…）
//    暫存檔與輸出檔是同一個，以前會兩個 yt-dlp 同時寫同一個 .tmp／.part
const downloadingUrls = new Set();
const _dlKey = (item) => cache.getCacheFilename(item.url, item.title);

// ── 預先下載（佇列中還沒輪到的歌）────────────────────────
// 一次只跑一個，避免跟正在串流的 yt-dlp 搶頻寬、同時打太多請求被判定成機器人
const PREFETCH_CONCURRENCY = 1;
const prefetchJobs   = [];        // 排隊中的 { item, isWanted }
const prefetchActive = new Set(); // 執行中（查快取／下載中）的 _dlKey
let prefetchRunning  = 0;

// ════════════════════════════════════════════════════════
//  環境檢查
// ════════════════════════════════════════════════════════
async function checkYtDlp() {
  try {
    const { stdout } = await execAsync(`${ytdlpPath} --version`);
    logger.debug('OnlineMusic', `yt-dlp 版本: ${stdout.trim()}`);
    return true;
  } catch {
    logger.error('OnlineMusic', 'yt-dlp 未安裝');
    return false;
  }
}

async function checkFFmpeg() {
  for (const p of ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    try { await execAsync(`${p} -version`); logger.debug('OnlineMusic', `FFmpeg: ${p}`); return true; }
    catch {}
  }
  logger.error('OnlineMusic', 'FFmpeg 未找到');
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

// 🐛 [過期重試] 串流失敗時佇列可能已經換到下一首（新的 player）或被停止，
//    舊 player 的重試／換 client 若繼續跑，會殺掉正在播的歌的 yt-dlp、或對舊 player 發 'error' 害佇列跳歌
function _isCurrentPlayer(guildId, player) {
  return nowPlaying.get(guildId)?.player === player;
}

function cleanupProcess(guildId) {
  const old = activeProcesses.get(guildId);
  if (old && !old.killed) {
    logger.info('OnlineMusic', '🧹 清理舊的 yt-dlp 進程');
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
// signal（選填）：與播放清單偵測並行時，使用者選了「全部加入／取消」就用它提前終止 yt-dlp
async function getInfo(url, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('已取消取得影片資訊'));
    if (!antiBot.isSupportedMediaUrl(url)) return reject(new Error('只支援 YouTube 與 Bilibili 的網址'));

    const args  = antiBot.buildInfoArgs(url);
    const ytdlp = spawn(ytdlpPath, args);
    let data = '', errorData = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      logger.warn('getInfo', `逾時（超過 ${GET_INFO_TIMEOUT_MS / 1000}s），強制終止: ${url}`);
      try { ytdlp.kill('SIGKILL'); } catch {}
      reject(new Error('取得影片資訊逾時，請確認網址是否正確或稍後再試'));
    }, GET_INFO_TIMEOUT_MS);

    signal?.addEventListener('abort', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ytdlp.kill('SIGKILL'); } catch {}
      reject(new Error('已取消取得影片資訊'));
    }, { once: true });

    ytdlp.stdout.on('data', c => { data      += c.toString(); });
    ytdlp.stderr.on('data', c => { errorData += c.toString(); });

    ytdlp.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0) {
        logger.error('OnlineMusic', 'yt-dlp 錯誤輸出:', errorData);
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
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error('執行 yt-dlp 失敗: ' + err.message));
    });
  });
}

// ════════════════════════════════════════════════════════
//  checkPlaylist（偵測網址是否為播放清單）
//  失敗 / 逾時皆安全降級為「非播放清單」，絕不阻斷原有單曲流程
// ════════════════════════════════════════════════════════
async function checkPlaylist(url) {
  return new Promise((resolve) => {
    const fallback = () => resolve({ isPlaylist: false, entries: [], title: null, count: 1 });
    if (!antiBot.isSupportedMediaUrl(url)) return fallback();

    const args  = antiBot.buildPlaylistCheckArgs(url);
    const ytdlp = spawn(ytdlpPath, args);
    let data = '', errorData = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      logger.warn('checkPlaylist', `逾時，視為非播放清單: ${url}`);
      try { ytdlp.kill('SIGKILL'); } catch {}
      fallback();
    }, GET_INFO_TIMEOUT_MS);

    ytdlp.stdout.on('data', c => { data      += c.toString(); });
    ytdlp.stderr.on('data', c => { errorData += c.toString(); });

    ytdlp.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0 || !data.trim()) {
        logger.warn('checkPlaylist', '偵測失敗，視為非播放清單:', errorData.slice(-150));
        return fallback();
      }

      try {
        const json    = JSON.parse(data);
        const entries = Array.isArray(json.entries) ? json.entries : null;

        if (entries && entries.length > 1) {
          resolve({
            isPlaylist : true,
            entries,
            title      : json.title || '未知播放清單',
            count      : entries.length,
          });
        } else {
          fallback();
        }
      } catch {
        fallback();
      }
    });

    ytdlp.on('error', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      fallback();
    });
  });
}

// ════════════════════════════════════════════════════════
//  _searchOnePlatform — 搜尋單一平台（內部工具，不對外匯出）
// ════════════════════════════════════════════════════════
// signal（選填）：中止時立即 kill yt-dlp 並回傳空陣列
function _searchOnePlatform(searchPrefix, keyword, limit, fast = false, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve([]);

    const query = `${searchPrefix}${limit}:${keyword}`;
    const isYT  = searchPrefix === 'ytsearch';

    const args = [
      '--dump-json',
      '--no-warnings',
      '--socket-timeout', '10',
    ];

    if (isYT) {
      args.push('--flat-playlist');
      args.push(...antiBot.buildYouTubeSearchArgs()); // ★ 修正：補上防爬蟲參數
    } else {
      if (fast) args.push('--flat-playlist'); // ★ 修正：僅即時搜尋時降級換速度
      args.push(...antiBot.buildBilibiliSearchArgs());
    }

    args.push(query); // query（搜尋字串）放最後，與其他 build*Args() 慣例一致

    const timeoutMs = isYT ? SEARCH_TIMEOUT_MS_YT : SEARCH_TIMEOUT_MS_BILI;
    const ytdlp = spawn(ytdlpPath, args, { windowsHide: true });
    let data = '', errorData = '';
    let finished = false;

    // ── 逾時保護：避免 yt-dlp 卡住讓整個 searchMulti 永久等待 ──
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      logger.warn('Search', `${searchPrefix} 搜尋逾時（超過 ${timeoutMs / 1000}s），強制終止`);
      try { ytdlp.kill('SIGKILL'); } catch {}
      resolve([]);
    }, timeoutMs);

    signal?.addEventListener('abort', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ytdlp.kill('SIGKILL'); } catch {}
      resolve([]);
    }, { once: true });

    ytdlp.stdout.on('data', c => { data      += c.toString(); });
    ytdlp.stderr.on('data', c => { errorData += c.toString(); });

    ytdlp.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0 || !data.trim()) {
        // ★ 修正：改用既有的錯誤分類函式，log 會顯示具體原因，不再被完全吞掉
        const classified = isYT
          ? antiBot.classifyYouTubeError(errorData)
          : antiBot.classifyBilibiliError(errorData);
        logger.warn('Search', `${searchPrefix} 搜尋失敗 (code=${code}): ${classified.msg}`);
        resolve([]); // 失敗回空陣列，不讓另一平台的搜尋結果被拖累
        return;
      }

      const lines = data.trim().split('\n').filter(Boolean);
      const results = [];

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
            title    : info.title    || '未知標題',
            author   : info.uploader || info.channel || info.creator || '未知作者',
            duration : formatDuration(info.duration),
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
      logger.warn('Search', `${searchPrefix} 執行 yt-dlp 失敗: ${err.message}`);
      resolve([]);
    });
  });
}

// ════════════════════════════════════════════════════════
//  searchMulti — 同時搜尋 YouTube + Bilibili
// ════════════════════════════════════════════════════════
async function searchMulti(keyword, limit = 5, fast = false, platforms = ['youtube', 'bilibili'], { signal } = {}) {
  const tasks = [
    platforms.includes('youtube')
      ? _searchOnePlatform('ytsearch', keyword, limit, fast, signal)
      : Promise.resolve([]),
    platforms.includes('bilibili')
      ? _searchOnePlatform('bilisearch', keyword, limit, fast, signal)
      : Promise.resolve([]),
  ];
  const [ytResults, biliResults] = await Promise.all(tasks);
  return [...ytResults, ...biliResults];
}

// ════════════════════════════════════════════════════════
//  playStream（由 unifiedQueue 呼叫）
// ════════════════════════════════════════════════════════
async function playStream(guildId, item, player, { retryCount = 0, silent = false } = {}) {
  if (!_isCurrentPlayer(guildId, player)) return; // 重試排定後已換歌／停止
  cleanupProcess(guildId);

  // 播放清單條目、網頁批量點歌、重啟恢復的佇列都不經過 getInfo，這裡再擋一次
  if (!antiBot.isSupportedMediaUrl(item.url)) {
    logger.warn('OnlineMusic', `略過不支援的網址: ${item.url}`);
    player.emit('error', new Error('只支援 YouTube 與 Bilibili 的網址，已跳過'));
    return;
  }

  const platform = antiBot.isYouTubeUrl(item.url) ? 'YouTube' : 'Bilibili';

  const tooLongToCache = !_isCacheable(item);

  try {
    const cachedPath = await cache.getCachedPath(item.url, item.title);
    if (!_isCurrentPlayer(guildId, player)) return; // 查快取期間已被跳過

    if (cachedPath) {
      if (!silent) logger.debug('Cache', `✅ 快取命中，直接播放: ${path.basename(cachedPath)}`);
      _playFromFile(guildId, item, player, cachedPath, silent);
      return;
    }

    if (tooLongToCache) {
      const reason = !item.durationSec ? '未知長度/直播' : `長度超過 7 分鐘`;
      if (!silent) logger.info(platform, `⏭️ ${reason}，跳過背景下載，僅串流: ${item.title}`);
    } else {
      if (!silent) logger.info(platform, `🔄 快取未命中，啟動即時串流播放: ${item.title}`);
    }

    _fallbackStream(guildId, item, player, retryCount, silent);

    if (!tooLongToCache) {
      if (!downloadingUrls.has(_dlKey(item))) {
        if (!silent) logger.info(platform, `⬇️ 背景開始下載快取...`);
        _downloadToCache(item, { silent });
      } else {
        // 可能是預先下載還沒趕上：這次先串流，下載完成後下次就會命中快取
        if (!silent) logger.info('OnlineMusic', `⏳ 此 URL 已經在背景下載中，跳過重複下載任務。`);
      }
    }

  } catch (err) {
    logger.error(platform, `播放前發生錯誤: ${err.message}`);
    _handleStreamError(guildId, item, player, retryCount, err.message, silent);
  }
}

// 太長、未知長度（直播）的歌只串流，不下載快取
function _isCacheable(item) {
  return !!item.durationSec && item.durationSec <= MAX_CACHE_DURATION_SEC;
}

// 下載＋響度正規化成快取檔，完成後上傳共用音樂庫；playStream 背景下載與預先下載共用。
// 呼叫端須先確認 downloadingUrls 沒有這首（_dlKey）。失敗只記 log，回傳 null。
function _downloadToCache(item, { silent = false, label = '背景' } = {}) {
  const key = _dlKey(item);
  downloadingUrls.add(key);
  const platform = antiBot.isYouTubeUrl(item.url) ? 'YouTube' : 'Bilibili';

  const dlArgs = antiBot.isYouTubeUrl(item.url)
    ? antiBot.buildYouTubeArgs(
        item.url,
        antiBot.YT_CLIENT_STRATEGIES.find(s => s.name === 'default') || antiBot.YT_CLIENT_STRATEGIES[0],
        false,
      )
    : antiBot.buildBilibiliArgs(item.url, false);

  let lastProgress = 0;

  return cache.downloadAndCache(
    item.url,
    item.title,
    dlArgs,
    (progress) => {
      if (progress - lastProgress >= 20) {
        lastProgress = progress;
        if (!silent) logger.debug(platform, `⬇️ ${label}下載進度: ${progress.toFixed(1)}%`);
      }
    },
  )
  .then((filePath) => {
    // downloadAndCache 完成時已經做完響度正規化（失敗則為一般轉檔），檔案可直接使用
    if (!silent) logger.success('Cache', `${label}下載完成，已儲存至: ${path.basename(filePath)}`);

    // 同步上傳到共用音樂庫，讓其他 Bot 也能直接取用，不必重新下載一次。
    // 未設定 MUSIC_LIB_URL 時 pushToSharedLibrary() 會直接是 no-op。
    cache.pushToSharedLibrary(filePath, path.basename(filePath));
    return filePath;
  })
  .catch((err) => {
    logger.error('Cache', `${label}下載失敗: ${err.message}`);
    return null;
  })
  .finally(() => {
    downloadingUrls.delete(key);
  });
}

// ════════════════════════════════════════════════════════
//  prefetch（由 unifiedQueue 在點歌入列、換歌時呼叫）
//  正在播放時先把佇列裡的線上歌曲下載＋正規化成快取檔；
//  趕在輪到它之前完成，playStream 就會命中快取直接播本地檔，沒趕上則照常串流。
//  isWanted()：開始執行前再確認一次這首還在佇列前面（可能已被移除、清空或停止播放）
// ════════════════════════════════════════════════════════
function prefetch(item, { isWanted = () => true } = {}) {
  if (!item?.url || !antiBot.isSupportedMediaUrl(item.url) || !_isCacheable(item)) return false;
  const key = _dlKey(item);
  if (downloadingUrls.has(key) || prefetchActive.has(key)) return false;

  // 同一首已在排隊（例如兩個伺服器都點了）：任一邊還需要就下載
  const pending = prefetchJobs.find(j => _dlKey(j.item) === key);
  if (pending) {
    const prev = pending.isWanted;
    pending.isWanted = () => prev() || isWanted();
    return false;
  }

  prefetchJobs.push({ item, isWanted });
  _pumpPrefetch();
  return true;
}

function _pumpPrefetch() {
  while (prefetchRunning < PREFETCH_CONCURRENCY && prefetchJobs.length > 0) {
    const job = prefetchJobs.shift();
    prefetchRunning++;
    prefetchActive.add(_dlKey(job.item));
    _runPrefetch(job)
      .catch(err => logger.warn('Cache', `預先下載失敗: ${err.message}`))
      .finally(() => {
        prefetchActive.delete(_dlKey(job.item));
        prefetchRunning--;
        _pumpPrefetch();
      });
  }
}

async function _runPrefetch({ item, isWanted }) {
  if (!isWanted() || downloadingUrls.has(_dlKey(item))) return;

  // 本地已有，或共用音樂庫已有（getCachedPath 會順便下載成本地快取）就不用再抓
  if (await cache.getCachedPath(item.url, item.title)) return;

  // 查共用音樂庫期間可能已經輪到它播放、由 playStream 開始下載
  if (!isWanted() || downloadingUrls.has(_dlKey(item))) return;

  const platform = antiBot.isYouTubeUrl(item.url) ? 'YouTube' : 'Bilibili';
  logger.info(platform, `⏩ 預先下載佇列中的歌曲: ${item.title}`);
  await _downloadToCache(item, { label: '預先' });
}

function _playFromFile(guildId, item, player, filePath, silent) {
  try {
    const resource = createAudioResource(filePath, {
      inputType:    StreamType.Arbitrary,
      inlineVolume: false,
    });

    player.play(resource);
    errorCounts.set(guildId, 0);
    if (!silent) logger.info('OnlineMusic', `🎵 本地播放: ${path.basename(filePath)}`);
  } catch (err) {
    logger.error('OnlineMusic', '本地播放失敗:', err);
    _handleStreamError(guildId, item, player, 0, err.message, silent);
  }
}

function _fallbackStream(guildId, item, player, retryCount, silent) {
  const isYT     = antiBot.isYouTubeUrl(item.url);
  const platform = isYT ? 'YouTube' : 'Bilibili';

  if (!silent) logger.debug(platform, `🔄 切換串流模式: ${item.title}`);

  let streamArgs;

  if (isYT) {
    const { strategy } = antiBot.getYtClientStrategy(guildId);
    if (!silent) logger.debug('YouTube', `🎯 使用 client: ${strategy.name} (${strategy.desc})`);
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

  // 🐛 [熔斷失效] 連續錯誤計數要等真的收到音訊才歸零；以前一 spawn 就歸零，每次重試都從 0 開始，
  //    MAX_CONSECUTIVE_ERRORS 永遠不會觸發
  ytdlp.stdout.on('data', () => {
    if (!dataReceived && _isCurrentPlayer(guildId, player)) errorCounts.set(guildId, 0);
    dataReceived = true;
  });
  ytdlp.stderr.on('data', data => {
    for (const line of data.toString().split(/\r?\n/)) {
      if (!line.trim() || line.includes('Deleting original file')) continue;
      // 警告仍累積到 errorOutput，供 classifyYouTubeError 判斷，但不算錯誤
      errorOutput += line + '\n';
      if (/^(WARNING:|Deprecated Feature:)/.test(line)) {
        if (!silent) logger.warn(platform, `yt-dlp: ${line}`);
        continue;
      }
      const benign = line.includes('unable to write data') ||
                     line.includes('Broken pipe') ||
                     line.includes('Invalid argument');
      // silent（循環重播）只隱藏例行訊息：跳過歌曲造成的 Broken pipe 這類良性輸出；真正的錯誤一律記錄
      if (!benign || !silent) logger.error(platform, `yt-dlp stderr:`, line);
      if (!benign) hasError = true;
    }
  });

  ytdlp.on('error', err => { hasError = true; errorOutput = err.message; });

  ytdlp.on('close', (code, signal) => {
    if (!silent) logger.debug(platform, `yt-dlp 進程結束 (code: ${code}, signal: ${signal})`);
    if (activeProcesses.get(guildId) === ytdlp) activeProcesses.delete(guildId);

    if (code !== 0 && !dataReceived && hasError) {
      if (!_isCurrentPlayer(guildId, player)) return; // 佇列已往下走，不再重試這首
      if (isYT) {
        const classified = antiBot.classifyYouTubeError(errorOutput);
        logger.warn('YouTube', `${classified.msg}`);

        if (classified.rotate && antiBot.rotateYtClient(guildId)) {
          if (!silent) logger.info('YouTube', '🔄 使用備用 client 重試...');
          setTimeout(() => {
            if (_isCurrentPlayer(guildId, player)) _fallbackStream(guildId, item, player, retryCount, silent);
          }, 1000);
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
    logger.error('OnlineMusic', '音頻流錯誤:', err);
  });

  player.play(resource);
}

function _handleStreamError(guildId, item, player, retryCount, errorMessage, silent = false) {
  if (!_isCurrentPlayer(guildId, player)) return; // 已換歌／停止：不計錯誤、不重試、不對舊 player 發 'error'
  const currentErrors = (errorCounts.get(guildId) || 0) + 1;
  errorCounts.set(guildId, currentErrors);

  logger.error('OnlineMusic', `串流錯誤 (${currentErrors}/${MAX_CONSECUTIVE_ERRORS}): ${errorMessage}`);

  if (currentErrors >= MAX_CONSECUTIVE_ERRORS) {
    logger.error('OnlineMusic', '連續錯誤過多，停止播放');
    player.emit('error', new Error(`連續發生 ${currentErrors} 次錯誤，已停止播放`));
    stopAll(guildId);
    return;
  }

  if (retryCount < MAX_RETRIES) {
    if (!silent) logger.info('OnlineMusic', `⏳ ${RETRY_DELAY / 1000} 秒後重試 (${retryCount + 1}/${MAX_RETRIES})...`);
    setTimeout(
      () => playStream(guildId, item, player, { retryCount: retryCount + 1, silent }),
      RETRY_DELAY,
    );
  } else {
    logger.error('OnlineMusic', '重試次數已用盡，通知上層跳過');
    player.emit('error', new Error(`播放失敗（已重試 ${MAX_RETRIES} 次）：${errorMessage.substring(0, 100)}`));
  }
}

// 清理指定 guild 的錯誤計數，供 stopAll 呼叫，避免長期累積
function clearErrorCount(guildId) {
  errorCounts.delete(guildId);
}

async function setupOnlineMusicEngine() {
  antiBot.initCookies();
  cache.ensureCacheDir();

  // 清掉重啟前遺留的下載／轉檔暫存檔；剛留下的還沒過期，之後每小時再清一次
  const cleanTemps = () => {
    const n = cache.cleanupStaleTemps();
    if (n) logger.info('Cache', `🧹 已清除 ${n} 個殘留暫存檔`);
  };
  cleanTemps();
  setInterval(cleanTemps, 60 * 60 * 1000).unref();

  const [ytdlpOk, ffmpegOk, potVersion] = await Promise.all([
    checkYtDlp(), checkFFmpeg(), antiBot.checkPotProvider(),
  ]);

  if (ytdlpOk && ffmpegOk) {
    const { bilibili, youtube, poToken } = antiBot.getCookieStatus();
    const cookieBits = [
      `Bilibili ${bilibili ? '✓' : '✗'}`,
      `YouTube ${youtube ? '✓' : '✗（無帳號模式）'}`,
      `PO Token ${potVersion ? `✓（bgutil ${potVersion}）` : poToken ? '✓（手動）' : '✗'}`,
    ].join('、');
    if (!potVersion) logger.warn('OnlineMusic', 'bgutil PO Token 伺服器無回應，YouTube 較容易被判定為機器人');
    bootSummary.report('線上音樂 (YouTube/Bilibili)', 'ok', `yt-dlp + FFmpeg 就緒｜${cookieBits}`);
    logger.debug('OnlineMusic', `快取資料夾: ${cache.CACHE_DIR}（上限 ${cache.MAX_CACHE_SIZE_MB} MB）`);
  } else {
    bootSummary.report('線上音樂 (YouTube/Bilibili)', 'warn', 'yt-dlp 或 FFmpeg 未就緒，功能可能無法正常運作');
  }

  registerEngine('bilibili', {
    playStream,
    getInfo,
    checkPlaylist,
    searchMulti,
    prefetch,
    clearErrorCount,
    resetYtClient: antiBot.resetYtClient,
  });
}

// ════════════════════════════════════════════════════════
//  防殭屍進程保護 (Zombie Process Protection)
// ════════════════════════════════════════════════════════
process.on('exit', () => {
  for (const childProcess of activeProcesses.values()) {
    if (!childProcess.killed) {
      try {
        childProcess.kill('SIGKILL');
      } catch (e) {}
    }
  }
});

// ════════════════════════════════════════════════════════
//  匯出模組
// ════════════════════════════════════════════════════════
module.exports = {
  setupOnlineMusicEngine,
  cleanupProcess,
  clearErrorCount,
  resetYtClient: antiBot.resetYtClient,
  getInfo,
  checkPlaylist,
  searchMulti,
  prefetch,
  getCachedPath: cache.getCachedPath,
  downloadAndCache: (url, title, onProgress) => {
    if (!antiBot.isSupportedMediaUrl(url)) return Promise.reject(new Error('只支援 YouTube 與 Bilibili 的網址'));
    const args = antiBot.isYouTubeUrl(url)
      ? antiBot.buildYouTubeArgs(url, antiBot.YT_CLIENT_STRATEGIES[0], false)
      : antiBot.buildBilibiliArgs(url, false);
    return cache.downloadAndCache(url, title, args, onProgress);
  },
};