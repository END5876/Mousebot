'use strict';

// ════════════════════════════════════════════════════════
//  時長格式化（與 onlineMusicHandler.js 的邏輯保持一致）
// ════════════════════════════════════════════════════════
function _formatDuration(seconds) {
  if (!seconds) return '未知';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
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
//  YouTube 網址且沒有 list 參數 → 一定是單一影片，不需要播放清單偵測
//  （mix / radio / 播放清單頁都會帶 list=；Bilibili 的分 P 無法從網址判斷，不適用）
// ════════════════════════════════════════════════════════
function _isYouTubeWithoutList(rawUrl) {
  try {
    const urlObj = new URL(rawUrl);
    const host = urlObj.hostname.toLowerCase();
    const isYouTube = host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
    return isYouTube && !urlObj.searchParams.has('list');
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════════
//  將 flat-playlist 條目解析為可直接 getInfo() 的完整網址
// ════════════════════════════════════════════════════════
function _resolveEntryUrl(baseUrl, entry) {
  if (entry.url && /^https?:\/\//i.test(entry.url)) return entry.url;
  if (entry.webpage_url) return entry.webpage_url;
  if (entry.id) return `https://www.youtube.com/watch?v=${entry.id}`;
  return baseUrl;
}

module.exports = {
  _formatDuration,
  cleanUrl,
  _isYouTubeWithoutList,
  _resolveEntryUrl
};
