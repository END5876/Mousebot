'use strict';
// handlers/musicplayer/musicLibraryClient.js
// 職責：每個 Bot 跟共用音樂庫服務（library-service/）溝通的唯一入口。
// 被 musicCache.js / localMusicHandler.js 使用。
//
// 設計原則：
//   - 未設定 MUSIC_LIB_URL 時，isConfigured() 回傳 false，呼叫端應該
//     整段退回舊有的「純本地磁碟」行為，讓這個模組完全是可選的加成，
//     不會讓沒設定共用音樂庫的單一 Bot 部署（例如本機開發）壞掉。
//   - 這裡只負責「跟 Library Service 溝通」，不做任何本地檔案系統操作，
//     本地檔案要怎麼擺、要不要覆寫，都交給呼叫端（musicCache.js /
//     localMusicHandler.js）決定。

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const LIB_URL = (process.env.MUSIC_LIB_URL || '').replace(/\/+$/, '');
const LIB_SECRET = process.env.MUSIC_LIB_SECRET || '';

const REQUEST_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000; // 上傳/下載音檔可能比較大，給長一點的逾時

function isConfigured() {
  return !!LIB_URL;
}

function _headers(extra = {}) {
  return LIB_SECRET ? { 'x-music-lib-key': LIB_SECRET, ...extra } : { ...extra };
}

// filename 可能包含子資料夾（例如 'cache/歌名 [BVxxxx].mp3'），逐段
// encodeURIComponent 再用 '/' 接回去，避免把 '/' 也編碼成 %2F 導致
// Library Service 那邊的萬用字元路由收到跟預期不同的字串。
function _encodeRelPath(relPath) {
  return String(relPath)
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

// ════════════════════════════════════════════════════════
//  清單
// ════════════════════════════════════════════════════════
async function fetchList() {
  if (!isConfigured()) return [];
  const { data } = await axios.get(`${LIB_URL}/api/music/list`, {
    headers: _headers(),
    timeout: REQUEST_TIMEOUT_MS,
  });
  return Array.isArray(data?.files) ? data.files : [];
}

// ════════════════════════════════════════════════════════
//  存在檢查
// ════════════════════════════════════════════════════════
async function checkExists(relPath) {
  if (!isConfigured()) return { exists: false };
  const { data } = await axios.get(`${LIB_URL}/api/music/exists`, {
    headers: _headers(),
    timeout: REQUEST_TIMEOUT_MS,
    params: { filename: relPath },
  });
  return data;
}

// ════════════════════════════════════════════════════════
//  下載（串流寫入本地暫存檔，完成後才 rename，避免半成品檔案被讀到）
// ════════════════════════════════════════════════════════
async function downloadToFile(relPath, destPath) {
  if (!isConfigured()) throw new Error('MUSIC_LIB_URL 未設定，無法向共用音樂庫下載');

  const response = await axios.get(`${LIB_URL}/api/music/file/${_encodeRelPath(relPath)}`, {
    headers: _headers(),
    responseType: 'stream',
    timeout: UPLOAD_TIMEOUT_MS,
  });

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.dl_${Date.now()}.tmp`;

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(tmpPath);
    response.data.on('error', reject);
    writer.on('error', reject);
    writer.on('finish', resolve);
    response.data.pipe(writer);
  }).catch((err) => {
    fs.promises.unlink(tmpPath).catch(() => {});
    throw err;
  });

  await fs.promises.rename(tmpPath, destPath);
  return destPath;
}

// ════════════════════════════════════════════════════════
//  上傳（把本地已經下載＋正規化好的檔案，推播給共用音樂庫）
// ════════════════════════════════════════════════════════
async function uploadFile(relPath, localFilePath) {
  if (!isConfigured()) return false;

  const stat = await fs.promises.stat(localFilePath);
  await axios.put(`${LIB_URL}/api/music/file/${_encodeRelPath(relPath)}`, fs.createReadStream(localFilePath), {
    headers: _headers({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(stat.size) }),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: UPLOAD_TIMEOUT_MS,
  });
  return true;
}

// ════════════════════════════════════════════════════════
//  播放次數（集中式）
// ════════════════════════════════════════════════════════
async function incrementPlayCount(relPath) {
  if (!isConfigured()) return null;
  const { data } = await axios.post(`${LIB_URL}/api/music/playcount/increment`, null, {
    headers: _headers(),
    timeout: REQUEST_TIMEOUT_MS,
    params: { filename: relPath },
  });
  return data?.playCount ?? null;
}

if (isConfigured()) {
  logger.debug('MusicLibraryClient', `共用音樂庫服務位址: ${LIB_URL}`);
}

module.exports = {
  isConfigured,
  fetchList,
  checkExists,
  downloadToFile,
  uploadFile,
  incrementPlayCount,
};
