// 管理面板進入點：登入畫面、側邊欄、網址 hash 路由（#/overview）、各頁面的生命週期

import { fill, h, icon, logo } from './dom.js';
import { api, setUnauthorizedHandler } from './api.js';
import { avatar, confirmDialog, toastError } from './ui.js';
import overview from './pages/overview.js';
import responses from './pages/responses.js';
import prompts from './pages/prompts.js';
import aiSettings from './pages/aiSettings.js';
import usage from './pages/usage.js';
import voice from './pages/voice.js';
import notify from './pages/notify.js';
import logs from './pages/logs.js';

const THEME_KEY = 'mousebot-admin-theme';
const THEME_COLORS = { light: '#F3F4F7', dark: '#1E1F22' };

const NAV = [
  { items: [{ id: 'overview', title: '總覽', sub: 'Bot 狀態一覽', icon: 'home', mount: overview }] },
  {
    label: '對話',
    items: [
      { id: 'responses', title: '自訂回應', sub: '關鍵字自動回覆', icon: 'message', mount: responses },
      { id: 'prompts', title: 'AI 人格', sub: '各模式的 system prompt', icon: 'sparkle', mount: prompts },
      { id: 'ai', title: 'AI 設定', sub: '使用者模式、隨機插話', icon: 'sliders', mount: aiSettings },
      { id: 'usage', title: 'AI 用量', sub: 'Gemini token 統計', icon: 'chart', mount: usage },
    ],
  },
  {
    label: '語音與通知',
    items: [
      { id: 'voice', title: '語音與音樂', sub: '播放控制、自動加入', icon: 'headphones', mount: voice },
      { id: 'notify', title: '通知與報時', sub: '限免通知、整點報時', icon: 'bell', mount: notify },
    ],
  },
  { label: '系統', items: [{ id: 'logs', title: '日誌', sub: '最近的執行紀錄', icon: 'terminal', mount: logs }] },
];
const PAGES = new Map(NAV.flatMap((g) => g.items).map((p) => [p.id, p]));

const root = document.getElementById('app');
let shell = null;      // { app, nav, title, sub, actions, content, botChip }
let current = null;    // { id, ctx }
let suppressHash = false;

// ════════════════════════════════════════════════════════
//  主題
// ════════════════════════════════════════════════════════
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
  document.dispatchEvent(new CustomEvent('themechange'));
}

function themeButton() {
  const btn = h('button', { type: 'button', class: 'btn btn-sm' });
  const paint = () => {
    const dark = currentTheme() === 'dark';
    btn.replaceChildren(icon(dark ? 'sun' : 'moon', 'ic-sm'), dark ? '淺色' : '深色');
    btn.setAttribute('aria-label', dark ? '切換成淺色主題' : '切換成深色主題');
  };
  btn.addEventListener('click', () => { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); paint(); });
  paint();
  return btn;
}

// ════════════════════════════════════════════════════════
//  登入
// ════════════════════════════════════════════════════════
function showLogin(message = '') {
  disposePage();
  shell = null;
  const input = h('input', {
    class: 'input', type: 'password', id: 'password', autocomplete: 'current-password', required: true,
    placeholder: 'ADMIN_PASSWORD',
  });
  const error = h('div', { class: 'login-error', role: 'alert' }, message);
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, '登入');

  const form = h('form', { class: 'card login-card', novalidate: true },
    h('div', { class: 'login-brand' },
      h('div', { class: 'brand-mark' }, logo()),
      h('h1', null, 'Mousebot 管理面板'),
      h('p', { class: 'hint' }, '請輸入在 .env 設定的 ADMIN_PASSWORD'),
    ),
    h('div', { class: 'field' }, h('label', { for: 'password' }, '密碼'), input),
    error,
    submit,
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value) { error.textContent = '請輸入密碼'; input.focus(); return; }
    submit.disabled = true;
    error.textContent = '';
    try {
      await api.post('/api/login', { password: input.value });
      startApp();
    } catch (err) {
      error.textContent = err.message;
      input.select();
    } finally {
      submit.disabled = false;
    }
  });

  root.className = '';
  root.removeAttribute('aria-busy');
  root.replaceChildren(h('main', { class: 'login-wrap' }, form));
  input.focus();
}

async function logout() {
  if (current?.ctx.isDirty() && !await confirmDialog({ title: '還有未儲存的變更', message: '登出後這些變更會遺失，確定要登出嗎？', confirmText: '登出' })) return;
  try { await api.post('/api/logout'); } catch {}
  showLogin('已登出');
}

// ════════════════════════════════════════════════════════
//  外框
// ════════════════════════════════════════════════════════
function buildShell() {
  const navEl = h('nav', { class: 'nav', 'aria-label': '主選單' });
  for (const group of NAV) {
    if (group.label) navEl.append(h('div', { class: 'nav-label' }, group.label));
    for (const page of group.items) {
      navEl.append(h('a', { href: `#/${page.id}`, dataset: { page: page.id } }, icon(page.icon), page.title));
    }
  }

  const botChip = h('div', { class: 'bot-chip' });
  const title = h('h1');
  const sub = h('div', { class: 'topbar-sub' });
  const actions = h('div', { class: 'topbar-actions' });
  const content = h('div', { class: 'content', id: 'content' });
  const app = h('div', { class: 'app' });

  const closeNav = () => app.classList.remove('nav-open');
  navEl.addEventListener('click', (e) => { if (e.target.closest('a')) closeNav(); });

  app.append(
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' },
        h('div', { class: 'brand-mark' }, logo()),
        h('div', null, h('div', { class: 'brand-name' }, 'Mousebot'), h('div', { class: 'brand-sub' }, '管理面板')),
      ),
      navEl,
      h('div', { class: 'sidebar-foot' },
        botChip,
        h('div', { class: 'sidebar-actions' },
          themeButton(),
          h('button', { type: 'button', class: 'btn btn-sm', onclick: logout }, icon('logout', 'ic-sm'), '登出'),
        ),
      ),
    ),
    h('div', { class: 'nav-scrim', onclick: closeNav }),
    h('div', { class: 'main' },
      h('header', { class: 'topbar' },
        h('button', {
          type: 'button', class: 'btn btn-ghost btn-icon menu-btn', 'aria-label': '開啟選單',
          onclick: () => app.classList.add('nav-open'),
        }, icon('menu')),
        h('div', { class: 'row-main' }, title, sub),
        actions,
      ),
      h('main', { class: 'content-wrap' }, content),
    ),
  );

  root.className = '';
  root.removeAttribute('aria-busy');
  root.replaceChildren(app);
  return { app, nav: navEl, title, sub, actions, content, botChip };
}

function paintBotChip(me) {
  if (!shell) return;
  const bot = me?.bot;
  const status = !me ? ['bad', '無法連線'] : me.ready ? ['good', `線上 · ${me.ping >= 0 ? `${me.ping} ms` : '—'}`] : ['warn', '連線中…'];
  shell.botChip.replaceChildren(
    avatar({ url: bot?.avatarUrl, name: bot?.name || 'M' }),
    h('div', { class: 'row-main' },
      h('div', { class: 'bot-chip-name' }, bot?.name || 'Mousebot'),
      h('div', { class: 'bot-chip-status' }, h('span', { class: ['dot', `dot-${status[0]}`] }), status[1]),
    ),
  );
}

async function refreshBotChip() {
  try {
    paintBotChip(await api.get('/api/me'));
  } catch (err) {
    if (err.status !== 401) paintBotChip(null);
  }
}

// ════════════════════════════════════════════════════════
//  頁面生命週期
// ════════════════════════════════════════════════════════
function createCtx() {
  const cleanups = new Set();
  let dirty = false;
  let disposed = false;

  return {
    /** 定期執行 fn（分頁在背景時暫停）；回傳停止函式。頁面切換時自動停止 */
    poll(fn, ms) {
      let timer = null;
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        if (!document.hidden) {
          try { await fn(); } catch {}
        }
        if (!stopped) timer = setTimeout(tick, ms);
      };
      timer = setTimeout(tick, ms);
      const stop = () => { stopped = true; clearTimeout(timer); };
      cleanups.add(stop);
      return stop;
    },
    onCleanup(fn) { cleanups.add(fn); },
    setDirty(v) { dirty = !!v; },
    isDirty: () => dirty,
    get disposed() { return disposed; },
    setActions(...nodes) { if (shell) fill(shell.actions, nodes); },
    refreshBotChip,
    dispose() {
      disposed = true;
      for (const fn of cleanups) { try { fn(); } catch {} }
      cleanups.clear();
    },
  };
}

function disposePage() {
  current?.ctx.dispose();
  current = null;
}

function pageIdFromHash() {
  const id = location.hash.replace(/^#\/?/, '').split('/')[0];
  return PAGES.has(id) ? id : 'overview';
}

async function route() {
  if (suppressHash) { suppressHash = false; return; }
  if (!shell) return;
  const id = pageIdFromHash();
  if (current?.id === id) return;

  if (current?.ctx.isDirty()) {
    const leave = await confirmDialog({ title: '還有未儲存的變更', message: '離開這一頁後，尚未儲存的內容會遺失。確定要離開嗎？', confirmText: '離開' });
    if (!leave) {
      suppressHash = true;
      location.hash = `#/${current.id}`;
      return;
    }
  }

  disposePage();
  const page = PAGES.get(id);
  shell.title.textContent = page.title;
  shell.sub.textContent = page.sub;
  shell.actions.replaceChildren();
  document.title = `${page.title} · Mousebot 管理面板`;
  for (const a of shell.nav.querySelectorAll('a')) {
    if (a.dataset.page === id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }

  const ctx = createCtx();
  current = { id, ctx };
  const container = h('div', { class: 'page' });
  shell.content.replaceChildren(container);
  window.scrollTo(0, 0);
  try {
    page.mount(container, ctx);
  } catch (err) {
    toastError(err);
  }
}

function startApp() {
  shell = buildShell();
  refreshBotChip();
  current = null;
  route();
}

// ════════════════════════════════════════════════════════
//  啟動
// ════════════════════════════════════════════════════════
setUnauthorizedHandler(() => { if (shell) showLogin('登入已過期，請重新登入'); });
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => {
  if (current?.ctx.isDirty()) { e.preventDefault(); e.returnValue = ''; }
});
// 側邊欄的 Bot 狀態每分鐘更新一次
setInterval(() => { if (shell && !document.hidden) refreshBotChip(); }, 60 * 1000);

(async () => {
  try {
    await api.get('/api/me');
    startApp();
  } catch (err) {
    if (err.status === 401) showLogin();
    else {
      root.className = '';
      root.replaceChildren(h('main', { class: 'login-wrap' }, h('div', { class: 'card login-card' },
        h('div', { class: 'error-box' }, icon('alert'), h('div', null, err.message),
          h('button', { type: 'button', class: 'btn', onclick: () => location.reload() }, icon('refresh'), '重新整理')))));
    }
  }
})();
