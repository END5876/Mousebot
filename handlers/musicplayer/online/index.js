// handlers/musicplayer/online/index.js
// 對外進入點：彙整拆分後的子模組（config / info / search / playback），
// 維持與拆分前 onlineMusicHandler.js 完全相同的 module.exports 介面。

const { registerEngine } = require('../unifiedQueue');
const cache   = require('../musicCache');
const antiBot = require('../musicAntiBot');
const logger  = require('../../../utils/logger');
const bootSummary = require('../../../utils/bootSummary');

const {
  activeProcesses,
  checkYtDlp, checkFFmpeg,
  cleanupProcess, clearErrorCount,
} = require('./config');
const { getInfo, checkPlaylist } = require('./info');
const { searchMulti } = require('./search');
const { playStream } = require('./playback');

async function setupOnlineMusicEngine() {
  antiBot.initCookies();
  cache.ensureCacheDir();

  const [ytdlpOk, ffmpegOk] = await Promise.all([checkYtDlp(), checkFFmpeg()]);

  if (ytdlpOk && ffmpegOk) {
    const { bilibili, youtube, poToken } = antiBot.getCookieStatus();
    const cookieBits = [
      `Bilibili ${bilibili ? '✓' : '✗'}`,
      `YouTube ${youtube ? '✓' : '✗（無帳號模式）'}`,
      `PO Token ${poToken ? '✓' : '✗'}`,
    ].join('、');
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
    clearErrorCount,
    resetYtClient: antiBot.resetYtClient,
  });
}

// ════════════════════════════════════════════════════════
//  防殭屍進程保護 (Zombie Process Protection)
// ════════════════════════════════════════════════════════
process.on('exit', () => {
  for (const [guildId, childProcess] of activeProcesses.entries()) {
    if (!childProcess.killed) {
      try {
        childProcess.kill('SIGKILL');
      } catch (e) {}
    }
  }
});

process.on('uncaughtException', (err) => {
  console.error('❌ [OnlineMusic] 發生未捕捉的錯誤:', err);
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
  getCachedPath: cache.getCachedPath,
  downloadAndCache: (url, title, onProgress) => {
    const args = antiBot.isYouTubeUrl(url)
      ? antiBot.buildYouTubeArgs(url, antiBot.YT_CLIENT_STRATEGIES[0], false)
      : antiBot.buildBilibiliArgs(url, false);
    return cache.downloadAndCache(url, title, args, onProgress);
  },
};
