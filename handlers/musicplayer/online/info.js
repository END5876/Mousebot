// handlers/musicplayer/online/info.js
// 職責：getInfo（取得影片資訊）、checkPlaylist（偵測網址是否為播放清單）

const { spawn } = require('child_process');
const antiBot = require('../musicAntiBot');
const { ytdlpPath, GET_INFO_TIMEOUT_MS } = require('./config');
const { formatDuration } = require('./config');

// ════════════════════════════════════════════════════════
//  getInfo（取得影片資訊）— YouTube + Bilibili
// ════════════════════════════════════════════════════════
async function getInfo(url) {
  return new Promise((resolve, reject) => {
    const args  = antiBot.buildInfoArgs(url);
    const ytdlp = spawn(ytdlpPath, args);
    let data = '', errorData = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      console.warn(`⚠️ [getInfo] 逾時（超過 ${GET_INFO_TIMEOUT_MS / 1000}s），強制終止: ${url}`);
      try { ytdlp.kill('SIGKILL'); } catch {}
      reject(new Error('取得影片資訊逾時，請確認網址是否正確或稍後再試'));
    }, GET_INFO_TIMEOUT_MS);

    ytdlp.stdout.on('data', c => { data      += c.toString(); });
    ytdlp.stderr.on('data', c => { errorData += c.toString(); });

    ytdlp.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0) {
        console.error('yt-dlp 錯誤輸出:', errorData);
        if (antiBot.isYouTubeUrl(url)) {
          const classified = antiBot.classifyYouTubeError(errorData);
          reject(new Error(`[YouTube] ${classified.msg}`));
        } else {
          const classified = antiBot.classifyBilibiliError(errorData);
          reject(new Error(`[Bilibili] ${classified.msg}`));
        }
        return;
      }
      try {
        const info = JSON.parse(data.trim().split('\n').pop());
        resolve({
          url,
          title      : info.title    || '未知標題',
          author     : info.uploader || info.channel || info.creator || '未知作者',
          duration   : formatDuration(info.duration),
          durationSec: info.duration || 0,   // 保留原始秒數，供快取判斷使用
          thumbnail  : info.thumbnail || null,
        });
      } catch { reject(new Error('解析影片資訊失敗')); }
    });

    ytdlp.on('error', err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error('執行 yt-dlp 失敗: ' + err.message));
    });
  });
}

// ════════════════════════════════════════════════════════
//  checkPlaylist（偵測網址是否為播放清單）
//  失敗 / 逾時皆安全降級為「非播放清單」，絕不阻斷原有單曲流程
// ════════════════════════════════════════════════════════
async function checkPlaylist(url) {
  return new Promise((resolve) => {
    const args  = antiBot.buildPlaylistCheckArgs(url);
    const ytdlp = spawn(ytdlpPath, args);
    let data = '', errorData = '';
    let finished = false;

    const fallback = () => resolve({ isPlaylist: false, entries: [], title: null, count: 1 });

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      console.warn(`⚠️ [checkPlaylist] 逾時，視為非播放清單: ${url}`);
      try { ytdlp.kill('SIGKILL'); } catch {}
      fallback();
    }, GET_INFO_TIMEOUT_MS);

    ytdlp.stdout.on('data', c => { data      += c.toString(); });
    ytdlp.stderr.on('data', c => { errorData += c.toString(); });

    ytdlp.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0 || !data.trim()) {
        console.warn('⚠️ [checkPlaylist] 偵測失敗，視為非播放清單:', errorData.slice(-150));
        return fallback();
      }

      try {
        const json    = JSON.parse(data);
        const entries = Array.isArray(json.entries) ? json.entries : null;

        if (entries && entries.length > 1) {
          resolve({
            isPlaylist : true,
            entries,
            title      : json.title || '未知播放清單',
            count      : entries.length,
          });
        } else {
          fallback();
        }
      } catch {
        fallback();
      }
    });

    ytdlp.on('error', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      fallback();
    });
  });
}

module.exports = { getInfo, checkPlaylist };
