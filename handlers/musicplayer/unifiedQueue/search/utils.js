// handlers/musicplayer/unifiedQueue/search/utils.js
// 職責：小型純函式工具（時長格式化、洗牌、網址清理、播放清單條目解析）

// ════════════════════════════════════════════════════════
//  時長格式化（與 onlineMusicHandler.js 的邏輯保持一致）
// ════════════════════════════════════════════════════════
function formatDuration(seconds) {
  if (!seconds) return '未知';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

// ════════════════════════════════════════════════════════
//  Fisher-Yates 洗牌
// ════════════════════════════════════════════════════════
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ════════════════════════════════════════════════════════
//  網址清理工具 (URL Cleaning)
// ════════════════════════════════════════════════════════
function cleanUrl(rawUrl) {
  try {
    const urlObj = new URL(rawUrl);

    if (urlObj.hostname.includes('bilibili.com')) {
      const p = urlObj.searchParams.get('p');
      urlObj.search = '';
      if (p) urlObj.searchParams.set('p', p);
      return urlObj.toString();
    }

    if (urlObj.hostname.includes('youtube.com') || urlObj.hostname === 'youtu.be') {
      urlObj.searchParams.delete('list');
      urlObj.searchParams.delete('index');
      urlObj.searchParams.delete('start_radio');
      urlObj.searchParams.delete('rv');
      urlObj.searchParams.delete('feature');
      return urlObj.toString();
    }

    return rawUrl;
  } catch (error) {
    return rawUrl;
  }
}

// ════════════════════════════════════════════════════════
//  將 flat-playlist 條目解析為可直接 getInfo() 的完整網址
// ════════════════════════════════════════════════════════
function resolveEntryUrl(baseUrl, entry) {
  if (entry.url && /^https?:\/\//i.test(entry.url)) return entry.url;
  if (entry.webpage_url) return entry.webpage_url;
  if (entry.id) return `https://www.youtube.com/watch?v=${entry.id}`;
  return baseUrl;
}

module.exports = { formatDuration, shuffle, cleanUrl, resolveEntryUrl };
