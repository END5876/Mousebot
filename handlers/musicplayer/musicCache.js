// handlers/musicCache.js
// 職責：快取資料夾管理、檔名產生、快取讀寫、大小控制、下載執行
// 被 musicPlayer.js 引用

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ytdlpPath = 'yt-dlp';

// ── 快取資料夾 ────────────────────────────────────────────
const MUSIC_DIR         = path.join(__dirname, '..', 'music');
const CACHE_DIR         = path.join(MUSIC_DIR, 'cache');
const MAX_CACHE_SIZE_MB = parseInt(process.env.MAX_CACHE_SIZE_MB || '2048', 10);

// ════════════════════════════════════════════════════════
//  確保快取資料夾存在
// ════════════════════════════════════════════════════════
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    console.log(`📁 [Cache] 建立快取資料夾: ${CACHE_DIR}`);
  }
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
        const fp   = path.join(CACHE_DIR, f);
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
    }
  } catch (err) {
    console.error('❌ [Cache] 快取清理失敗:', err);
  }
}

// ════════════════════════════════════════════════════════
//  下載並儲存到快取
//  @param {string}   url
//  @param {string}   title
//  @param {string[]} ytdlpArgs   - 由 musicAntiBot.js 組合好的完整參數
//  @param {Function} onProgress  - (percent: number) => void
//  @returns {Promise<string>}    - 下載完成的檔案路徑
// ════════════════════════════════════════════════════════
function downloadAndCache(url, title, ytdlpArgs, onProgress) {
  return new Promise((resolve, reject) => {
    ensureCacheDir();
    evictCacheIfNeeded();

    const filename  = getCacheFilename(url, title);
    const filePath  = path.join(CACHE_DIR, filename);
    const tmpBase   = path.join(CACHE_DIR, filename.replace(/\.mp3$/, '.tmp'));
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
  getCachedPath,
  evictCacheIfNeeded,
  downloadAndCache,
};