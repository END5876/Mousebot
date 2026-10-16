'use strict';
// admin/cacheTools.js
// ─────────────────────────────────────────────────────────────
// 音樂快取的統計與清理。
//
// 線上歌曲下載後直接放在 data/music 根目錄（與本地音樂同一個資料夾），檔名由 musicCache.getCacheFilename()
// 產生：「<標題> [yt_<影片ID>].mp3」「<標題> [BV…].mp3」「<標題> [av…].mp3」。清理時只刪符合這個命名的檔案，
// 本地音樂不會被動到；舊版放在 data/music/cache/ 的下載檔也一併處理。
// 正在播放或排在佇列裡的歌、下載／轉檔中的暫存檔都會跳過。

const fs = require('fs');
const path = require('path');
const { CACHE_DIR, MAX_CACHE_SIZE_MB, SUPPORTED_EXTENSIONS, isTempName, getCacheFilename } = require('../handlers/musicplayer/musicCache');
const state = require('../handlers/musicplayer/unifiedQueue/state');

const DOWNLOAD_NAME = /(?:\s\[(?:yt_[A-Za-z0-9_-]{11}|BV\w+|av\d+)\]|^(?:yt_[A-Za-z0-9_-]{11}|BV\w+|av\d+))\.mp3$/i;
const LEGACY_DIR = 'cache';
const MB = 1024 * 1024;

const isAudio = (name) => SUPPORTED_EXTENSIONS.includes(path.extname(name).toLowerCase());

// data/music 底下所有音訊檔（相對路徑用 / 分隔），分成 下載快取 / 本地音樂 / 暫存
function scan() {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(full, relPath); continue; }
      if (!entry.isFile()) continue;
      const temp = isTempName(entry.name);
      if (!temp && !isAudio(entry.name)) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      const inRootOrLegacy = !rel || rel === LEGACY_DIR;
      out.push({
        full,
        relPath,
        size: stat.size,
        mtime: stat.mtimeMs,
        root: !rel,
        kind: temp ? 'temp' : inRootOrLegacy && DOWNLOAD_NAME.test(entry.name) ? 'download' : 'local',
      });
    }
  };
  walk(CACHE_DIR, '');
  return out;
}

// 正在播放、排在佇列裡的曲目對應的檔案（相對路徑）
function inUsePaths() {
  const paths = new Set();
  const add = (item) => {
    if (!item) return;
    if (item.type === 'bilibili' && item.url) paths.add(getCacheFilename(item.url, item.title));
    else if (item.filename) paths.add(String(item.filename).replace(/\\/g, '/'));
  };
  for (const np of state.nowPlaying.values()) add(np.item);
  for (const queue of state.queues.values()) (queue || []).forEach(add);
  return paths;
}

const sum = (files) => files.reduce((s, f) => s + f.size, 0);
const toMB = (bytes) => Math.round((bytes / MB) * 10) / 10;

function cacheStats() {
  const files = scan();
  const inUse = inUsePaths();
  const downloads = files.filter((f) => f.kind === 'download');
  const local = files.filter((f) => f.kind === 'local');
  const temp = files.filter((f) => f.kind === 'temp');
  // musicCache.evictCacheIfNeeded() 只看根目錄的音訊檔（不含暫存）
  const rootAudio = files.filter((f) => f.root && f.kind !== 'temp');
  return {
    dir: 'data/music',
    limitMB: MAX_CACHE_SIZE_MB,
    rootMB: toMB(sum(rootAudio)),
    downloads: {
      count: downloads.length,
      sizeMB: toMB(sum(downloads)),
      inUse: downloads.filter((f) => inUse.has(f.relPath)).length,
      oldest: downloads.length ? Math.min(...downloads.map((f) => f.mtime)) : null,
      largest: [...downloads].sort((a, b) => b.size - a.size).slice(0, 8)
        .map((f) => ({ name: f.relPath, sizeMB: toMB(f.size), modifiedAt: Math.floor(f.mtime) })),
    },
    local: { count: local.length, sizeMB: toMB(sum(local)) },
    temp: { count: temp.length, sizeMB: toMB(sum(temp)) },
  };
}

/** 刪除所有下載快取（跳過使用中的）；回傳刪除數量與釋放的空間 */
function clearDownloads() {
  const inUse = inUsePaths();
  let deleted = 0;
  let freed = 0;
  let skipped = 0;
  const failed = [];
  for (const f of scan()) {
    if (f.kind !== 'download') continue;
    if (inUse.has(f.relPath)) { skipped++; continue; }
    try {
      fs.unlinkSync(f.full);
      deleted++;
      freed += f.size;
    } catch (err) {
      failed.push(`${f.relPath}（${err.code || err.message}）`);
    }
  }
  return { deleted, freedMB: toMB(freed), skipped, failed };
}

module.exports = { cacheStats, clearDownloads, _DOWNLOAD_NAME: DOWNLOAD_NAME };
