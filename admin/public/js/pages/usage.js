// AI 用量：Gemini token 的每日統計（data/tokenUsage.json，保留 90 天），依來源 / 人格 / 使用者拆分
// 「計費 token」＝ total 扣掉搜尋取回的內容（官方不以輸入 token 計費，見 tokenTracker.js）

import { h, icon, setVar } from '../dom.js';
import { api, qs } from '../api.js';
import { columnChart } from '../chart.js';
import { fmtCompact, fmtDayKey, fmtInt, fmtPercent } from '../format.js';
import { avatar, emptyState, errorState, loadingState, segmented, toastError } from '../ui.js';

const SOURCE_LABEL = {
  chat: '對話',
  short: '隨機插話',
  voice: '語音對話',
  search: '搜尋查證',
  gugu: '咕咕嘎嘎',
  billScan: '帳單辨識',
};
const RANGES = [{ value: 7, label: '近 7 天' }, { value: 30, label: '近 30 天' }, { value: 90, label: '近 90 天' }];
const FIELDS = ['calls', 'prompt', 'output', 'thoughts', 'cached', 'toolUse', 'searches', 'total', 'billable'];
const MAX_USERS = 15;

function sum(buckets) {
  const out = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  for (const b of buckets) if (b) for (const f of FIELDS) out[f] += b[f] ?? 0;
  return out;
}

function groupTotals(days, field) {
  const map = new Map();
  for (const day of days) {
    for (const [key, bucket] of Object.entries(day[field])) map.set(key, sum([map.get(key), bucket]));
  }
  return [...map.entries()].sort((a, b) => b[1].billable - a[1].billable);
}

function stat(label, value, sub, extra) {
  return h('div', { class: 'stat' },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value' }, value),
    sub ? h('div', { class: 'stat-sub' }, sub) : null,
    extra,
  );
}

function tipRow(label, value) {
  return h('div', { class: 'tip-row' }, h('span', { class: 'tip-label' }, label), h('span', null, value));
}

export default function mountUsage(root, ctx) {
  let range = 30;
  let data = null;
  let chart = null;
  let showTable = false;
  let loadToken = 0;

  const rangeSeg = segmented({ ariaLabel: '統計期間', value: range, options: RANGES, onChange: (v) => { range = v; load(); } });
  const refreshBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => load() }, icon('refresh', 'ic-sm'), '重新整理');
  const tableBtn = h('button', { type: 'button', class: 'btn btn-sm', 'aria-pressed': 'false', onclick: () => { showTable = !showTable; renderChartArea(); } },
    icon('table', 'ic-sm'), '表格');

  const statsEl = h('div', { class: 'stats' });
  const chartArea = h('div', { class: 'card-body' });
  const chartCard = h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', null, icon('chart'), '每日 token 用量'),
      h('span', { class: 'card-sub' }, '計費 token'),
      h('div', { class: 'card-head-actions' }, tableBtn),
    ),
    chartArea,
  );
  const breakdown = h('div', { class: 'grid grid-3' });
  const body = h('div', { class: 'page' }, statsEl, chartCard, breakdown);

  ctx.setActions(refreshBtn);
  root.append(h('div', { class: 'toolbar' }, rangeSeg), body);
  body.replaceChildren(loadingState());
  ctx.onCleanup(() => chart?.destroy());

  async function load() {
    const token = ++loadToken;
    if (data) body.classList.add('is-refreshing'); // 重新讀取時保留原本的畫面，只淡化
    try {
      const next = await api.get(qs('/api/ai/usage', { days: range }));
      if (token !== loadToken || ctx.disposed) return;
      data = next;
      render();
    } catch (err) {
      if (token !== loadToken || ctx.disposed) return;
      if (!data) body.replaceChildren(errorState(err, load));
      else toastError(err);
    } finally {
      if (token === loadToken) body.classList.remove('is-refreshing');
    }
  }

  function render() {
    if (!statsEl.isConnected) body.replaceChildren(statsEl, chartCard, breakdown);
    const days = data.days;
    const total = sum(days.map((d) => d.total));
    const today = days[days.length - 1];
    const budget = data.limits.dailyBudget;

    let meter = null;
    if (budget > 0) {
      const ratio = today.total.billable / budget;
      meter = h('div', {
        class: ['meter', ratio >= 1 ? 'is-bad' : ratio >= 0.8 && 'is-warn'],
        role: 'meter', 'aria-label': '今日 token 預算使用量',
        'aria-valuemin': 0, 'aria-valuemax': budget, 'aria-valuenow': Math.min(today.total.billable, budget),
      }, h('span'));
      setVar(meter, '--w', `${Math.min(100, ratio * 100)}%`);
    }

    statsEl.replaceChildren(
      stat('期間計費 tokens', fmtCompact(total.billable),
        `輸入 ${fmtCompact(total.prompt - total.toolUse)}・輸出 ${fmtCompact(total.output + total.thoughts)}`),
      stat('呼叫次數', fmtInt(total.calls), total.calls ? `平均每次 ${fmtInt(total.billable / total.calls)} tokens` : '這段期間沒有呼叫'),
      stat('Google 搜尋', `${fmtInt(total.searches)} 次`, '依搜尋次數計費'),
      stat('今天', `${fmtCompact(today.total.billable)} tokens`,
        budget > 0 ? `全體每日上限 ${fmtCompact(budget)}（${fmtPercent(today.total.billable / budget)}）` : `${fmtInt(today.total.calls)} 次呼叫・未設每日上限`,
        meter),
    );

    renderChartArea();
    renderBreakdown(days);
  }

  function renderChartArea() {
    tableBtn.setAttribute('aria-pressed', String(showTable));
    tableBtn.classList.toggle('is-active', showTable);
    if (!data) return;
    const series = data.days.map((d) => ({ key: d.date, label: fmtDayKey(d.date), value: d.total.billable }));

    if (showTable) {
      chart?.destroy();
      chart = null;
      chartArea.replaceChildren(h('div', { class: 'table-wrap' }, h('table', { class: 'table table-stack' },
        h('caption', { class: 'sr-only' }, '每日 token 用量'),
        h('thead', null, h('tr', null,
          h('th', null, '日期'), h('th', { class: 'num' }, '計費 tokens'), h('th', { class: 'num' }, '呼叫'),
          h('th', { class: 'num' }, '搜尋'), h('th', { class: 'num' }, '輸入'), h('th', { class: 'num' }, '輸出'),
        )),
        h('tbody', null, [...data.days].reverse().map((d) => h('tr', null,
          h('td', null, fmtDayKey(d.date, true)),
          h('td', { class: 'num', 'data-label': '計費 tokens' }, fmtInt(d.total.billable)),
          h('td', { class: 'num', 'data-label': '呼叫' }, fmtInt(d.total.calls)),
          h('td', { class: 'num', 'data-label': '搜尋' }, fmtInt(d.total.searches)),
          h('td', { class: 'num', 'data-label': '輸入' }, fmtInt(d.total.prompt - d.total.toolUse)),
          h('td', { class: 'num', 'data-label': '輸出' }, fmtInt(d.total.output + d.total.thoughts)),
        ))),
      )));
      return;
    }

    // 同樣天數只更新資料（畫面不閃）；換了期間就重建，圖表的說明文字才會跟著變
    if (chart?.isConnected && chart.days === series.length) {
      chart.update(series);
      return;
    }
    chart?.destroy();
    chart = columnChart({
      data: series,
      label: `近 ${data.days.length} 天每日計費 token`,
      formatTick: fmtCompact,
      formatValue: fmtCompact,
      tooltip: (d, i) => {
        const day = data.days[i];
        const sources = Object.entries(day.bySource).filter(([, b]) => b.billable > 0).sort((a, b) => b[1].billable - a[1].billable);
        return h('div', null,
          h('div', { class: 'tip-value' }, `${fmtInt(d.value)} tokens`),
          h('div', { class: 'tip-label' }, fmtDayKey(d.key, true)),
          h('div', { class: 'tip-rows' },
            tipRow('呼叫', `${fmtInt(day.total.calls)} 次`),
            day.total.searches ? tipRow('Google 搜尋', `${fmtInt(day.total.searches)} 次`) : null,
            sources.map(([k, b]) => tipRow(SOURCE_LABEL[k] ?? k, fmtCompact(b.billable))),
          ),
        );
      },
    });
    chart.days = series.length;
    chartArea.replaceChildren(chart);
  }

  function breakdownCard(title, iconName, entries, nameOf, { limit } = {}) {
    const grand = entries.reduce((s, [, b]) => s + b.billable, 0);
    const shown = limit ? entries.slice(0, limit) : entries;
    const rest = limit ? entries.slice(limit) : [];
    const rows = shown.map(([key, b]) => {
      const bar = h('div', { class: 'share-bar' }, h('span'));
      setVar(bar, '--w', `${grand ? (b.billable / grand) * 100 : 0}%`);
      return h('tr', null,
        h('td', null, nameOf(key)),
        h('td', { class: 'num' }, fmtInt(b.calls)),
        h('td', { class: 'num' }, fmtCompact(b.billable)),
        h('td', { class: 'share-cell' }, bar, h('span', { class: 'sr-only' }, fmtPercent(grand ? b.billable / grand : 0))),
      );
    });
    if (rest.length) {
      const r = sum(rest.map(([, b]) => b));
      rows.push(h('tr', null,
        h('td', { class: 'hint' }, `其他 ${rest.length} 位`),
        h('td', { class: 'num' }, fmtInt(r.calls)),
        h('td', { class: 'num' }, fmtCompact(r.billable)),
        h('td'),
      ));
    }
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, icon(iconName), title)),
      entries.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null, h('th', null, '項目'), h('th', { class: 'num' }, '呼叫'), h('th', { class: 'num' }, 'tokens'), h('th', null, '佔比'))),
          h('tbody', null, rows),
        ))
        : emptyState('沒有資料'),
    );
  }

  function renderBreakdown(days) {
    const userName = (id) => {
      const u = data.users[id];
      return h('div', { class: 'user-cell' },
        avatar({ url: u?.avatarUrl, name: u?.name, size: 'sm' }),
        h('span', { class: 'truncate' }, u && !u.missing ? u.name : id),
      );
    };
    const modeName = (key) => {
      const name = data.modeNames[key];
      return name ? `${name}` : `${key}（已刪除）`;
    };
    breakdown.replaceChildren(
      breakdownCard('依來源', 'message', groupTotals(days, 'bySource'), (k) => SOURCE_LABEL[k] ?? k),
      breakdownCard('依人格', 'sparkle', groupTotals(days, 'byMode'), modeName),
      breakdownCard('依使用者', 'user', groupTotals(days, 'byUser'), userName, { limit: MAX_USERS }),
    );
  }

  // 主題切換時圖表的顏色由 CSS 變數處理，不需要重畫
  load();
}
