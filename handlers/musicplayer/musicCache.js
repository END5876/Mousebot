// handlers/musicCache.js
// 職責：快取資料夾管理、檔名產生、快取讀寫、大小控制、下載執行
// 被 musicPlayer.js 引用

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const ytdlpPath = 'yt-dlp';

// ── 快取資料夾 ────────────────────────────────────────────
const MUSIC_DIR         = path.join(__dirname, '..', '..', 'data', 'music');
const CACHE_DIR         = path.join(MUSIC_DIR, 'cache');
const MAX_CACHE_SIZE_MB = parseInt(process.env.MAX_CACHE_SIZE_MB || '2048', 10);

// ════════════════════════════════════════════════════════
//  確保快取資料夾存在
// ════════════════════════════════════════════════════════
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    logger.debug('Cache', `已建立快取資料夾: ${CACHE_DIR}`);
  }
}

// ════════════════════════════════════════════════════════
//  將作者名稱轉為安全的資料夾名稱
//  用途：把同一作者的快取音樂歸類到 cache/<作者>/ 底下，
//        避免所有下載檔案平鋪在同一層造成清單混亂
// ════════════════════════════════════════════════════════
const UNKNOWN_AUTHOR_FOLDER = '未知作者';

function sanitizeFolderName(name) {
  const safe = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return safe || UNKNOWN_AUTHOR_FOLDER;
}

function _authorDir(author) {
  return path.join(CACHE_DIR, sanitizeFolderName(author));
}

// ════════════════════════════════════════════════════════
//  從 URL + title 產生穩定的快取檔名
//  格式：<清理後的標題> [<影片ID>].mp3
// ════════════════════════════════════════════════════════
function getCacheFilename(url, title) {
  const safeTitle = (title || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  const bvMatch = url.match(/BV[\w]+/i);
  const avMatch = url.match(/av(\d+)/i);
  const ytMatch = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);

  const idSuffix = bvMatch ? bvMatch[0]
    : avMatch              ? `av${avMatch[1]}`
    : ytMatch              ? `yt_${ytMatch[1]}`
    : Buffer.from(url).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);

  return safeTitle ? `${safeTitle} [${idSuffix}].mp3` : `${idSuffix}.mp3`;
}

// ════════════════════════════════════════════════════════
//  檢查快取是否存在，回傳路徑或 null
//  優先查「作者資料夾」內的新路徑；找不到時，向下相容查
//  舊版（升級前）直接平放在 CACHE_DIR 根目錄的檔案，
//  避免升級後既有快取被判定為未命中而重複下載
// ════════════════════════════════════════════════════════
function getCachedPath(url, title, author) {
  ensureCacheDir();
  const filename = getCacheFilename(url, title);

  const newPath = path.join(_authorDir(author), filename);
  if (fs.existsSync(newPath)) return newPath;

  const legacyPath = path.join(CACHE_DIR, filename);
  if (fs.existsSync(legacyPath)) return legacyPath;

  return null;
}

// ════════════════════════════════════════════════════════
//  遞迴列出 CACHE_DIR 底下所有檔案（含各作者子資料夾）
// ════════════════════════════════════════════════════════
function _walkCacheFiles(dir) {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(_walkCacheFiles(fp));
    } else {
      out.push(fp);
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════
//  快取大小管理：超過上限時刪除最舊的檔案
//  ★ 改為遞迴掃描，因快取現在依作者分子資料夾存放；
//    刪除後若該作者資料夾已淨空，順手移除空資料夾
// ════════════════════════════════════════════════════════
function evictCacheIfNeeded() {
  try {
    const files = _walkCacheFiles(CACHE_DIR)
      .map(fp => {
        const stat = fs.statSync(fp);
        return { fp, mtime: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => a.mtime - b.mtime); // 最舊排前面

    let totalMB = files.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024;

    while (totalMB > MAX_CACHE_SIZE_MB && files.length > 0) {
      const oldest = files.shift();
      fs.unlinkSync(oldest.fp);
      totalMB -= oldest.size / 1024 / 1024;
      console.log(`🗑️ [Cache] 快取已滿，刪除舊檔: ${path.basename(oldest.fp)}`);

      const parentDir = path.dirname(oldest.fp);
      if (parentDir !== CACHE_DIR) {
        try {
          if (fs.readdirSync(parentDir).length === 0) fs.rmdirSync(parentDir);
        } catch {}
      }
    }
  } catch (err) {
    console.error('❌ [Cache] 快取清理失敗:', err);
  }
}

// ════════════════════════════════════════════════════════
//  下載並儲存到快取
//  @param {string}   url
//  @param {string}   title
//  @param {string}   author      - 上傳者/頻道名稱，用於分類子資料夾
//  @param {string[]} ytdlpArgs   - 由 musicAntiBot.js 組合好的完整參數
//  @param {Function} onProgress  - (percent: number) => void
//  @returns {Promise<string>}    - 下載完成的檔案路徑
// ════════════════════════════════════════════════════════
function downloadAndCache(url, title, author, ytdlpArgs, onProgress) {
  return new Promise((resolve, reject) => {
    ensureCacheDir();
    evictCacheIfNeeded();

    const authorDir = _authorDir(author);
    if (!fs.existsSync(authorDir)) fs.mkdirSync(authorDir, { recursive: true });

    const filename  = getCacheFilename(url, title);
    const filePath  = path.join(authorDir, filename);
    const tmpBase   = path.join(authorDir, filename.replace(/\.mp3$/, '.tmp'));
    const tmpActual = tmpBase + '.mp3'; // yt-dlp 轉檔後實際產生的路徑

    // 將輸出路徑注入參數（替換佔位符 __OUTPUT__）
    const finalArgs = ytdlpArgs.map(a => a === '__OUTPUT__' ? tmpBase : a);

    const platform = url.includes('youtube.com') || url.includes('youtu.be')
      ? 'YouTube' : 'Bilibili';

    console.log(`⬇️ [${platform}] 開始下載: ${filename}`);
    const ytdlp = spawn(ytdlpPath, finalArgs, { windowsHide: true });

    let errorOutput = '';

    ytdlp.stderr.on('data', data => {
      const line = data.toString();
      errorOutput += line;
      const progressMatch = line.match(/\[download\]\s+([\d.]+)%/);
      if (progressMatch && onProgress) {
        onProgress(parseFloat(progressMatch[1]));
      }
    });

    ytdlp.on('error', err => reject(new Error('執行 yt-dlp 失敗: ' + err.message)));

    ytdlp.on('close', code => {
      if (code !== 0) {
        try { if (fs.existsSync(tmpActual)) fs.unlinkSync(tmpActual); } catch {}
        try { if (fs.existsSync(tmpBase))   fs.unlinkSync(tmpBase);   } catch {}
        console.error(`❌ [${platform}] 下載失敗:`, errorOutput.slice(-300));
        reject(new Error(`下載失敗 (code: ${code}): ${errorOutput.slice(-200)}`));
        return;
      }

      const actualTmp = fs.existsSync(tmpActual) ? tmpActual
        : fs.existsSync(tmpBase)                 ? tmpBase
        : null;

      if (!actualTmp) {
        reject(new Error('下載完成但找不到輸出檔案'));
        return;
      }

      try {
        fs.renameSync(actualTmp, filePath);
        const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);
        console.log(`✅ [${platform}] 下載完成: ${filename} (${sizeMB} MB)`);
        resolve(filePath);
      } catch (err) {
        reject(new Error('重新命名快取檔失敗: ' + err.message));
      }
    });
  });
}

module.exports = {
  CACHE_DIR,
  MAX_CACHE_SIZE_MB,
  ensureCacheDir,
  getCacheFilename,
  sanitizeFolderName,
  getCachedPath,
  evictCacheIfNeeded,
  downloadAndCache,
};