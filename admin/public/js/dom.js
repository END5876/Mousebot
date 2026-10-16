// 建立 DOM 的小工具。
// 所有文字一律以文字節點插入，不用 innerHTML 拼接——伺服器名稱、回應內容、log 都是外部資料。

const SVG_NS = 'http://www.w3.org/2000/svg';
// 這些要設成 DOM 屬性（property）而不是 HTML 屬性，false 也要能正確套用
const PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'hidden', 'readOnly', 'required', 'indeterminate']);

function applyProps(el, props) {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (PROPS.has(key)) { el[key] = value; continue; }
    if (value == null || value === false) continue;
    if (key === 'class') {
      const cls = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
      if (cls) el.setAttribute('class', cls);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'style') {
      // CSSOM 設定不受 CSP 的 style-src 限制（setAttribute('style') 會被擋）
      for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value);
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

/** 加入子節點：字串 / 數字變成文字節點，陣列會攤平，null / false 略過 */
export function append(parent, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    parent.append(child instanceof Node ? child : String(child));
  }
  return parent;
}

/** 清空後重新放入子節點；與原生 replaceChildren 不同，null / false 會被略過（原生會變成文字「null」） */
export function fill(parent, ...children) {
  parent.replaceChildren();
  return append(parent, children);
}

/**
 * h('button', { class: 'btn', onclick }, '文字', icon('plus'))
 * 事件用小寫：onclick、oninput、onchange、onkeydown…
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  return append(el, children);
}

export function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, attrs);
  return append(el, children);
}

/** 線條圖示，對應 index.html 裡的 <symbol id="i-名稱"> */
export function icon(name, cls) {
  return svg('svg', { class: cls ? `ic ${cls}` : 'ic', 'aria-hidden': 'true', focusable: 'false' },
    svg('use', { href: `#i-${name}` }));
}

export function logo() {
  return svg('svg', { class: 'logo', viewBox: '0 0 32 32', 'aria-hidden': 'true' }, svg('use', { href: '#i-logo' }));
}

/** 設定 CSS 自訂屬性（例如長條寬度 --w） */
export function setVar(el, name, value) {
  el.style.setProperty(name, value);
  return el;
}
