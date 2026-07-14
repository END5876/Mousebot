#!/usr/bin/env node
// scripts/migrateCacheAuthors.js
//
// 一次性遷移腳本：把「升級前」直接平放在 data/music/cache/ 根目錄的
// 快取檔案，依作者重新查詢並搬進 cache/<作者>/ 子資料夾。
// 已經在作者子資料夾裡的檔案（新結構）不會被動到，可重複執行、安全冪等。
//
// 用法：
//   node scripts/migrateCacheAuthors.js            實際執行搬移
//   node scripts/migrateCacheAuthors.js --dry-run  只預覽會怎麼搬，不動任何檔案
//
// 原理：
//   舊版檔名格式為「<標題> [<ID>].mp3」（見 musicCache.js 的 getCacheFilename）。
//   ID 可能是 Bilibili 的 BV 號 / av 號，或 YouTube 的 yt_<影片ID>。
//   我們從檔名反推回原始網址，重新呼叫一次 yt-dlp 取得作者（uploader/channel），
//   再依 sanitizeFolderName() 規則搬進對應的作者資料夾。
//   若 ID 是「無法辨識來源」的 base64 亂碼備援檔名（極舊或特殊情況），會直接跳過。
//
// 注意：
//   會對外發送 yt-dlp 查詢請求（等同重新 getInfo 一次），請求之間間隔 3 秒，
//   避免短時間大量請求觸發 YouTube / Bilibili 反爬蟲機制。檔案數量多時請耐心等候。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const cache   = require('../handlers/musicplayer/musicCache');
const antiBot = require('../handlers/musicplayer/musicAntiBot');

const DRY_RUN = process.argv.includes('--dry-run');
const SLEEP_BETWEEN_MS = 3000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ════════════════════════════════════════════════════════
//  從舊檔名反推原始網址
//  對應 musicCache.js 的 getCacheFilename() 產生規則
// ════════════════════════════════════════════════════════
function resolveUrlFromLegacyFilename(filename) {
  const m = filename.match(/\[([^\]]+)\]\.mp3$/i);
  if (!m) return null;
  const idSuffix = m[1];

  if (/^BV[\w]+$/i.test(idSuffix)) {
    return `https://www.bilibili.com/video/${idSuffix}`;
  }
  if (/^av\d+$/i.test(idSuffix)) {
    return `https://www.bilibili.com/video/${idSuffix}`;
  }
  if (/^yt_[A-Za-z0-9_-]{6,}$/.test(idSuffix)) {
    return `https://www.youtube.com/watch?v=${idSuffix.slice(3)}`;
  }
  return null; // base64 亂碼備援檔名，無法反推，跳過
}

// ════════════════════════════════════════════════════════
//  簡化版 getInfo：只取作者名稱
//  （刻意不 require onlineMusicHandler.js，避免連帶載入整個
//    Discord voice / unifiedQueue 模組鏈，讓這支維護腳本保持獨立輕量）
// ════════════════════════════════════════════════════════
function fetchAuthor(url) {
  return new Promise((resolve, reject) => {
    const args  = antiBot.buildInfoArgs(url);
    const ytdlp = spawn('yt-dlp', args);
    let data = '', errorData = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { ytdlp.kill('SIGKILL'); } catch {}
      reject(new Error('取得資訊逾時'));
    }, 15000);

    ytdlp.stdout.on('data', c => { data      += c.toString(); });
    ytdlp.stderr.on('data', c => { errorData += c.toString(); });

    ytdlp.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(errorData.slice(-200) || `yt-dlp exit code ${code}`));
        return;
      }
      try {
        const info = JSON.parse(data.trim().split('\n').pop());
        resolve(info.uploader || info.channel || info.creator || null);
      } catch {
        reject(new Error('解析 yt-dlp 輸出失敗'));
      }
    });

    ytdlp.on('error', err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ════════════════════════════════════════════════════════
//  主流程
// ════════════════════════════════════════════════════════
async function main() {
  antiBot.initCookies();
  cache.ensureCacheDir();

  const CACHE_DIR = cache.CACHE_DIR;

  // 只掃「直接放在 CACHE_DIR 根目錄」的檔案（不遞迴），
  // 這才是真正需要遷移的舊資料；已經在作者子資料夾裡的新結構檔案不會被掃到
  const rootEntries = fs.readdirSync(CACHE_DIR, { withFileTypes: true });
  const legacyFiles = rootEntries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.mp3'))
    .map(e => e.name);

  if (legacyFiles.length === 0) {
    console.log('✅ 沒有找到需要遷移的舊版快取檔案，快取已經是新結構，無需執行。');
    return;
  }

  console.log(
    `🔍 找到 ${legacyFiles.length} 個待遷移的舊版快取檔案` +
    `${DRY_RUN ? '（dry-run 模式，不會真的搬動檔案）' : ''}\n`
  );

  let migrated = 0, skippedNoUrl = 0, failed = 0;

  for (const filename of legacyFiles) {
    const url = resolveUrlFromLegacyFilename(filename);

    if (!url) {
      console.log(`⏭️  跳過（無法從檔名判斷來源網址）: ${filename}`);
      skippedNoUrl++;
      continue;
    }

    try {
      console.log(`🔎 查詢作者中: ${filename}`);
      const author = await fetchAuthor(url);
      const authorFolder = cache.sanitizeFolderName(author);

      const srcPath  = path.join(CACHE_DIR, filename);
      const destDir  = path.join(CACHE_DIR, authorFolder);
      const destPath = path.join(destDir, filename);

      if (DRY_RUN) {
        console.log(`   → 會搬到: cache/${authorFolder}/${filename}`);
      } else {
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        if (fs.existsSync(destPath)) {
          console.log(`   ⚠️ 目的地已存在同名檔案，跳過避免覆蓋: ${destPath}`);
        } else {
          fs.renameSync(srcPath, destPath);
          console.log(`   ✅ 已搬到: cache/${authorFolder}/${filename}`);
        }
      }
      migrated++;
    } catch (err) {
      console.log(`   ❌ 查詢失敗，保留原位置: ${filename}（${err.message}）`);
      failed++;
    }

    await sleep(SLEEP_BETWEEN_MS);
  }

  console.log('\n📊 遷移結果統計');
  console.log(`   成功: ${migrated}`);
  console.log(`   跳過（無法判斷來源網址）: ${skippedNoUrl}`);
  console.log(`   失敗（查詢錯誤，可重跑腳本再試一次）: ${failed}`);
  if (DRY_RUN) console.log('\n💡 這是 dry-run 預覽結果，實際執行請拿掉 --dry-run 參數重新執行');
}

main().catch(err => {
  console.error('❌ 腳本執行發生未預期錯誤:', err);
  process.exit(1);
});