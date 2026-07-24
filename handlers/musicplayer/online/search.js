// handlers/musicplayer/online/search.js
// 職責：_searchOnePlatform（內部工具）、searchMulti（同時搜尋 YouTube + Bilibili）

const { spawn } = require('child_process');
const antiBot = require('../musicAntiBot');
const { ytdlpPath, SEARCH_TIMEOUT_MS_YT, SEARCH_TIMEOUT_MS_BILI, formatDuration } = require('./config');

// ════════════════════════════════════════════════════════
//  _searchOnePlatform — 搜尋單一平台（內部工具，不對外匯出）
// ════════════════════════════════════════════════════════
function _searchOnePlatform(searchPrefix, keyword, limit, fast = false) {
  return new Promise((resolve) => {
    const query = `${searchPrefix}${limit}:${keyword}`;
    const isYT  = searchPrefix === 'ytsearch';

    const args = [
      '--dump-json',
      '--no-warnings',
      '--socket-timeout', '10',
    ];

    if (isYT) {
      args.push('--flat-playlist');
      args.push(...antiBot.buildYouTubeSearchArgs()); // ★ 修正：補上防爬蟲參數
    } else {
      if (fast) args.push('--flat-playlist'); // ★ 修正：僅即時搜尋時降級換速度
      args.push(...antiBot.buildBilibiliSearchArgs());
    }

    args.push(query); // query（搜尋字串）放最後，與其他 build*Args() 慣例一致

    const timeoutMs = isYT ? SEARCH_TIMEOUT_MS_YT : SEARCH_TIMEOUT_MS_BILI;
    const ytdlp = spawn(ytdlpPath, args, { windowsHide: true });
    let data = '', errorData = '';
    let finished = false;

    // ── 逾時保護：避免 yt-dlp 卡住讓整個 searchMulti 永久等待 ──
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      console.warn(`⚠️ [Search] ${searchPrefix} 搜尋逾時（超過 ${timeoutMs / 1000}s），強制終止`);
      try { ytdlp.kill('SIGKILL'); } catch {}
      resolve([]);
    }, timeoutMs);

    ytdlp.stdout.on('data', c => { data      += c.toString(); });
    ytdlp.stderr.on('data', c => { errorData += c.toString(); });

    ytdlp.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0 || !data.trim()) {
        // ★ 修正：改用既有的錯誤分類函式，log 會顯示具體原因，不再被完全吞掉
        const classified = isYT
          ? antiBot.classifyYouTubeError(errorData)
          : antiBot.classifyBilibiliError(errorData);
        console.warn(`⚠️ [Search] ${searchPrefix} 搜尋失敗 (code=${code}): ${classified.msg}`);
        resolve([]); // 失敗回空陣列，不讓另一平台的搜尋結果被拖累
        return;
      }

      const lines = data.trim().split('\n').filter(Boolean);
      const results = [];

      for (const line of lines) {
        try {
          const info = JSON.parse(line);

          const url = info.webpage_url
            || info.url
            || (isYT  && info.id ? `https://www.youtube.com/watch?v=${info.id}` : null)
            || (!isYT && info.id ? `https://www.bilibili.com/video/${info.id}`   : null);

          if (!url) continue;

          const thumb = info.thumbnail
            || (Array.isArray(info.thumbnails) && info.thumbnails.length
                  ? info.thumbnails[info.thumbnails.length - 1].url
                  : null);

          results.push({
            platform : isYT ? 'YouTube' : 'Bilibili',
            title    : info.title    || '未知標題',
            author   : info.uploader || info.channel || info.creator || '未知作者',
            duration : formatDuration(info.duration),
            url,
            thumbnail: thumb,
          });
        } catch {
          // 忽略單行解析錯誤，不影響其他結果
        }
      }
      resolve(results);
    });

    ytdlp.on('error', err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      console.warn(`⚠️ [Search] ${searchPrefix} 執行 yt-dlp 失敗: ${err.message}`);
      resolve([]);
    });
  });
}

// ════════════════════════════════════════════════════════
//  searchMulti — 同時搜尋 YouTube + Bilibili
// ════════════════════════════════════════════════════════
async function searchMulti(keyword, limit = 5, fast = false, platforms = ['youtube', 'bilibili']) {
  const tasks = [
    platforms.includes('youtube')
      ? _searchOnePlatform('ytsearch', keyword, limit, fast)
      : Promise.resolve([]),
    platforms.includes('bilibili')
      ? _searchOnePlatform('bilisearch', keyword, limit, fast)
      : Promise.resolve([]),
  ];
  const [ytResults, biliResults] = await Promise.all(tasks);
  return [...ytResults, ...biliResults];
}

module.exports = { searchMulti };
