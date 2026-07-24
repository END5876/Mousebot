// handlers/musicplayer/online/config.js
// 職責：環境檢查（yt-dlp / ffmpeg）、常數設定、共用工具函式、進程/錯誤計數 Map

const { exec } = require('child_process');
const { promisify } = require('util');
const logger = require('../../../utils/logger');

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

// ── 下載鎖（防止同一 URL 同時下載兩次）──────────────────
const downloadingUrls = new Set();

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

// 清理指定 guild 的錯誤計數，供 stopAll 呼叫，避免長期累積
function clearErrorCount(guildId) {
  errorCounts.delete(guildId);
}

module.exports = {
  ytdlpPath,
  MAX_RETRIES,
  RETRY_DELAY,
  MAX_CONSECUTIVE_ERRORS,
  MAX_CACHE_DURATION_SEC,
  SEARCH_TIMEOUT_MS_YT,
  SEARCH_TIMEOUT_MS_BILI,
  GET_INFO_TIMEOUT_MS,
  activeProcesses,
  errorCounts,
  downloadingUrls,
  checkYtDlp,
  checkFFmpeg,
  formatDuration,
  cleanupProcess,
  clearErrorCount,
};
