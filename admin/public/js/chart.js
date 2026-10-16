// 單一系列的直條圖（SVG）。
// 規格：長條最寬 24px、頂端 4px 圓角、底部貼齊基準線；格線是實線細線；只標註最高的那一根；
// 每根長條的整個欄位都是滑鼠感應區，提示框以數值為主；鍵盤可用方向鍵逐根查看；寬度改變時自動重畫。

import { h, svg } from './dom.js';

const M = { top: 22, right: 8, bottom: 26, left: 52 };
const MAX_BAR = 24;
const RADIUS = 4;
const MIN_GAP = 2;

function niceScale(max, ticks = 4) {
  if (!(max > 0)) return { top: 1000, step: 250 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  return { step, top: Math.ceil(max / step) * step };
}

// 只有上方兩角是圓角
function barPath(x, y, w, hgt) {
  const r = Math.min(RADIUS, w / 2, hgt);
  return `M${x},${y + hgt}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + hgt}Z`;
}

/**
 * @param {{ data: Array<{ key: string, label: string, value: number }>, height?: number, label: string,
 *           formatTick: (v: number) => string, formatValue: (v: number) => string, tooltip: (d, i) => Node }} opts
 * @returns {HTMLElement & { update(data): void, destroy(): void }}
 */
export function columnChart({ data, height = 240, label, formatTick, formatValue, tooltip }) {
  const root = h('div', { class: 'chart' });
  const tip = h('div', { class: 'chart-tip', hidden: true, 'aria-hidden': 'true' });
  const plot = svg('svg', {
    class: 'plot', role: 'img', tabindex: '0', height,
    'aria-label': `${label}（按方向鍵逐日查看）`,
  });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  root.append(plot, tip, live);

  let width = 0;
  let active = -1;
  let geo = null;
  let bars = [];

  function render() {
    width = root.clientWidth;
    if (!width || !data.length) return;
    const plotW = Math.max(10, width - M.left - M.right);
    const plotH = height - M.top - M.bottom;
    const baseY = M.top + plotH;
    const max = Math.max(0, ...data.map((d) => d.value));
    const { step, top } = niceScale(max);
    const yOf = (v) => baseY - (v / top) * plotH;
    const slot = plotW / data.length;
    let barW = Math.min(MAX_BAR, slot * 0.64);
    if (slot - barW < MIN_GAP) barW = Math.max(1, slot - MIN_GAP);

    plot.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const nodes = [];

    for (let v = 0; v <= top + step / 2; v += step) {
      const y = Math.round(yOf(v)) + 0.5;
      nodes.push(svg('line', { class: v === 0 ? 'baseline' : 'grid-line', x1: M.left, x2: width - M.right, y1: y, y2: y }));
      nodes.push(svg('text', { class: 'tick', x: M.left - 8, y, 'text-anchor': 'end', 'dominant-baseline': 'middle' }, formatTick(v)));
    }

    // X 軸標籤：從最右邊（最新的一天）往回每隔幾天標一個，避免擠在一起
    const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotW / 48))));
    data.forEach((d, i) => {
      if ((data.length - 1 - i) % every !== 0) return;
      nodes.push(svg('text', { class: 'tick', x: M.left + slot * i + slot / 2, y: height - 6, 'text-anchor': 'middle' }, d.label));
    });

    bars = data.map((d, i) => {
      if (!(d.value > 0)) return null;
      const x = M.left + slot * i + (slot - barW) / 2;
      const hgt = Math.max(1, baseY - yOf(d.value));
      return svg('path', { class: 'bar', d: barPath(x, baseY - hgt, barW, hgt) });
    });

    // 只標註最高的一根（同高時取最新的）
    if (max > 0) {
      let peak = -1;
      data.forEach((d, i) => { if (d.value === max) peak = i; });
      const cx = M.left + slot * peak + slot / 2;
      nodes.push(svg('text', {
        class: 'peak-label', 'text-anchor': 'middle',
        x: Math.min(Math.max(cx, M.left + 20), width - M.right - 20), y: yOf(max) - 7,
      }, formatValue(max)));
    }

    const hits = data.map((d, i) => svg('rect', {
      class: 'hit', x: M.left + slot * i, y: M.top - 8, width: slot, height: plotH + 8,
      onpointerenter: () => setActive(i),
      onpointerdown: () => setActive(i),
    }));

    plot.replaceChildren(...nodes, ...bars.filter(Boolean), ...hits);
    geo = { slot, barW, yOf };
    if (active >= data.length) active = data.length - 1;
    if (active >= 0) setActive(active);
  }

  function setActive(i) {
    active = i;
    root.classList.toggle('has-active', i >= 0);
    bars.forEach((b, j) => b?.classList.toggle('is-active', j === i));
    if (i < 0 || !geo) {
      tip.hidden = true;
      return;
    }
    tip.replaceChildren(tooltip(data[i], i));
    tip.hidden = false;
    live.textContent = tip.textContent;

    const cx = M.left + geo.slot * i + geo.slot / 2;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = cx + geo.barW / 2 + 10;
    if (left + tw > width) left = cx - geo.barW / 2 - 10 - tw;
    left = Math.max(0, Math.min(left, width - tw));
    const top = Math.max(0, Math.min(geo.yOf(data[i].value) - th / 2, height - th));
    tip.style.setProperty('left', `${left}px`);
    tip.style.setProperty('top', `${top}px`);
  }

  plot.addEventListener('pointerleave', () => { if (document.activeElement !== plot) setActive(-1); });
  plot.addEventListener('focus', () => { if (active < 0) setActive(data.length - 1); });
  plot.addEventListener('blur', () => setActive(-1));
  plot.addEventListener('keydown', (e) => {
    const last = data.length - 1;
    const moves = { ArrowLeft: Math.max(0, active - 1), ArrowRight: Math.min(last, active + 1), Home: 0, End: last };
    if (e.key in moves) {
      e.preventDefault();
      setActive(moves[e.key]);
    } else if (e.key === 'Escape') {
      setActive(-1);
    }
  });

  const ro = new ResizeObserver(() => { if (root.clientWidth !== width) render(); });
  ro.observe(root);

  root.update = (next) => {
    data = next;
    render();
  };
  root.destroy = () => ro.disconnect();
  queueMicrotask(render);
  return root;
}
