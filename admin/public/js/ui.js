// 共用的介面元件：Toast、對話框、開關、分段選擇、頭像、各種狀態畫面

import { h, icon } from './dom.js';

// ── Toast ──────────────────────────────────────────────
export function toast(message, { type = 'success', timeout = 3200 } = {}) {
  const box = document.getElementById('toasts');
  const iconName = type === 'error' ? 'alert' : type === 'info' ? 'info' : 'check';
  const el = h('div', { class: ['toast', `toast-${type}`], role: type === 'error' ? 'alert' : null }, icon(iconName), h('span', null, message));
  box.append(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  }, type === 'error' ? Math.max(timeout, 5000) : timeout);
}

export const toastError = (err) => toast(err?.message || String(err), { type: 'error' });

// ── 對話框（原生 <dialog>：焦點鎖定、Esc 關閉都由瀏覽器處理）────
/**
 * @param {{ title: string, body: Node|Node[], footer?: Node[], wide?: boolean, onClose?: () => void,
 *           beforeClose?: () => boolean | Promise<boolean> }} opts
 * beforeClose：使用者按 ×、Esc 或點背景時先問它，回傳 false 就不關閉（程式呼叫 close() 不受影響）
 */
export function openModal({ title, body, footer, wide = false, onClose, beforeClose }) {
  const closeBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': '關閉' }, icon('x'));
  const dialog = h('dialog', { class: ['modal', wide && 'modal-wide'] },
    h('div', { class: 'modal-head' }, h('h2', null, title), closeBtn),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null,
  );
  const close = () => { if (dialog.open) dialog.close(); };
  const requestClose = async () => {
    if (!beforeClose || await beforeClose()) close();
  };
  closeBtn.addEventListener('click', requestClose);
  // 點背景關閉（點在 dialog 本身而不是內容上）
  dialog.addEventListener('click', (e) => { if (e.target === dialog) requestClose(); });
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); requestClose(); });
  dialog.addEventListener('close', () => { dialog.remove(); onClose?.(); });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

/** 確認對話框，回傳 Promise<boolean> */
export function confirmDialog({ title, message, confirmText = '確定', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const ok = h('button', { type: 'button', class: ['btn', danger ? 'btn-danger-solid' : 'btn-primary'] }, confirmText);
    const cancel = h('button', { type: 'button', class: 'btn' }, '取消');
    const modal = openModal({
      title,
      body: h('p', { class: 'confirm-text' }, message),
      footer: [h('span', { class: 'spacer' }), cancel, ok],
      onClose: () => resolve(result),
    });
    ok.addEventListener('click', () => { result = true; modal.close(); });
    cancel.addEventListener('click', () => modal.close());
    ok.focus();
  });
}

/** 執行非同步動作時讓按鈕顯示轉圈、暫時停用；失敗時顯示錯誤 Toast，回傳是否成功 */
export async function withBusy(button, fn) {
  const original = [...button.childNodes];
  button.disabled = true;
  button.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), ...original.filter((n) => n.nodeType === Node.TEXT_NODE));
  try {
    await fn();
    return true;
  } catch (err) {
    toastError(err);
    return false;
  } finally {
    if (button.isConnected) {
      button.replaceChildren(...original);
      button.disabled = false;
    }
  }
}

// ── 開關 ───────────────────────────────────────────────
/**
 * 切換時呼叫 onChange(checked)；回傳的 Promise 失敗會自動切回原狀並顯示錯誤
 */
export function switchControl({ checked, label, ariaLabel, onChange, disabled = false }) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked: !!checked, disabled, 'aria-label': label ? null : ariaLabel });
  const el = h('label', { class: 'switch' },
    input,
    h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
    label ? h('span', { class: 'switch-label' }, label) : null,
  );
  input.addEventListener('change', async () => {
    const next = input.checked;
    input.disabled = true;
    try {
      await onChange(next);
    } catch (err) {
      input.checked = !next;
      toastError(err);
    } finally {
      input.disabled = disabled;
    }
  });
  el.input = input;
  return el;
}

// ── 分段選擇 ───────────────────────────────────────────
/**
 * @param {{ options: Array<{ value: any, label: string, icon?: string }>, value: any,
 *           onChange?: (value) => any, ariaLabel: string, small?: boolean }} opts
 * onChange 回傳的 Promise 失敗時會切回原本的選項
 */
export function segmented({ options, value, onChange, ariaLabel, small = false }) {
  let current = value;
  const group = h('div', { class: ['seg', small && 'seg-sm'], role: 'radiogroup', 'aria-label': ariaLabel });
  const buttons = options.map((opt) => h('button', {
    type: 'button',
    class: 'seg-btn',
    role: 'radio',
    'aria-checked': String(opt.value === value),
    onclick: () => select(opt.value),
  }, opt.icon ? icon(opt.icon, 'ic-sm') : null, opt.label));
  group.append(...buttons);

  function mark(v) {
    current = v;
    options.forEach((opt, i) => buttons[i].setAttribute('aria-checked', String(opt.value === v)));
  }

  async function select(v) {
    if (v === current) return;
    const prev = current;
    mark(v);
    try {
      await onChange?.(v);
    } catch (err) {
      mark(prev);
      toastError(err);
    }
  }

  group.setValue = mark;
  return group;
}

// ── 頭像 ───────────────────────────────────────────────
export function avatar({ url, name, size = '', square = false }) {
  const cls = ['avatar', size && `avatar-${size}`, square && 'avatar-square'];
  if (url) return h('img', { class: cls, src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  const initial = (name || '?').trim().slice(0, 1).toUpperCase() || '?';
  return h('span', { class: cls, 'aria-hidden': 'true' }, initial);
}

/** 使用者顯示：頭像＋名稱＋ @帳號 / ID */
export function userCell(user) {
  const missing = !user || user.missing;
  return h('div', { class: 'user-cell' },
    avatar({ url: user?.avatarUrl, name: user?.name, size: 'sm' }),
    h('div', { class: 'row-main' },
      h('div', { class: 'user-cell-name truncate' }, missing ? '（找不到使用者）' : user.name),
      h('div', { class: 'user-cell-sub mono truncate' }, missing ? user?.id ?? '' : `@${user.username} · ${user.id}`),
    ),
  );
}

// ── 狀態標籤 ───────────────────────────────────────────
/** kind：good / warn / bad / neutral；顏色一定搭配文字 */
export function statusBadge(kind, text) {
  const cls = { good: 'badge-good', warn: 'badge-warn', bad: 'badge-bad', accent: 'badge-accent' }[kind];
  return h('span', { class: ['badge', cls] }, h('span', { class: ['dot', kind !== 'neutral' && kind !== 'accent' && `dot-${kind}`] }), text);
}

// ── 狀態畫面 ───────────────────────────────────────────
export const loadingState = (text = '載入中…') =>
  h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);

export const emptyState = (text, iconName = 'info') =>
  h('div', { class: 'empty' }, icon(iconName), h('div', null, text));

export function errorState(err, retry) {
  return h('div', { class: 'error-box', role: 'alert' },
    icon('alert'),
    h('div', null, err?.message || '載入失敗'),
    retry ? h('button', { type: 'button', class: 'btn', onclick: retry }, icon('refresh'), '重試') : null,
  );
}

export function card({ title, sub, actions, body, foot, note, iconName, tight = false, className }) {
  return h('section', { class: ['card', className] },
    title ? h('div', { class: 'card-head' },
      h('h2', null, iconName ? icon(iconName) : null, title),
      sub ? h('span', { class: 'card-sub' }, sub) : null,
      actions ? h('div', { class: 'card-head-actions' }, actions) : null,
    ) : null,
    body !== undefined ? h('div', { class: ['card-body', tight && 'tight'] }, body) : null,
    foot ? h('div', { class: 'card-foot' }, foot) : null,
    note ? h('div', { class: 'card-note' }, icon('info', 'ic-sm'), h('span', null, note)) : null,
  );
}

/** 有頭有尾的 <select>；groups：[{ label, options: [{ value, label }] }] */
export function selectEl({ groups, options, value, placeholder, ariaLabel, onchange, className }) {
  const sel = h('select', { class: ['select', className], 'aria-label': ariaLabel, onchange });
  if (placeholder) sel.append(h('option', { value: '' }, placeholder));
  const opt = (o) => h('option', { value: o.value, disabled: !!o.disabled }, o.label);
  if (groups) for (const g of groups) sel.append(h('optgroup', { label: g.label }, g.options.map(opt)));
  if (options) sel.append(...options.map(opt));
  sel.value = value ?? '';
  return sel;
}
