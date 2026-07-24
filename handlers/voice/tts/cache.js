// handlers/voice/tts/cache.js
// 職責：合成結果的 LRU 文字快取（命中時 0 延遲）

const fs   = require('fs');
const path = require('path');
const { TTS_CACHE_MAX, TTS_CACHE_TTL_MS } = require('./config');

// key: `${modelKey}::${text}` → { file, engine, voice, model, createdAt }
const ttsCache = new Map();

function safeUnlink(f) { try { fs.unlinkSync(f); } catch {} }

function getCacheKey(text, modelKey) {
  return `${modelKey}::${text}`;
}

/**
 * 從快取取得合成結果。命中時複製檔案到新路徑（避免播放完刪除原始快取檔）。
 * @returns {{ file, engine, voice, model } | null}
 */
async function getCached(text, modelKey, destDir) {
  const key   = getCacheKey(text, modelKey);
  const entry = ttsCache.get(key);
  if (!entry) return null;

  // 檢查 TTL
  if (Date.now() - entry.createdAt > TTS_CACHE_TTL_MS) {
    safeUnlink(entry.file);
    ttsCache.delete(key);
    return null;
  }

  // 檢查檔案是否仍存在
  if (!fs.existsSync(entry.file)) {
    ttsCache.delete(key);
    return null;
  }

  // 複製到新路徑供播放使用（播放後會刪除副本，原始快取保留）
  const ext     = path.extname(entry.file);
  const newFile = path.join(destDir, `tts_cache_${Date.now()}${ext}`);
  try {
    await fs.promises.copyFile(entry.file, newFile);
  } catch {
    ttsCache.delete(key);
    return null;
  }

  // LRU：移到最後（最近使用）
  ttsCache.delete(key);
  ttsCache.set(key, entry);

  console.log(`⚡ [TTS Cache] 命中: ${text.slice(0, 20)}...`);
  return { ...entry, file: newFile };
}

/**
 * 將合成結果存入快取（LRU 淘汰最舊的）。
 */
function putCache(text, modelKey, entry) {
  if (TTS_CACHE_MAX <= 0) return;

  const key = getCacheKey(text, modelKey);

  // 淘汰超出上限的最舊項目
  if (ttsCache.size >= TTS_CACHE_MAX) {
    const oldestKey = ttsCache.keys().next().value;
    const oldest    = ttsCache.get(oldestKey);
    if (oldest) safeUnlink(oldest.file);
    ttsCache.delete(oldestKey);
  }

  // 複製一份專用快取檔案（原始檔案播放後會被刪除）
  const ext       = path.extname(entry.file);
  const cacheFile = entry.file.replace(ext, `_cache${ext}`);
  try {
    fs.copyFileSync(entry.file, cacheFile);
    ttsCache.set(key, { ...entry, file: cacheFile, createdAt: Date.now() });
  } catch {
    // 快取寫入失敗不影響主流程
  }
}

module.exports = {
  ttsCache,
  safeUnlink,
  getCacheKey,
  getCached,
  putCache,
};
