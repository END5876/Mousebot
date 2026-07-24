// handlers/musicplayer/antibot/combined.js
// 職責：同時涉及 YouTube 與 Bilibili 分支判斷的參數組合工具
// （buildInfoArgs / buildPlaylistCheckArgs），依網址判斷平台後
// 分別套用對應的 headers / cookies / proxy 設定

const { WARP_PROXY, _appendCookieArgs } = require('./config');
const { BILIBILI_HEADERS, getBilibiliCookieState } = require('./bilibili');
const {
  YOUTUBE_HEADERS, YT_CLIENT_STRATEGIES,
  isYouTubeUrl, getYoutubeCookieState,
} = require('./youtube');

function buildInfoArgs(url) {
  const base = ['--dump-json', '--no-playlist', '--no-warnings', '--skip-download'];

  if (isYouTubeUrl(url)) {
    if (WARP_PROXY) {
      base.push('--proxy', WARP_PROXY);
    }
    base.push('--js-runtimes', 'node');

    const strategy = YT_CLIENT_STRATEGIES.find(s => s.name === 'default') || YT_CLIENT_STRATEGIES[0];
    base.push(...strategy.args);

    if (strategy.name !== 'tv_simply') {
      const { file, header } = getYoutubeCookieState();
      _appendCookieArgs(base, file, header);
    }
    base.push('--user-agent', YOUTUBE_HEADERS['User-Agent'], '--no-check-certificate');
  } else {
    const { file, header } = getBilibiliCookieState();
    _appendCookieArgs(base, file, header);
    base.push(
      '--user-agent', BILIBILI_HEADERS['User-Agent'],
      '--referer',    BILIBILI_HEADERS['Referer'],
      '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
      '--no-check-certificate',
      '--extractor-args', 'bilibili:getcomments=false',
      '--extractor-args', 'bilibili:getdanmaku=false',
      '--sleep-requests',     '2',
      '--sleep-interval',     '2',
      '--max-sleep-interval', '5'
    );
  }

  base.push(url);
  return base;
}

// ════════════════════════════════════════════════════════
//  播放清單偵測專用參數（不加 --no-playlist，flat 模式快速列出項目）
// ════════════════════════════════════════════════════════
function buildPlaylistCheckArgs(url) {
  const base = ['--flat-playlist', '--dump-single-json', '--no-warnings', '--skip-download'];

  if (isYouTubeUrl(url)) {
    if (WARP_PROXY) base.push('--proxy', WARP_PROXY);
    base.push('--js-runtimes', 'node');

    const strategy = YT_CLIENT_STRATEGIES.find(s => s.name === 'default') || YT_CLIENT_STRATEGIES[0];
    base.push(...strategy.args);

    if (strategy.name !== 'tv_simply') {
      const { file, header } = getYoutubeCookieState();
      _appendCookieArgs(base, file, header);
    }
    base.push('--user-agent', YOUTUBE_HEADERS['User-Agent'], '--no-check-certificate');
  } else {
    const { file, header } = getBilibiliCookieState();
    _appendCookieArgs(base, file, header);
    base.push(
      '--user-agent', BILIBILI_HEADERS['User-Agent'],
      '--referer',    BILIBILI_HEADERS['Referer'],
      '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
      '--no-check-certificate',
      '--extractor-args', 'bilibili:getcomments=false',
      '--extractor-args', 'bilibili:getdanmaku=false'
    );
  }

  base.push(url);
  return base;
}

module.exports = { buildInfoArgs, buildPlaylistCheckArgs };
