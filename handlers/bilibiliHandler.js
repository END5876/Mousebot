// handlers/bilibiliHandler.js（下載快取版）
// 職責：串流播放 + 影片資訊抓取 + 重試機制 + 本地快取下載
// 佇列 / 指令 / 控制面板 → 全部交由 unifiedQueue.js 管理

const {
  createAudioResource,
  StreamType,
} = require('@discordjs/voice');
const { EmbedBuilder } = require('discord.js');
const { spawn, exec }  = require('child_process');
const { promisify }    = require('util');
const fs   = require('fs');
const path = require('path');

const { registerEngine, stopAll } = require('./unifiedQueue');

const execAsync = promisify(exec);

// ── 環境偵測 ─────────────────────────────────────────────
const isHeroku  = process.env.DYNO !== undefined;
const ytdlpPath = 'yt-dlp';

// ── Cookies 配置 ─────────────────────────────────────────
const COOKIES_PATH      = path.join(__dirname, '..', 'cookies.txt');
const TEMP_COOKIES_PATH = '/tmp/bili_cookies.txt';

// ── 快取資料夾（與 localMusicHandler 共用同一個 music/）───
const MUSIC_DIR         = path.join(__dirname, '..', 'music');
const CACHE_DIR         = path.join(MUSIC_DIR, 'cache');  // music/cache/ 子資料夾
const MAX_CACHE_SIZE_MB = parseInt(process.env.MAX_CACHE_SIZE_MB || '2048', 10); // 預設 2GB

const BILIBILI_HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer'        : 'https://www.bilibili.com/',
  'Origin'         : 'https://www.bilibili.com',
  'Accept'         : '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection'     : 'keep-alive',
  'Sec-Fetch-Dest' : 'empty',
  'Sec-Fetch-Mode' : 'cors',
  'Sec-Fetch-Site' : 'same-site',
};

let BILIBILI_COOKIES_FILE = null;

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
//  確保快取資料夾存在
// ════════════════════════════════════════════════════════
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    console.log(`📁 [Bilibili] 建立快取資料夾: ${CACHE_DIR}`);
  }
}

// ════════════════════════════════════════════════════════
//  從 URL + title 產生穩定的快取檔名
//  格式：<清理後的標題> [<影片ID>].mp3
// ════════════════════════════════════════════════════════
function getCacheFilename(url, title) {
  // ── 清理標題，移除不合法的檔名字元 ──────────────────
  const safeTitle = (title || '')
    .replace(/[\\/:*?"<>|]/g, '')  // Windows / Linux 禁用字元
    .replace(/\s+/g, ' ')          // 合併多餘空白
    .trim()
    .slice(0, 80);                 // 限制長度，避免路徑過長

  // ── 取得影片 ID 作為後綴（防止不同影片同名衝突）──────
  const bvMatch = url.match(/BV[\w]+/i);
  const avMatch = url.match(/av(\d+)/i);
  const ytMatch = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);

  const idSuffix = bvMatch ? bvMatch[0]
    : avMatch              ? `av${avMatch[1]}`
    : ytMatch              ? `yt_${ytMatch[1]}`
    : Buffer.from(url).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);

  // ── 組合檔名 ─────────────────────────────────────────
  if (safeTitle) {
    return `${safeTitle} [${idSuffix}].mp3`;
  }

  // fallback：沒有 title 就純用 ID
  return `${idSuffix}.mp3`;
}

// ════════════════════════════════════════════════════════
//  檢查快取是否存在
// ════════════════════════════════════════════════════════
function getCachedPath(url, title) {
  ensureCacheDir();
  const filename = getCacheFilename(url, title);
  const filePath = path.join(CACHE_DIR, filename);
  return fs.existsSync(filePath) ? filePath : null;
}

// ════════════════════════════════════════════════════════
//  快取大小管理：超過上限時刪除最舊的檔案
// ════════════════════════════════════════════════════════
function evictCacheIfNeeded() {
  try {
    const files = fs.readdirSync(CACHE_DIR)
      .map(f => {
        const fp = path.join(CACHE_DIR, f);
        const stat = fs.statSync(fp);
        return { fp, mtime: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => a.mtime - b.mtime); // 最舊排前面

    let totalMB = files.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024;

    while (totalMB > MAX_CACHE_SIZE_MB && files.length > 0) {
      const oldest = files.shift();
      fs.unlinkSync(oldest.fp);
      totalMB -= oldest.size / 1024 / 1024;
      console.log(`🗑️ [Bilibili] 快取已滿，刪除舊檔: ${path.basename(oldest.fp)}`);
    }
  } catch (err) {
    console.error('❌ [Bilibili] 快取清理失敗:', err);
  }
}

// ════════════════════════════════════════════════════════
//  下載並儲存到快取
//  回傳：下載完成的檔案路徑（Promise<string>）
// ════════════════════════════════════════════════════════
function downloadAndCache(url, title, onProgress) {
  return new Promise((resolve, reject) => {
    ensureCacheDir();
    evictCacheIfNeeded();

    const filename = getCacheFilename(url, title);     // 《標題》 [BVxxxxxx].mp3
    const filePath = path.join(CACHE_DIR, filename);   // 最終路徑
    const tmpBase  = path.join(CACHE_DIR, filename.replace(/\.mp3$/, '.tmp')); // 《標題》 [BVxxxxxx].tmp
    const tmpActual = tmpBase + '.mp3';                // yt-dlp 轉檔後實際產生：《標題》 [BVxxxxxx].tmp.mp3

    const args = [
      '-f', 'bestaudio/best',
      '-o', tmpBase,           // ← 傳給 yt-dlp 的是 .tmp（不含 .mp3），轉檔後自動加上 .mp3
      '--no-playlist',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--no-warnings',
    ];

    if (url.includes('bilibili.com')) {
      if (BILIBILI_COOKIES_FILE) args.push('--cookies', BILIBILI_COOKIES_FILE);
      args.push(
        '--user-agent', BILIBILI_HEADERS['User-Agent'],
        '--referer',    BILIBILI_HEADERS['Referer'],
        '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
        '--no-check-certificate',
        '--extractor-args', 'bilibili:getcomments=false',
        '--extractor-args', 'bilibili:getdanmaku=false',
        '--sleep-requests',     isHeroku ? '5' : '2',
        '--sleep-interval',     isHeroku ? '5' : '2',
        '--max-sleep-interval', isHeroku ? '10' : '5',
      );
    } else {
      args.push('--no-check-certificate');
    }

    if (isHeroku) {
      args.push('--socket-timeout', '60', '--retries', '10', '--fragment-retries', '10');
    }

    args.push(url);

    console.log(`⬇️ [Bilibili] 開始下載: ${filename}`);
    const ytdlp = spawn(ytdlpPath, args, { windowsHide: true });

    let errorOutput = '';

    ytdlp.stderr.on('data', data => {
      const line = data.toString();
      errorOutput += line;

      // 解析下載進度（yt-dlp 格式：[download]  xx.x% of ...）
      const progressMatch = line.match(/\[download\]\s+([\d.]+)%/);
      if (progressMatch && onProgress) {
        onProgress(parseFloat(progressMatch[1]));
      }
    });

    ytdlp.on('error', err => reject(new Error('執行 yt-dlp 失敗: ' + err.message)));

    ytdlp.on('close', code => {
      if (code !== 0) {
        // 清理殘留 tmp 檔
        try { if (fs.existsSync(tmpActual)) fs.unlinkSync(tmpActual); } catch {}
        try { if (fs.existsSync(tmpBase))   fs.unlinkSync(tmpBase);   } catch {}
        console.error('❌ [Bilibili] 下載失敗:', errorOutput);
        reject(new Error(`下載失敗 (code: ${code}): ${errorOutput.slice(-200)}`));
        return;
      }

      // yt-dlp 轉 mp3 後實際輸出為 tmpBase + '.mp3'
      // 也保留 tmpBase 本身作為備用（以防某些版本行為不同）
      const actualTmp = fs.existsSync(tmpActual) ? tmpActual
        : fs.existsSync(tmpBase)                 ? tmpBase
        : null;

      if (!actualTmp) {
        reject(new Error('下載完成但找不到輸出檔案'));
        return;
      }

      // 改名為正式快取檔
      try {
        fs.renameSync(actualTmp, filePath);
        const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);
        console.log(`✅ [Bilibili] 下載完成: ${filename} (${sizeMB} MB)`);
        resolve(filePath);
      } catch (err) {
        reject(new Error('重新命名快取檔失敗: ' + err.message));
      }
    });
  });
}

// ════════════════════════════════════════════════════════
//  Cookies 準備
// ════════════════════════════════════════════════════════
function prepareBilibiliCookies() {
  if (fs.existsSync(COOKIES_PATH)) {
    console.log('✅ 找到 cookies.txt 文件');
    return COOKIES_PATH;
  }

  const sessdata   = process.env.BILIBILI_SESSDATA;
  const biliJct    = process.env.BILIBILI_BILI_JCT;
  const dedeUserId = process.env.BILIBILI_DEDEUSERID;

  if (sessdata) {
    console.log('✅ 從環境變數生成 Cookies');
    let content = '# Netscape HTTP Cookie File\n';
    content += `.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\t${sessdata}\n`;
    if (biliJct)    content += `.bilibili.com\tTRUE\t/\tFALSE\t0\tbili_jct\t${biliJct}\n`;
    if (dedeUserId) content += `.bilibili.com\tTRUE\t/\tFALSE\t0\tDedeUserID\t${dedeUserId}\n`;
    try {
      fs.writeFileSync(TEMP_COOKIES_PATH, content);
      console.log('✅ Cookies 已寫入臨時文件:', TEMP_COOKIES_PATH);
      return TEMP_COOKIES_PATH;
    } catch (err) {
      console.error('❌ 無法寫入 Cookies 文件:', err);
      return null;
    }
  }

  console.warn('⚠️ 未找到 Bilibili Cookies，播放可能失敗');
  return null;
}

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
  for (const p of ['ffmpeg', '/app/vendor/ffmpeg/ffmpeg', '/usr/bin/ffmpeg']) {
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

// ── 串流參數（快取未命中時的 fallback 備用）─────────────
function buildYtdlpArgs(url) {
  const args = [
    '-f', 'bestaudio/best', '-o', '-',
    '--no-playlist', '--quiet', '--no-warnings',
    '--extract-audio', '--audio-format', 'opus',
    '--audio-quality', '0', '--buffer-size', '16K',
  ];

  if (url.includes('bilibili.com')) {
    if (BILIBILI_COOKIES_FILE) args.push('--cookies', BILIBILI_COOKIES_FILE);
    args.push(
      '--user-agent', BILIBILI_HEADERS['User-Agent'],
      '--referer',    BILIBILI_HEADERS['Referer'],
      '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
      '--add-header', `Accept:${BILIBILI_HEADERS['Accept']}`,
      '--no-check-certificate',
      '--extractor-args', 'bilibili:getcomments=false',
      '--extractor-args', 'bilibili:getdanmaku=false',
      '--sleep-requests',     isHeroku ? '5' : '2',
      '--sleep-interval',     isHeroku ? '5' : '2',
      '--max-sleep-interval', isHeroku ? '10' : '5',
    );
  } else {
    args.push('--no-check-certificate');
  }

  if (isHeroku) {
    args.push('--prefer-free-formats', '--socket-timeout', '60', '--retries', '10', '--fragment-retries', '10');
  }

  args.push(url);
  return args;
}

// ════════════════════════════════════════════════════════
//  getInfo（取得影片資訊）
// ════════════════════════════════════════════════════════
async function getInfo(url) {
  return new Promise((resolve, reject) => {
    const args = ['--dump-json', '--no-playlist', '--no-warnings', '--skip-download'];

    if (url.includes('bilibili.com')) {
      if (BILIBILI_COOKIES_FILE) args.push('--cookies', BILIBILI_COOKIES_FILE);
      args.push(
        '--user-agent', BILIBILI_HEADERS['User-Agent'],
        '--referer',    BILIBILI_HEADERS['Referer'],
        '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
        '--no-check-certificate',
        '--extractor-args', 'bilibili:getcomments=false',
        '--extractor-args', 'bilibili:getdanmaku=false',
        '--sleep-requests',     isHeroku ? '5' : '2',
        '--sleep-interval',     isHeroku ? '5' : '2',
        '--max-sleep-interval', isHeroku ? '10' : '5',
      );
      if (isHeroku) args.push('--socket-timeout', '60', '--retries', '10');
    }

    args.push(url);
    const ytdlp = spawn(ytdlpPath, args);
    let data = '', errorData = '';

    ytdlp.stdout.on('data', c => { data += c.toString(); });
    ytdlp.stderr.on('data', c => { errorData += c.toString(); });

    ytdlp.on('close', code => {
      if (code !== 0) {
        console.error('yt-dlp 錯誤輸出:', errorData);
        if      (errorData.includes('412')) reject(new Error('Bilibili 反爬蟲限制 (412)'));
        else if (errorData.includes('403')) reject(new Error('影片無法訪問 (403)，可能有地區限制或需要大會員'));
        else if (errorData.includes('404')) reject(new Error('找不到影片 (404)'));
        else reject(new Error(`無法獲取影片資訊 (code: ${code})`));
        return;
      }
      try {
        const info = JSON.parse(data.trim().split('\n').pop());
        resolve({
          url,
          title:     info.title    || '未知標題',
          author:    info.uploader || info.channel || info.creator || '未知作者',
          duration:  formatDuration(info.duration),
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
//    3. 下載失敗 → fallback 回原本的串流模式
// ════════════════════════════════════════════════════════
async function playStream(guildId, item, player, { retryCount = 0, silent = false } = {}) {
  cleanupProcess(guildId);

  try {
    // ── Step 1：檢查快取 ────────────────────────────────
    const cachedPath = getCachedPath(item.url, item.title);

    if (cachedPath) {
      if (!silent) console.log(`✅ [Bilibili] 快取命中，直接播放: ${path.basename(cachedPath)}`);
      _playFromFile(guildId, item, player, cachedPath, silent);
      return;
    }

    // ── Step 2：需要下載 ────────────────────────────────
    if (!silent) console.log(`⬇️ [Bilibili] 快取未命中，開始下載: ${item.title}`);

    // 防止重複下載同一 URL
    if (downloadingUrls.has(item.url)) {
      if (!silent) console.log('⏳ [Bilibili] 此 URL 正在下載中，等待完成...');
      await _waitForDownload(item.url, 300);
      const pathAfterWait = getCachedPath(item.url, item.title);
      if (pathAfterWait) {
        _playFromFile(guildId, item, player, pathAfterWait, silent);
      } else {
        _fallbackStream(guildId, item, player, retryCount, silent);
      }
      return;
    }

    downloadingUrls.add(item.url);

    let lastProgress = 0;
    const filePath = await downloadAndCache(item.url, item.title, (progress) => {
      if (progress - lastProgress >= 10) { // 每 10% log 一次
        lastProgress = progress;
        if (!silent) console.log(`⬇️ [Bilibili] 下載進度: ${progress.toFixed(1)}%`);
      }
    });

    downloadingUrls.delete(item.url);
    _playFromFile(guildId, item, player, filePath, silent);

  } catch (err) {
    downloadingUrls.delete(item.url);
    if (!silent) console.error(`❌ [Bilibili] 下載失敗，切換串流模式: ${err.message}`);

    // ── Step 3：下載失敗 → fallback 串流 ───────────────
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
    if (!silent) console.log(`🎵 [Bilibili] 本地播放: ${path.basename(filePath)}`);
  } catch (err) {
    if (!silent) console.error('❌ [Bilibili] 本地播放失敗:', err);
    _handleStreamError(guildId, item, player, 0, err.message, silent);
  }
}

// ════════════════════════════════════════════════════════
//  Fallback：回退到原本的即時串流模式
// ════════════════════════════════════════════════════════
function _fallbackStream(guildId, item, player, retryCount, silent) {
  if (!silent) console.log(`🔄 [Bilibili] 切換串流模式: ${item.title}`);

  const ytdlp = spawn(ytdlpPath, buildYtdlpArgs(item.url), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  activeProcesses.set(guildId, ytdlp);

  let hasError = false, errorOutput = '', dataReceived = false;

  ytdlp.stdout.on('data', () => { dataReceived = true; });
  ytdlp.stderr.on('data', data => {
    const err = data.toString();
    if (!err.includes('Deleting original file')) {
      if (!silent) console.error('yt-dlp stderr:', err);
      errorOutput += err;
      if (!err.includes('unable to write data') && !err.includes('Broken pipe') && !err.includes('Invalid argument')) {
        hasError = true;
      }
    }
  });

  ytdlp.on('error', err => { hasError = true; errorOutput = err.message; });
  ytdlp.on('close', (code, signal) => {
    if (!silent) console.log(`yt-dlp 進程結束 (code: ${code}, signal: ${signal}, 數據已接收: ${dataReceived})`);
    if (code !== 0 && !dataReceived && hasError) {
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
    }, 1000); // 每秒檢查一次
  });
}

// ════════════════════════════════════════════════════════
//  重試 / 跳過邏輯
// ════════════════════════════════════════════════════════
function _handleStreamError(guildId, item, player, retryCount, errorMessage, silent = false) {
  const currentErrors = (errorCounts.get(guildId) || 0) + 1;
  errorCounts.set(guildId, currentErrors);

  if (!silent) {
    console.error(`❌ [Bilibili] 串流錯誤 (${currentErrors}/${MAX_CONSECUTIVE_ERRORS}): ${errorMessage}`);
  }

  if (currentErrors >= MAX_CONSECUTIVE_ERRORS) {
    if (!silent) console.error('❌ [Bilibili] 連續錯誤過多，停止播放');
    player.emit('error', new Error(`連續發生 ${currentErrors} 次錯誤，已停止播放`));
    stopAll(guildId);
    return;
  }

  if (retryCount < MAX_RETRIES) {
    if (!silent) console.log(`⏳ [Bilibili] ${RETRY_DELAY / 1000} 秒後重試 (${retryCount + 1}/${MAX_RETRIES})...`);
    setTimeout(() => playStream(guildId, item, player, { retryCount: retryCount + 1, silent }), RETRY_DELAY);
  } else {
    if (!silent) console.error('❌ [Bilibili] 重試次數已用盡，通知上層跳過');
    player.emit('error', new Error(`播放失敗（已重試 ${MAX_RETRIES} 次）：${errorMessage.substring(0, 100)}`));
  }
}

// ════════════════════════════════════════════════════════
//  setupBilibiliEngine
// ════════════════════════════════════════════════════════
async function setupBilibiliEngine() {
  BILIBILI_COOKIES_FILE = prepareBilibiliCookies();
  ensureCacheDir();

  const [ytdlpOk, ffmpegOk] = await Promise.all([checkYtDlp(), checkFFmpeg()]);
  if (ytdlpOk && ffmpegOk) {
    console.log('✅ [Bilibili] 引擎已就緒');
    console.log(BILIBILI_COOKIES_FILE ? '✅ Bilibili Cookies 已配置' : '⚠️ 未配置 Bilibili Cookies，可能無法播放');
    console.log(`📁 [Bilibili] 快取資料夾: ${CACHE_DIR} (上限 ${MAX_CACHE_SIZE_MB} MB)`);
  } else {
    console.warn('⚠️ [Bilibili] 引擎可能無法正常運作');
  }

  // 注入引擎到 unifiedQueue
  registerEngine('bilibili', { playStream, getInfo });
}

module.exports = { setupBilibiliEngine, cleanupProcess, getCachedPath, downloadAndCache };
