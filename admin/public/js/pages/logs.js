// 日誌：Bot 最近的執行紀錄（伺服器在記憶體保留最近 500 則），每 2 秒增量更新

import { h, icon } from '../dom.js';
import { api, qs } from '../api.js';
import { fmtDateTime, fmtInt, fmtTime } from '../format.js';
import { emptyState, errorState, segmented, selectEl } from '../ui.js';

const POLL_MS = 2000;
const MAX_ROWS = 1000;
const LEVEL_RANK = { debug: 0, info: 1, success: 1, warn: 2, error: 3 };
const LEVEL_ICON = { debug: 'info', info: 'info', success: 'check', warn: 'alert', error: 'x' };
const LEVEL_NAME = { debug: '除錯', info: '資訊', success: '成功', warn: '警告', error: '錯誤' };

export default function mountLogs(root, ctx) {
  let entries = [];
  let lastSeq = 0;
  let minLevel = 0;
  let moduleFilter = '';
  let query = '';
  let paused = false;
  let follow = true; // 停在最底下時自動捲到最新
  let serverLevel = 'info';
  let loaded = false;

  const levelSeg = segmented({
    ariaLabel: '最低顯示等級', value: 0,
    options: [{ value: 0, label: '全部' }, { value: 1, label: '資訊以上' }, { value: 2, label: '警告以上' }, { value: 3, label: '只看錯誤' }],
    onChange: (v) => { minLevel = v; renderAll(); },
  });
  const modSel = selectEl({ options: [], placeholder: '所有模組', ariaLabel: '依模組篩選', onchange: () => { moduleFilter = modSel.value; renderAll(); } });
  const search = h('input', {
    class: 'input', type: 'search', placeholder: '搜尋內容', 'aria-label': '搜尋紀錄',
    oninput: () => { query = search.value.trim().toLowerCase(); renderAll(); },
  });
  const pauseBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => setPaused(!paused) });
  const clearBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { entries = []; renderAll(); } }, icon('trash', 'ic-sm'), '清除畫面');
  ctx.setActions(pauseBtn, clearBtn);

  const view = h('div', { class: 'log-view', role: 'log', tabindex: '0', 'aria-label': '執行紀錄' });
  const jumpBtn = h('button', {
    type: 'button', class: 'btn btn-sm log-jump', hidden: true,
    onclick: () => { follow = true; jumpBtn.hidden = true; scrollBottom(); },
  }, icon('arrow-down', 'ic-sm'), '跳到最新');
  const footer = h('div', { class: 'card-note' });
  root.append(
    h('div', { class: 'toolbar' }, levelSeg, h('div', { class: 'input-icon' }, icon('search'), search), modSel),
    h('section', { class: 'card log-card' }, view, jumpBtn, footer),
  );

  view.addEventListener('scroll', () => {
    const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 24;
    follow = atBottom;
    jumpBtn.hidden = atBottom;
  });

  function paintPause() {
    pauseBtn.replaceChildren(icon(paused ? 'play' : 'pause', 'ic-sm'), paused ? '繼續' : '暫停');
    pauseBtn.classList.toggle('is-active', paused);
    updateFooter();
  }

  function setPaused(v) {
    paused = v;
    paintPause();
    if (!paused) poll().catch(() => {});
  }

  const scrollBottom = () => { view.scrollTop = view.scrollHeight; };

  function matches(e) {
    if (e.gap) return true;
    return (LEVEL_RANK[e.level] ?? 1) >= minLevel
      && (!moduleFilter || e.mod === moduleFilter)
      && (!query || e.msg.toLowerCase().includes(query) || e.mod.toLowerCase().includes(query));
  }

  function row(e) {
    if (e.gap) {
      return h('div', { class: 'log-row lv-debug' }, h('span'), h('span'), h('div', { class: 'log-msg' }, `…中間有 ${fmtInt(e.gap)} 則紀錄已被較新的紀錄擠掉`));
    }
    return h('div', { class: ['log-row', `lv-${e.level}`] },
      h('span', { class: 'log-time', title: fmtDateTime(e.ts) }, fmtTime(e.ts)),
      h('span', { class: 'log-lv', role: 'img', 'aria-label': LEVEL_NAME[e.level] ?? e.level, title: LEVEL_NAME[e.level] ?? e.level }, icon(LEVEL_ICON[e.level] ?? 'info')),
      h('div', { class: 'log-msg' }, h('span', { class: 'log-mod' }, `[${e.mod}]`), e.msg),
    );
  }

  function renderAll() {
    const shown = entries.filter(matches);
    view.replaceChildren(...(shown.length
      ? shown.map(row)
      : [emptyState(entries.length ? '沒有符合篩選條件的紀錄' : '目前還沒有紀錄', 'terminal')]));
    if (follow) scrollBottom();
    updateFooter();
  }

  function appendRows(list) {
    const shown = list.filter(matches);
    if (!shown.length) return;
    if (view.querySelector('.empty')) view.replaceChildren();
    view.append(...shown.map(row));
    while (view.childElementCount > MAX_ROWS) view.firstElementChild.remove();
    if (follow) scrollBottom();
  }

  function updateModules() {
    const mods = [...new Set(entries.filter((e) => !e.gap).map((e) => e.mod))].sort((a, b) => a.localeCompare(b));
    const current = modSel.value;
    modSel.replaceChildren(h('option', { value: '' }, '所有模組'), ...mods.map((m) => h('option', { value: m }, m)));
    modSel.value = mods.includes(current) ? current : '';
    if (modSel.value !== moduleFilter) { moduleFilter = modSel.value; renderAll(); }
  }

  function updateFooter() {
    footer.replaceChildren(icon('info', 'ic-sm'), h('span', null,
      `伺服器只保留最近 500 則・目前記錄等級 ${serverLevel}`
      + (serverLevel !== 'debug' ? '（.env 設 LOG_LEVEL=debug 可看到除錯訊息）' : '')
      + `・畫面上 ${fmtInt(entries.filter((e) => !e.gap).length)} 則`
      + (paused ? '・已暫停更新' : ''),
    ));
  }

  // 同時只跑一個請求：定時輪詢與「繼續」按鈕可能同時觸發，重疊會讓同一批紀錄出現兩次
  let inFlight = null;
  function poll() {
    if (paused || ctx.disposed) return Promise.resolve();
    inFlight ??= fetchNew().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function fetchNew() {
    let res = await api.get(qs('/api/logs', { since: lastSeq }));
    if (ctx.disposed) return;
    serverLevel = res.level;

    // Bot 重新啟動過：序號重新起算，從頭讀取
    if (res.latest < lastSeq) {
      lastSeq = 0;
      entries = [];
      renderAll();
      res = await api.get(qs('/api/logs', { since: 0 }));
      if (ctx.disposed) return;
    }

    const fresh = res.entries;
    if (fresh.length) {
      // 兩次讀取之間超過 500 則，最舊的那些已被擠掉
      const missed = lastSeq ? fresh[0].seq - lastSeq - 1 : 0;
      const batch = missed > 0 ? [{ gap: missed, seq: fresh[0].seq - 0.5 }, ...fresh] : fresh;
      entries.push(...batch);
      if (entries.length > MAX_ROWS) entries.splice(0, entries.length - MAX_ROWS);
      lastSeq = fresh[fresh.length - 1].seq;
      updateModules();
      appendRows(batch);
    }
    updateFooter();
  }

  async function firstLoad() {
    try {
      await poll();
      loaded = true;
      if (!entries.length) renderAll();
    } catch (err) {
      if (!loaded && !ctx.disposed) view.replaceChildren(errorState(err, firstLoad));
    }
  }

  paintPause();
  firstLoad();
  ctx.poll(poll, POLL_MS);
}
