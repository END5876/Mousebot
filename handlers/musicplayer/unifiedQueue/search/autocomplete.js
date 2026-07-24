// handlers/musicplayer/unifiedQueue/search/autocomplete.js
// 職責：即時線上搜尋（Autocomplete 用）— 節流 + 快取 + 搶時間

const { _engines, SEARCH_MARKER } = require('../state');

const AC_MIN_KEYWORD_LEN   = 2;
const AC_SEARCH_TIMEOUT_MS = 2000;
const AC_CACHE_TTL_MS      = 30_000;
const AC_RESULT_LIMIT      = 5;

const _acCache    = new Map(); // keyword(lowercase) -> { results, timestamp }
const _acInFlight = new Map(); // keyword(lowercase) -> Promise

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _acCache) {
    if (now - entry.timestamp >= AC_CACHE_TTL_MS) {
      _acCache.delete(key);
    }
  }
}, AC_CACHE_TTL_MS);

function _getAcCached(keyword) {
  const hit = _acCache.get(keyword);
  if (hit && Date.now() - hit.timestamp < AC_CACHE_TTL_MS) return hit.results;
  return null;
}

function _raceOnlineSearch(engine, keyword) {
  const key = keyword.toLowerCase();

  let inflight = _acInFlight.get(key);
  if (!inflight) {
    // 第 3 參數 true      = fast 模式（YouTube 走 flat-playlist 加速）
    // 第 4 參數 ['youtube'] = 只搜尋 YouTube，移除 Bilibili
    inflight = engine.searchMulti(keyword, AC_RESULT_LIMIT, true, ['youtube'])
      .then(results => {
        _acCache.set(key, { results, timestamp: Date.now() });
        return results;
      })
      .catch(() => [])
      .finally(() => { _acInFlight.delete(key); });
    _acInFlight.set(key, inflight);
  }

  const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), AC_SEARCH_TIMEOUT_MS));
  return Promise.race([inflight, timeoutPromise]);
}

// ════════════════════════════════════════════════════════
//  Autocomplete（即時顯示，可直接選歌）
// ════════════════════════════════════════════════════════
async function handleAutocomplete(interaction) {
  if (interaction.commandName !== 'play') return false;

  const focusedRaw = interaction.options.getFocused();
  const focused = focusedRaw.toLowerCase();

  // 網址不做任何建議
  if (focused.startsWith('http')) {
    interaction.respond([]).catch(() => {});
    return true;
  }

  const localEngine = _engines.local;

  const ALL_LOCAL_CHOICE = {
    name: '📂 ▶ 全部本地音樂（一次加入所有檔案）',
    value: '__ALL_LOCAL__',
  };

  const MULTI_LOCAL_CHOICE = {
    name: '📂✅ 選擇多首本地音樂（勾選加入）',
    value: '__LOCAL_MULTI__',
  };

  const fileChoices = localEngine
    ? localEngine.getMusicFiles()
        .filter(f =>
          f.name.toLowerCase().includes(focused) ||
          f.filename.toLowerCase().includes(focused)
        )
        .slice(0, 23)
        .map(f => ({
          name : `📁 ${f.name}`.slice(0, 100),
          value: f.filename.slice(0, 100),
        }))
    : [];

  // 空白輸入：只顯示本地清單，不觸發線上搜尋
  if (focused.trim() === '') {
    const choices = [ALL_LOCAL_CHOICE, MULTI_LOCAL_CHOICE, ...fileChoices];
    interaction.respond(choices.slice(0, 25)).catch(() => {});
    return true;
  }

  // 保底：一定會顯示的「送出後搜尋」選項，即時搜尋失敗/逾時時墊底用
  const fallbackSearchChoice = {
    name : `🔍 搜尋線上：「${focusedRaw}」（YouTube + Bilibili）`,
    value: (SEARCH_MARKER + focusedRaw).slice(0, 100),
  };

  // 關鍵字太短不觸發即時搜尋
  const onlineEngine = _engines.bilibili;
  if (focused.trim().length < AC_MIN_KEYWORD_LEN || !onlineEngine) {
    const choices = fileChoices.length > 0
      ? [...fileChoices, fallbackSearchChoice]
      : [fallbackSearchChoice, ...fileChoices];
    interaction.respond(choices.slice(0, 25)).catch(() => {});
    return true;
  }

  // 先看快取，命中就直接回傳，零延遲
  const cached = _getAcCached(focused);
  if (cached) {
    const onlineChoices = cached.map(r => ({
      name : `${r.platform === 'YouTube' ? '🎬' : '📺'} ${r.title} · ${r.author} (${r.duration})`.slice(0, 100),
      value: r.url.slice(0, 100),
    }));
    const choices = [...fileChoices, ...onlineChoices, fallbackSearchChoice];
    interaction.respond(choices.slice(0, 25)).catch(() => {});
    return true;
  }

  // 沒快取，搶時間即時查詢
  let onlineResults = null;
  try {
    onlineResults = await _raceOnlineSearch(onlineEngine, focusedRaw.trim());
  } catch {
    onlineResults = null;
  }

  if (onlineResults && onlineResults.length > 0) {
    const onlineChoices = onlineResults.map(r => ({
      name : `${r.platform === 'YouTube' ? '🎬' : '📺'} ${r.title} · ${r.author} (${r.duration})`.slice(0, 100),
      value: r.url.slice(0, 100),
    }));
    const choices = [...fileChoices, ...onlineChoices, fallbackSearchChoice];
    interaction.respond(choices.slice(0, 25)).catch(() => {});
    return true;
  }

  // 搜尋逾時 / 失敗 / 無結果 → 顯示保底選項，不讓使用者卡住
  const choices = fileChoices.length > 0
    ? [...fileChoices, fallbackSearchChoice]
    : [fallbackSearchChoice, ...fileChoices];
  interaction.respond(choices.slice(0, 25)).catch(() => {});
  return true;
}

module.exports = { handleAutocomplete };
