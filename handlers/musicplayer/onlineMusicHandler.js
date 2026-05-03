// handlers/onlineMusicHandler.js
// 職責：引擎初始化、playStream、getInfo、快取流程、串流 fallback、重試邏輯
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

    ytdlp.stdout.on('data', c => { data      += c.toString(); });
    ytdlp.stderr.on('data', c => { errorData += c.toString(); });

    ytdlp.on('close', code => {
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
          title    : info.title    || '未知標題',
          author   : info.uploader || info.channel || info.creator || '未知作者',
          duration : formatDuration(info.duration),
          thumbnail: info.thumbnail || null,
        });
      } catch { reject(new Error('解析影片資訊失敗')); }
    });

    ytdlp.on('error', err => reject(new Error('執行 yt-dlp 失敗: ' + err.message)));
  });
}

// ════════════════════════════════════════════════════════
//  playStream（由 unifiedQueue 呼叫）
//  流程：
//    1. 檢查快取 → 有則直接播放本地檔案
//    2. 沒有快取 → 下載到 music/cache/ → 播放
//    3. 下載失敗 → fallback 回即時串流模式
// ════════════════════════════════════════════════════════
async function playStream(guildId, item, player, { retryCount = 0, silent = false } = {}) {
  cleanupProcess(guildId);

  const platform = antiBot.isYouTubeUrl(item.url) ? 'YouTube' : 'Bilibili';

  try {
    // ── Step 1：檢查快取 ──────────────────────────────
    const cachedPath = cache.getCachedPath(item.url, item.title);

    if (cachedPath) {
      if (!silent) console.log(`✅ [Cache] 快取命中，直接播放: ${path.basename(cachedPath)}`);
      _playFromFile(guildId, item, player, cachedPath, silent);
      return;
    }

    // ── Step 2：需要下載 ──────────────────────────────
    if (!silent) console.log(`⬇️ [${platform}] 快取未命中，開始下載: ${item.title}`);

    // 防止重複下載同一 URL
    if (downloadingUrls.has(item.url)) {
      if (!silent) console.log('⏳ 此 URL 正在下載中，等待完成...');
      await _waitForDownload(item.url, 300);
      const pathAfterWait = cache.getCachedPath(item.url, item.title);
      if (pathAfterWait) {
        _playFromFile(guildId, item, player, pathAfterWait, silent);
      } else {
        _fallbackStream(guildId, item, player, retryCount, silent);
      }
      return;
    }

    downloadingUrls.add(item.url);

    // 組合下載參數
    const dlArgs = antiBot.isYouTubeUrl(item.url)
      ? antiBot.buildYouTubeArgs(
          item.url,
          antiBot.YT_CLIENT_STRATEGIES.find(s => s.name === 'tv') || antiBot.YT_CLIENT_STRATEGIES[0],
          false,  // streamMode = false（下載模式）
        )
      : antiBot.buildBilibiliArgs(item.url, false);

    let lastProgress = 0;
    const filePath = await cache.downloadAndCache(
      item.url,
      item.title,
      dlArgs,
      (progress) => {
        if (progress - lastProgress >= 10) {
          lastProgress = progress;
          if (!silent) console.log(`⬇️ [${platform}] 下載進度: ${progress.toFixed(1)}%`);
        }
      },
    );

    downloadingUrls.delete(item.url);
    _playFromFile(guildId, item, player, filePath, silent);

  } catch (err) {
    downloadingUrls.delete(item.url);
    if (!silent) console.error(`❌ [${platform}] 下載失敗，切換串流模式: ${err.message}`);
    _fallbackStream(guildId, item, player, retryCount, silent);
  }
}

// ════════════════════════════════════════════════════════
//  從本地檔案播放
// ════════════════════════════════════════════════════════
function _playFromFile(guildId, item, player, filePath, silent) {
  try {
    const resource = createAudioResource(filePath, {
      inputType:    StreamType.Arbitrary,
      inlineVolume: true,
    });
    resource.volume.setVolume(0.5);
    player.play(resource);
    errorCounts.set(guildId, 0);
    if (!silent) console.log(`🎵 [OnlineMusic] 本地播放: ${path.basename(filePath)}`);
  } catch (err) {
    if (!silent) console.error('❌ [OnlineMusic] 本地播放失敗:', err);
    _handleStreamError(guildId, item, player, 0, err.message, silent);
  }
}

// ════════════════════════════════════════════════════════
//  Fallback：回退到即時串流模式（YouTube + Bilibili 分支）
// ════════════════════════════════════════════════════════
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
        // YouTube：先嘗試 rotate client，再走重試邏輯
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
    inlineVolume: true,
  });
  resource.volume.setVolume(0.5);
  resource.playStream?.on('error', err => {
    if (!silent) console.error('音頻流錯誤:', err);
  });

  player.play(resource);
  errorCounts.set(guildId, 0);
}

// ════════════════════════════════════════════════════════
//  等待同一 URL 的下載完成（輪詢）
// ════════════════════════════════════════════════════════
function _waitForDownload(url, maxAttempts = 300) {
  return new Promise((resolve) => {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      if (!downloadingUrls.has(url) || attempts >= maxAttempts) {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
  });
}

// ════════════════════════════════════════════════════════
//  重試 / 跳過邏輯
// ════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════
//  setupOnlineMusicEngine（原 setupBilibiliEngine）
// ════════════════════════════════════════════════════════
async function setupOnlineMusicEngine() {
  antiBot.initCookies();
  cache.ensureCacheDir();

  const [ytdlpOk, ffmpegOk] = await Promise.all([checkYtDlp(), checkFFmpeg()]);

  if (ytdlpOk && ffmpegOk) {
    const { bilibili, youtube, poToken } = antiBot.getCookieStatus();
    console.log('✅ [OnlineMusic] 引擎已就緒');
    console.log(bilibili ? '✅ Bilibili Cookies 已配置'  : '⚠️ 未配置 Bilibili Cookies');
    console.log(youtube  ? '✅ YouTube Cookies 已配置'   : '⚠️ 未配置 YouTube Cookies（使用 tv client 無帳號模式）');
    console.log(poToken  ? '✅ YouTube PO Token 已配置'  : '⚠️ 未配置 YouTube PO Token（mweb client 將跳過）');
    console.log(`📁 [Cache] 快取資料夾: ${cache.CACHE_DIR} (上限 ${cache.MAX_CACHE_SIZE_MB} MB)`);
  } else {
    console.warn('⚠️ [OnlineMusic] 引擎可能無法正常運作');
  }

  // 注入引擎到 unifiedQueue
  registerEngine('bilibili', { playStream, getInfo });
}

module.exports = {
  setupOnlineMusicEngine,
  cleanupProcess,
  // 供外部直接使用（如 localMusicHandler 共用快取）
  getCachedPath: cache.getCachedPath,
  downloadAndCache: (url, title, onProgress) => {
    const args = antiBot.isYouTubeUrl(url)
      ? antiBot.buildYouTubeArgs(url, antiBot.YT_CLIENT_STRATEGIES[0], false)
      : antiBot.buildBilibiliArgs(url, false);
    return cache.downloadAndCache(url, title, args, onProgress);
  },
};