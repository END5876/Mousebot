'use strict';

const crypto = require('crypto');
const { _engines, SEARCH_MARKER, LOCAL_KEY_MARKER } = require('../state');

// ════════════════════════════════════════════════════════
//  即時線上搜尋（Autocomplete 用）— 節流 + 快取 + 搶時間
// ════════════════════════════════════════════════════════
const AC_MIN_KEYWORD_LEN   = 2;
const AC_SEARCH_TIMEOUT_MS = 2000;
const AC_CACHE_TTL_MS      = 30_000;
const AC_RESULT_LIMIT      = 5;
// 同時進行的即時搜尋上限：每個都是一支 yt-dlp（約 60~100MB），
// 打字時每個前綴都會觸發搜尋，滿了就終止最舊的（使用者已經打過去的前綴）
const AC_MAX_IN_FLIGHT     = 2;

const _acCache    = new Map(); // keyword(lowercase) -> { results, timestamp }
const _acInFlight = new Map(); // keyword(lowercase) -> { promise, controller }（插入順序 = 新舊順序）

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _acCache) {
    if (now - entry.timestamp >= AC_CACHE_TTL_MS) {
      _acCache.delete(key);
    }
  }
}, AC_CACHE_TTL_MS).unref(); // 只是清快取，不該讓程序（例如測試）因此無法結束

function _getAcCached(keyword) {
  const hit = _acCache.get(keyword);
  if (hit && Date.now() - hit.timestamp < AC_CACHE_TTL_MS) return hit.results;
  return null;
}

function _raceOnlineSearch(engine, keyword) {
  const key = keyword.toLowerCase();

  let inflight = _acInFlight.get(key)?.promise;
  if (!inflight) {
    while (_acInFlight.size >= AC_MAX_IN_FLIGHT) {
      const [oldestKey, oldest] = _acInFlight.entries().next().value;
      _acInFlight.delete(oldestKey);
      oldest.controller.abort();
    }

    const controller = new AbortController();
    // 第 3 參數 true      = fast 模式（YouTube 走 flat-playlist 加速）
    // 第 4 參數 ['youtube'] = 只搜尋 YouTube，移除 Bilibili
    inflight = engine.searchMulti(keyword, AC_RESULT_LIMIT, true, ['youtube'], { signal: controller.signal })
      .then(results => {
        // 被中止的搜尋回傳空陣列，不能寫進快取，否則 30 秒內這個關鍵字都查不到結果
        if (!controller.signal.aborted) _acCache.set(key, { results, timestamp: Date.now() });
        return results;
      })
      .catch(() => [])
      .finally(() => {
        // 被中止時這筆已經被移除，且同 key 可能已有新的搜尋，只刪自己那筆
        if (_acInFlight.get(key)?.controller === controller) _acInFlight.delete(key);
      });
    _acInFlight.set(key, { promise: inflight, controller });
  }

  const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), AC_SEARCH_TIMEOUT_MS));
  return Promise.race([inflight, timeoutPromise]);
}

// ════════════════════════════════════════════════════════
//  本地檔案的 choice value：Discord 限制 value 最多 100 字，
//  長檔名截斷後 getTrackInfo 對不到（會被當成線上搜尋），改用「標記 + 檔名雜湊」，送出時再換回完整檔名
// ════════════════════════════════════════════════════════
function _localKeyHash(filename) {
  return crypto.createHash('sha1').update(String(filename).replace(/\\/g, '/')).digest('hex').slice(0, 20);
}

function _localChoiceValue(filename) {
  return filename.length <= 100 ? filename : LOCAL_KEY_MARKER + _localKeyHash(filename);
}

// 標記 + 雜湊 → 完整檔名；音樂庫已變動找不到時回傳 null
function resolveLocalKey(input) {
  const localEngine = _engines.local;
  if (!localEngine) return null;
  const hash = input.slice(LOCAL_KEY_MARKER.length);
  const found = localEngine.getMusicFiles().find(f => _localKeyHash(f.filename) === hash);
  return found ? found.filename : null;
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
          value: _localChoiceValue(f.filename),
        }))
    : [];

  // 空白輸入：只顯示本地清單，不觸發線上搜尋
  if (focused.trim() === '') {
    const choices = [ALL_LOCAL_CHOICE, MULTI_LOCAL_CHOICE, ...fileChoices];
    interaction.respond(choices.slice(0, 25)).catch(() => {});
    return true;
  }

  // 保底：一定會顯示的「送出後搜尋」選項，即時搜尋失敗/逾時時墊底用
  // name 超過 100 字 Discord 會拒絕整個 respond（所有建議都不顯示），長輸入先截斷再放進標籤
  const fallbackLabel = focusedRaw.length > 60 ? `${focusedRaw.slice(0, 60)}…` : focusedRaw;
  const fallbackSearchChoice = {
    name : `🔍 搜尋線上：「${fallbackLabel}」（YouTube + Bilibili）`.slice(0, 100),
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

module.exports = { handleAutocomplete, resolveLocalKey };
