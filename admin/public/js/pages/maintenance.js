// 維護：Slash 指令同步、音樂快取、設定備份、重新啟動

import { h, icon, setVar } from '../dom.js';
import { api, ApiError } from '../api.js';
import { fmtDateTime, fmtDuration, fmtInt } from '../format.js';
import { card, confirmDialog, errorState, loadingState, statusBadge, toast, withBusy } from '../ui.js';

const RESTART_POLL_MS = 2000;
const RESTART_TIMEOUT_MS = 3 * 60 * 1000;

export default function mountMaintenance(root, ctx) {
  const commandsSlot = h('div', null, loadingState());
  const cacheSlot = h('div', null, loadingState());
  const backupSlot = h('div');
  const restartSlot = h('div', null, loadingState());
  root.append(commandsSlot, h('div', { class: 'grid grid-2' }, cacheSlot, h('div', { class: 'page' }, backupSlot, restartSlot)));

  // ── Slash 指令 ───────────────────────────────────────────
  async function loadCommands() {
    try {
      const data = await api.get('/api/commands');
      if (!ctx.disposed) renderCommands(data);
    } catch (err) {
      if (!ctx.disposed) commandsSlot.replaceChildren(errorState(err, loadCommands));
    }
  }

  function renderCommands(d) {
    const remoteNames = new Set((d.remote || []).map((c) => c.name));
    const localNames = new Set(d.local.map((c) => c.name));
    const missing = d.remote ? d.local.filter((c) => !remoteNames.has(c.name)).map((c) => c.name) : [];
    const extra = d.remote ? d.remote.filter((c) => !localNames.has(c.name)).map((c) => c.name) : [];

    const syncBtn = h('button', { type: 'button', class: 'btn' }, icon('refresh', 'ic-sm'), '強制重新同步');
    syncBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '強制重新同步 Slash 指令',
        message: `把目前的 ${d.local.length} 個指令重新註冊到 Discord（${d.scope === 'global' ? '全域' : '測試伺服器'}）。\n全域指令可能要幾分鐘才會在所有客戶端更新。`,
        confirmText: '同步',
      });
      if (!ok) return;
      let res = null;
      const done = await withBusy(syncBtn, async () => { res = await api.post('/api/commands/sync'); });
      if (done) {
        toast(`已同步 ${res.count} 個指令到 Discord`);
        loadCommands();
      }
    });

    const rows = d.local.map((c) => h('tr', null,
      h('td', null, h('code', null, `/${c.name}`)),
      h('td', { 'data-label': '說明' }, c.description),
      h('td', { class: 'num', 'data-label': '子指令' }, c.subcommands ? fmtInt(c.subcommands) : '—'),
      h('td', { 'data-label': 'Discord' }, !d.remote ? h('span', { class: 'hint' }, '—')
        : remoteNames.has(c.name) ? statusBadge('good', '已註冊') : statusBadge('warn', '還沒註冊')),
    ));

    commandsSlot.replaceChildren(card({
      title: 'Slash 指令',
      sub: d.scope === 'global' ? '全域' : `測試伺服器（DEV_GUILD_ID）`,
      iconName: 'terminal',
      actions: [d.upToDate ? statusBadge('good', '與上次註冊一致') : statusBadge('warn', '本機有變更尚未同步'), syncBtn],
      tight: true,
      body: [
        d.remoteError ? h('div', { class: 'guild-block' }, h('div', { class: 'callout callout-warn' }, icon('alert', 'ic-sm'),
          h('span', null, `無法讀取 Discord 上的指令：${d.remoteError}`))) : null,
        missing.length || extra.length ? h('div', { class: 'guild-block' },
          missing.length ? h('div', { class: 'diff-list' }, h('span', { class: 'field-label' }, 'Discord 上還沒有：'), missing.map((n) => h('code', null, `/${n}`))) : null,
          extra.length ? h('div', { class: 'diff-list' }, h('span', { class: 'field-label' }, 'Discord 上多出來（已移除的指令）：'), extra.map((n) => h('code', null, `/${n}`))) : null,
        ) : null,
        h('div', { class: 'table-wrap' }, h('table', { class: 'table table-stack' },
          h('thead', null, h('tr', null, h('th', null, '指令'), h('th', null, '說明'), h('th', { class: 'num' }, '子指令'), h('th', null, 'Discord'))),
          h('tbody', null, rows),
        )),
      ],
      note: 'Bot 開機時會自動同步（內容沒變就略過）。只有 Discord 上看到的指令和這裡對不起來時，才需要強制重新同步。',
    }));
  }

  // ── 音樂快取 ─────────────────────────────────────────────
  async function loadCache() {
    try {
      const data = await api.get('/api/cache');
      if (!ctx.disposed) renderCache(data);
    } catch (err) {
      if (!ctx.disposed) cacheSlot.replaceChildren(errorState(err, loadCache));
    }
  }

  function renderCache(d) {
    const ratio = d.limitMB ? d.rootMB / d.limitMB : 0;
    const meter = h('div', {
      class: ['meter', ratio >= 1 ? 'is-bad' : ratio >= 0.8 && 'is-warn'],
      role: 'meter', 'aria-label': 'data/music 根目錄用量', 'aria-valuemin': 0, 'aria-valuemax': d.limitMB, 'aria-valuenow': Math.min(d.rootMB, d.limitMB),
    }, h('span'));
    setVar(meter, '--w', `${Math.min(100, ratio * 100)}%`);

    const clearBtn = h('button', { type: 'button', class: 'btn btn-danger', disabled: d.downloads.count === d.downloads.inUse }, icon('trash', 'ic-sm'), '清除下載快取');
    clearBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '清除下載快取',
        message: `刪除 ${d.downloads.count - d.downloads.inUse} 個線上歌曲的下載快取（約 ${d.downloads.sizeMB} MB）。\n本地音樂不會被刪；正在播放或排在佇列裡的歌會保留。之後再點同一首歌會重新下載。`,
        confirmText: '清除',
        danger: true,
      });
      if (!ok) return;
      let res = null;
      const done = await withBusy(clearBtn, async () => { res = await api.post('/api/cache/clear'); });
      if (!done) return;
      toast(`已刪除 ${res.deleted} 個檔案、釋放 ${res.freedMB} MB${res.skipped ? `（${res.skipped} 個使用中保留）` : ''}`);
      if (res.failed.length) toast(`有 ${res.failed.length} 個檔案刪不掉：${res.failed.slice(0, 3).join('、')}`, { type: 'error' });
      loadCache();
    });

    cacheSlot.replaceChildren(card({
      title: '音樂快取',
      sub: d.dir,
      iconName: 'folder',
      body: h('div', { class: 'form' },
        h('dl', { class: 'kv' },
          h('dt', null, '線上歌曲下載快取'),
          h('dd', null, `${fmtInt(d.downloads.count)} 個・${d.downloads.sizeMB} MB${d.downloads.inUse ? `（${d.downloads.inUse} 個使用中）` : ''}`),
          h('dt', null, '本地音樂'),
          h('dd', null, `${fmtInt(d.local.count)} 個・${d.local.sizeMB} MB`),
          d.temp.count ? h('dt', null, '下載中的暫存檔') : null,
          d.temp.count ? h('dd', null, `${fmtInt(d.temp.count)} 個・${d.temp.sizeMB} MB`) : null,
          d.downloads.oldest ? h('dt', null, '最舊的下載') : null,
          d.downloads.oldest ? h('dd', null, fmtDateTime(d.downloads.oldest)) : null,
        ),
        h('div', { class: 'field' },
          h('span', { class: 'field-label' }, `根目錄用量 ${d.rootMB} / ${fmtInt(d.limitMB)} MB（MAX_CACHE_SIZE_MB）`),
          meter,
        ),
        d.downloads.largest.length ? h('div', { class: 'field' },
          h('span', { class: 'field-label' }, '最大的下載快取'),
          h('div', { class: 'rows cache-list' }, d.downloads.largest.map((f) => h('div', { class: 'row' },
            h('div', { class: 'row-main' }, h('div', { class: 'truncate' }, f.name), h('div', { class: 'row-sub' }, fmtDateTime(f.modifiedAt))),
            h('span', { class: 'badge' }, `${f.sizeMB} MB`),
          ))),
        ) : null,
      ),
      foot: [h('span', { class: 'spacer' }), clearBtn],
      note: '根目錄的音訊檔超過上限時，Bot 會從最舊的開始自動刪除——包含直接放在 data/music 根目錄的本地音樂，自己的音樂建議放在子資料夾。',
    }));
  }

  // ── 設定備份 ─────────────────────────────────────────────
  function renderBackup() {
    const statsBox = h('input', { type: 'checkbox', id: 'backup-stats' });
    const downloadBtn = h('button', { type: 'button', class: 'btn btn-primary' }, icon('download', 'ic-sm'), '下載備份');
    downloadBtn.addEventListener('click', () => withBusy(downloadBtn, async () => {
      const res = await fetch(`/api/backup${statsBox.checked ? '?stats=1' : ''}`, {
        credentials: 'same-origin', cache: 'no-store', headers: { 'x-mousebot-admin': '1' },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new ApiError(res.status, data?.error || `下載失敗（HTTP ${res.status}）`);
      }
      const filename = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'mousebot-backup.json';
      const url = URL.createObjectURL(await res.blob());
      const a = h('a', { href: url, download: filename });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast(`已下載 ${filename}`);
    }));

    backupSlot.replaceChildren(card({
      title: '設定備份',
      iconName: 'download',
      body: h('div', { class: 'form' },
        h('p', { class: 'hint' }, '把 data/ 裡的設定打包成一個 JSON 檔：自訂回應、AI 人格與共用規則、使用者人格、插話機率、通知頻道、報時、自動加入、TTS 與 Bot 狀態設定。不包含任何金鑰與 Cookie。'),
        h('label', { class: 'check', for: 'backup-stats' }, statsBox, h('span', null, '一併包含統計資料（AI 用量、播放次數、通知紀錄、操作紀錄）')),
      ),
      foot: [h('span', { class: 'spacer' }), downloadBtn],
    }));
  }

  // ── 重新啟動 ─────────────────────────────────────────────
  async function loadSystem() {
    try {
      const sys = await api.get('/api/system');
      if (!ctx.disposed) renderRestart(sys);
    } catch (err) {
      if (!ctx.disposed) restartSlot.replaceChildren(errorState(err, loadSystem));
    }
  }

  function renderRestart(sys) {
    const btn = h('button', { type: 'button', class: 'btn btn-danger-solid' }, icon('power', 'ic-sm'), sys.supervised ? '重新啟動 Bot' : '關閉 Bot');
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: sys.supervised ? '重新啟動 Bot' : '關閉 Bot',
        message: sys.supervised
          ? 'Bot 會中斷連線約 10～60 秒後自動重新啟動。播放中的音樂會在重新啟動後接續播放。'
          : '目前不是由 supervisord 管理（例如用 npm start 或 start.bat 啟動），關閉後「不會」自動重新啟動，需要你手動再啟動。確定要關閉嗎？',
        confirmText: sys.supervised ? '重新啟動' : '關閉',
        danger: true,
      });
      if (!ok) return;
      const done = await withBusy(btn, () => api.post('/api/restart'));
      if (done) waitForRestart(sys);
    });

    restartSlot.replaceChildren(card({
      title: sys.supervised ? '重新啟動' : '關閉 Bot',
      iconName: 'power',
      body: h('dl', { class: 'kv' },
        h('dt', null, '已運行'), h('dd', null, fmtDuration(sys.uptimeSec)),
        h('dt', null, '程序管理'), h('dd', null, sys.supervised ? statusBadge('good', 'supervisord（會自動重新啟動）') : statusBadge('warn', '沒有 supervisor（關閉後不會自動啟動）')),
        h('dt', null, 'Node.js'), h('dd', { class: 'mono' }, `${sys.node}・PID ${sys.pid}`),
      ),
      foot: [h('span', { class: 'spacer' }), btn],
      note: '改了 .env（例如模型、額度、權限）之後，需要重新啟動才會生效。',
    }));
  }

  // 等 Bot 回來：/api/system 的運行時間變短代表已經是新的程序，再等它連上 Discord
  function waitForRestart(before) {
    const message = h('div', null, before.supervised ? '正在重新啟動 Bot…' : 'Bot 已關閉。');
    const sub = h('div', { class: 'hint' }, before.supervised ? '大約 10～60 秒，完成後這個畫面會自動關閉' : '手動重新啟動後，這個畫面會自動關閉');
    const overlay = h('div', { class: 'restart-overlay', role: 'alertdialog', 'aria-live': 'assertive' },
      h('div', { class: 'card restart-box' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), message, sub));
    document.body.append(overlay);
    const startedAt = Date.now();

    const finish = (text, ok) => {
      overlay.remove();
      if (ok) toast(text); else toast(text, { type: 'error' });
      ctx.refreshBotChip();
      if (!ctx.disposed) { loadCommands(); loadCache(); loadSystem(); }
    };

    const poll = async () => {
      if (Date.now() - startedAt > RESTART_TIMEOUT_MS && before.supervised) {
        finish('Bot 超過 3 分鐘還沒回來，請查看部署平台的 log', false);
        return;
      }
      try {
        const sys = await api.get('/api/system');
        if (sys.uptimeSec < before.uptimeSec || sys.pid !== before.pid) {
          const me = await api.get('/api/me');
          if (me.ready) {
            finish('Bot 已重新啟動', true);
            return;
          }
          message.textContent = '已重新啟動，正在連線 Discord…';
        }
      } catch (err) {
        if (err.status === 401) { overlay.remove(); return; } // 登入失效時 app.js 會切到登入畫面
      }
      setTimeout(poll, RESTART_POLL_MS);
    };
    setTimeout(poll, RESTART_POLL_MS * 2);
  }

  loadCommands();
  loadCache();
  renderBackup();
  loadSystem();
}
