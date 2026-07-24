// handlers/musicplayer/online/playback.js
// 職責：playStream（由 unifiedQueue 呼叫）、背景快取下載、串流 fallback、重試邏輯

const {
  createAudioResource,
  StreamType,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const path = require('path');

const { stopAll } = require('../unifiedQueue');
const cache   = require('../musicCache');
const antiBot = require('../musicAntiBot');

const {
  ytdlpPath,
  MAX_RETRIES, RETRY_DELAY, MAX_CONSECUTIVE_ERRORS, MAX_CACHE_DURATION_SEC,
  activeProcesses, errorCounts, downloadingUrls,
  cleanupProcess,
} = require('./config');

// ════════════════════════════════════════════════════════
//  playStream（由 unifiedQueue 呼叫）
// ════════════════════════════════════════════════════════
async function playStream(guildId, item, player, { retryCount = 0, silent = false } = {}) {
  cleanupProcess(guildId);

  const platform = antiBot.isYouTubeUrl(item.url) ? 'YouTube' : 'Bilibili';

  const tooLongToCache = !item.durationSec || item.durationSec > MAX_CACHE_DURATION_SEC;

  try {
    const cachedPath = cache.getCachedPath(item.url, item.title);

    if (cachedPath) {
      if (!silent) console.log(`✅ [Cache] 快取命中，直接播放: ${path.basename(cachedPath)}`);
      _playFromFile(guildId, item, player, cachedPath, silent);
      return;
    }

    if (tooLongToCache) {
      const reason = !item.durationSec ? '未知長度/直播' : `長度超過 7 分鐘`;
      if (!silent) console.log(`⏭️ [${platform}] ${reason}，跳過背景下載，僅串流: ${item.title}`);
    } else {
      if (!silent) console.log(`🔄 [${platform}] 快取未命中，啟動即時串流播放: ${item.title}`);
    }

    _fallbackStream(guildId, item, player, retryCount, silent);

    if (!tooLongToCache) {
      if (!downloadingUrls.has(item.url)) {
        downloadingUrls.add(item.url);

        if (!silent) console.log(`⬇️ [${platform}] 背景開始下載快取...`);

        const dlArgs = antiBot.isYouTubeUrl(item.url)
          ? antiBot.buildYouTubeArgs(
              item.url,
              antiBot.YT_CLIENT_STRATEGIES.find(s => s.name === 'default') || antiBot.YT_CLIENT_STRATEGIES[0],
              false,
            )
          : antiBot.buildBilibiliArgs(item.url, false);

        let lastProgress = 0;

        cache.downloadAndCache(
          item.url,
          item.title,
          dlArgs,
          (progress) => {
            if (progress - lastProgress >= 20) {
              lastProgress = progress;
              if (!silent) console.log(`⬇️ [${platform}] 背景下載進度: ${progress.toFixed(1)}%`);
            }
          },
        )
        .then((filePath) => {
          if (!silent) console.log(`✅ [Cache] 背景下載完成，已儲存至: ${path.basename(filePath)}`);
        })
        .catch((err) => {
          if (!silent) console.error(`⚠️ [Cache] 背景下載失敗: ${err.message}`);
        })
        .finally(() => {
          downloadingUrls.delete(item.url);
        });

      } else {
        if (!silent) console.log(`⏳ 此 URL 已經在背景下載中，跳過重複下載任務。`);
      }
    }

  } catch (err) {
    if (!silent) console.error(`❌ [${platform}] 播放前發生錯誤: ${err.message}`);
    _handleStreamError(guildId, item, player, retryCount, err.message, silent);
  }
}

function _playFromFile(guildId, item, player, filePath, silent) {
  try {
    const resource = createAudioResource(filePath, {
      inputType:    StreamType.Arbitrary,
      inlineVolume: false,
    });

    player.play(resource);
    errorCounts.set(guildId, 0);
    if (!silent) console.log(`🎵 [OnlineMusic] 本地播放: ${path.basename(filePath)}`);
  } catch (err) {
    if (!silent) console.error('❌ [OnlineMusic] 本地播放失敗:', err);
    _handleStreamError(guildId, item, player, 0, err.message, silent);
  }
}

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
    inlineVolume: false,
  });

  resource.playStream?.on('error', err => {
    if (!silent) console.error('音頻流錯誤:', err);
  });

  player.play(resource);
  errorCounts.set(guildId, 0);
}

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

module.exports = { playStream };
