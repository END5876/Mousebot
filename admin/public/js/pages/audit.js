// 操作紀錄：在管理面板上做過的變更與登入紀錄（data/adminAudit.json，保留最近 1000 筆）

import { fill, h, icon } from '../dom.js';
import { api, qs } from '../api.js';
import { fmtDateTime, fmtInt } from '../format.js';
import { emptyState, errorState, loadingState, toastError, withBusy } from '../ui.js';

const PAGE_SIZE = 100;

export default function mountAudit(root, ctx) {
  let entries = [];
  let query = '';
  let hasMore = false;

  const search = h('input', {
    class: 'input', type: 'search', placeholder: '搜尋操作內容或來源', 'aria-label': '搜尋操作紀錄',
    oninput: () => { query = search.value.trim().toLowerCase(); renderList(); },
  });
  const refreshBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => load(true) }, icon('refresh', 'ic-sm'), '重新整理');
  const moreBtn = h('button', { type: 'button', class: 'btn' }, '載入更早的紀錄');
  moreBtn.addEventListener('click', () => withBusy(moreBtn, () => load(false)));
  const countEl = h('span', { class: 'card-sub' });
  const listBody = h('div', null, loadingState());
  const foot = h('div', { class: 'card-foot', hidden: true }, h('span', { class: 'spacer' }), moreBtn);

  ctx.setActions(refreshBtn);
  root.append(
    h('div', { class: 'toolbar' }, h('div', { class: 'input-icon' }, icon('search'), search)),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, icon('history'), '操作紀錄'), countEl),
      listBody,
      foot,
      h('div', { class: 'card-note' }, icon('info', 'ic-sm'),
        h('span', null, '只記錄從管理面板做的變更與登入；Discord 指令的操作請看「日誌」。來源是連線的 IP（IPv6 以 /64 顯示）。')),
    ),
  );

  async function load(reset) {
    try {
      const before = reset || !entries.length ? null : entries[entries.length - 1].id;
      const res = await api.get(qs('/api/audit', { limit: PAGE_SIZE, before }));
      if (ctx.disposed) return;
      entries = reset ? res.entries : [...entries, ...res.entries];
      hasMore = res.entries.length === PAGE_SIZE;
      renderList();
    } catch (err) {
      if (ctx.disposed) return;
      if (!entries.length) fill(listBody, errorState(err, () => load(true)));
      else toastError(err);
    }
  }

  function renderList() {
    countEl.textContent = `已載入 ${fmtInt(entries.length)} 筆`;
    foot.hidden = !hasMore || !!query;
    const shown = query
      ? entries.filter((e) => e.action.toLowerCase().includes(query) || (e.source || '').toLowerCase().includes(query))
      : entries;
    if (!shown.length) {
      fill(listBody, emptyState(entries.length ? '沒有符合的紀錄' : '還沒有任何操作紀錄', 'history'));
      return;
    }
    fill(listBody, h('div', { class: 'table-wrap' }, h('table', { class: 'table table-stack' },
      h('thead', null, h('tr', null, h('th', null, '時間'), h('th', null, '操作'), h('th', null, '來源'))),
      h('tbody', null, shown.map((e) => h('tr', { class: e.level === 'warn' ? 'is-warn' : null },
        h('td', { class: 'audit-time', 'data-label': '時間' }, fmtDateTime(e.ts)),
        h('td', { class: 'audit-action' }, e.level === 'warn' ? [icon('alert', 'ic-sm'), ' '] : null, e.action),
        h('td', { class: 'audit-source mono', 'data-label': '來源' }, e.source || '—'),
      ))),
    )));
  }

  load(true);
}
