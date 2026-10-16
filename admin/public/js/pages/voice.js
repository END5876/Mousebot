// 語音與音樂：自動加入語音頻道、各伺服器的語音連線與播放控制、閒置自動停止
// 播放控制的邏輯與 Discord 控制面板按鈕相同，操作後 Discord 上的面板與網頁播放器都會同步更新。

import { fill, h, icon, setVar } from '../dom.js';
import { api, seg } from '../api.js';
import { fmtClock } from '../format.js';
import {
  avatar, card, confirmDialog, emptyState, errorState, loadingState, segmented, selectEl, statusBadge,
  switchControl, toast, toastError, withBusy,
} from '../ui.js';

const POLL_MS = 5000;
const VOICE_STATUS = {
  ready: ['good', '已連線'],
  signalling: ['warn', '連線中'],
  connecting: ['warn', '連線中'],
  disconnected: ['bad', '已斷線'],
};
const PLAYER_STATUS = {
  playing: '播放中',
  buffering: '緩衝中',
  paused: '已暫停',
  autopaused: '暫停（語音未連線）',
  idle: '準備下一首',
};
const LOOP_OPTIONS = [
  { value: 'off', label: '不循環' },
  { value: 'one', label: '單曲循環', icon: 'repeat' },
  { value: 'all', label: '列表循環', icon: 'repeat' },
];

export default function mountVoice(root, ctx) {
  let data = null;
  let fetchedAt = 0;
  const autoJoinSlot = h('div');
  const guildSlot = h('div', { class: 'page' });
  const idleSlot = h('div');
  const cards = new Map(); // guildId → { sig, el, tick }
  let autoJoinSig = '';
  let autoJoinPending = false; // 下拉選單選了新頻道但還沒套用：輪詢時不要蓋掉

  const refreshBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => load(true) }, icon('refresh', 'ic-sm'), '重新整理');
  ctx.setActions(refreshBtn);
  root.append(loadingState());

  async function load(manual = false) {
    try {
      const next = await api.get('/api/voice');
      if (ctx.disposed) return;
      data = next;
      fetchedAt = performance.now();
      render();
    } catch (err) {
      if (ctx.disposed) return;
      if (!data) root.replaceChildren(errorState(err, () => load(true)));
      else if (manual) toastError(err);
    }
  }

  function render() {
    if (!autoJoinSlot.isConnected) root.replaceChildren(autoJoinSlot, guildSlot, idleSlot);
    renderAutoJoin();
    renderGuilds();
  }

  // ── 自動加入 ─────────────────────────────────────────────
  function renderAutoJoin(force = false) {
    const aj = data.autoJoin;
    const sig = JSON.stringify(aj);
    if (!force && (sig === autoJoinSig || autoJoinPending)) return;
    autoJoinSig = sig;
    autoJoinPending = false;

    const groups = data.guilds
      .filter((g) => g.voiceChannels.length)
      .map((g) => ({
        label: g.name,
        options: g.voiceChannels.map((c) => ({ value: c.id, label: c.category ? `${c.name}（${c.category}）` : c.name })),
      }));
    const missingTarget = aj.targetChannelId && !aj.channelName;
    const sel = selectEl({
      groups,
      value: missingTarget ? '' : aj.targetChannelId,
      placeholder: missingTarget ? '（目前的目標頻道找不到了，請重新選擇）' : aj.targetChannelId ? null : '選擇語音頻道…',
      ariaLabel: '自動加入的目標語音頻道',
    });
    const applyBtn = h('button', { type: 'button', class: 'btn btn-primary', disabled: true }, '套用');
    sel.addEventListener('change', () => {
      autoJoinPending = !!sel.value && sel.value !== aj.targetChannelId;
      applyBtn.disabled = !autoJoinPending;
    });
    applyBtn.addEventListener('click', async () => {
      const ok = await withBusy(applyBtn, async () => {
        data.autoJoin = await api.put('/api/autojoin', { channelId: sel.value });
      });
      if (!ok) return;
      toast(data.autoJoin.enabled ? '已更新目標頻道，Bot 正在嘗試加入' : '已更新目標頻道（自動加入目前是關閉的）');
      renderAutoJoin(true);
      setTimeout(() => { if (!ctx.disposed) load(); }, 2500);
    });

    const toggle = switchControl({
      checked: aj.enabled,
      label: aj.enabled ? '已啟用' : '已停用',
      onChange: async (on) => {
        data.autoJoin = await api.put('/api/autojoin', { enabled: on });
        toast(on ? '已開啟自動加入' : '已關閉自動加入（Bot 不會因此立即離開語音頻道）');
        renderAutoJoin(true);
      },
    });

    let status;
    if (!aj.enabled) status = statusBadge('neutral', '未啟用');
    else if (!aj.targetChannelId) status = statusBadge('warn', '尚未設定頻道');
    else if (aj.connected) status = statusBadge('good', '已在目標頻道');
    else status = statusBadge('warn', '嘗試加入中');

    autoJoinSlot.replaceChildren(card({
      title: '自動加入語音頻道',
      iconName: 'volume',
      actions: [status, toggle],
      body: h('div', { class: 'field' },
        h('span', { class: 'field-label' }, '目標頻道'),
        h('div', { class: 'add-inline' }, sel, applyBtn),
        aj.channelName ? h('div', { class: 'hint' }, `目前：${aj.guildName} › ${aj.channelName}`) : null,
      ),
      note: 'Bot 會常駐在這個頻道，每 10 秒檢查一次，斷線後自動重新加入。關閉自動加入不會讓 Bot 立即離開頻道。',
    }));
  }

  // ── 各伺服器 ─────────────────────────────────────────────
  function renderGuilds() {
    const active = data.guilds.filter((g) => g.voice || g.music);
    const idle = data.guilds.filter((g) => !g.voice && !g.music);

    if (!active.length) {
      cards.clear();
      guildSlot.replaceChildren(card({ title: '語音連線', iconName: 'headphones', body: emptyState('Bot 目前不在任何語音頻道。在 Discord 用 /play 點歌或 /voice join 讓 Bot 加入。', 'volume') }));
    } else {
      const els = active.map((g) => {
        // 播放進度每秒在本地推算，不列入比對；其餘狀態有變才重畫，避免使用者正在按的按鈕被換掉
        const sig = JSON.stringify({ ...g, music: g.music && { ...g.music, positionMs: undefined } });
        let entry = cards.get(g.id);
        if (!entry || entry.sig !== sig) {
          entry = { sig, ...guildCard(g) };
          cards.set(g.id, entry);
        } else {
          entry.update(g);
        }
        return entry.el;
      });
      for (const id of cards.keys()) if (!active.some((g) => g.id === id)) cards.delete(id);
      guildSlot.replaceChildren(...els);
    }

    fill(idleSlot, idle.length ? card({
      title: '其他伺服器',
      sub: '目前沒有語音連線',
      iconName: 'server',
      tight: true,
      body: h('div', { class: 'rows' }, idle.map((g) => h('div', { class: 'row' },
        avatar({ url: g.iconUrl, name: g.name, size: 'sm', square: true }),
        h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, g.name)),
        idleSwitch(g),
      ))),
      note: '閒置自動停止：頻道內 30 分鐘沒有其他人，或有人但 60 分鐘沒人說話時，自動停止播放（Bot 不會離開頻道）。',
    }) : null);
  }

  function idleSwitch(g, withLabel = false) {
    return switchControl({
      checked: g.idleMonitor.enabled,
      label: withLabel ? '閒置自動停止' : null,
      ariaLabel: `${g.name} 閒置自動停止`,
      onChange: async (on) => {
        const res = await api.put(`/api/voice/${seg(g.id)}/idle`, { enabled: on });
        g.idleMonitor = res;
        toast(`${g.name}：閒置自動停止已${on ? '開啟' : '關閉'}`);
      },
    });
  }

  async function act(g, button, body, { confirm } = {}) {
    if (confirm && !await confirmDialog(confirm)) return;
    let message = '';
    const run = async () => { message = (await api.post(`/api/music/${seg(g.id)}`, body)).message; };
    const ok = button ? await withBusy(button, run) : await run().then(() => true, (err) => { toastError(err); return false; });
    if (ok) toast(message);
    await load();
  }

  function guildCard(g) {
    const v = g.voice;
    const [kind, text] = v ? (VOICE_STATUS[v.status] ?? ['warn', v.status]) : ['neutral', '未連線'];
    const voiceLine = v
      ? [icon('volume', 'ic-sm'), ' ', v.channelName ?? '（頻道未知）', v.listeners != null ? `・${v.listeners} 人在頻道` : '']
      : ['不在語音頻道'];

    let tick = () => {};
    let body;
    if (g.music) {
      const built = musicBlock(g);
      body = built.el;
      tick = built.tick;
    } else {
      body = h('div', { class: 'card-body' }, emptyState('目前沒有播放音樂（在 Discord 用 /play 點歌）', 'music'));
    }

    const el = h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        avatar({ url: g.iconUrl, name: g.name, size: 'sm', square: true }),
        h('div', { class: 'row-main' },
          h('h2', null, g.name),
          h('div', { class: 'card-sub' }, voiceLine),
        ),
        h('div', { class: 'card-head-actions' }, statusBadge(kind, text)),
      ),
      body,
      h('div', { class: 'card-foot' }, idleSwitch(g, true),
        h('span', { class: 'hint' }, g.idleMonitor.active ? '監控中' : '（Bot 進入語音頻道後才開始監控）')),
    );
    const update = (next) => { g = next; tick(next); };
    return { el, update, tick: () => tick(g) };
  }

  function musicBlock(g) {
    const m = g.music;
    const cur = m.current;
    const thumb = cur.thumbnail
      ? h('img', { class: 'np-thumb', src: cur.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
      : h('div', { class: 'np-thumb np-thumb-fallback' }, icon('music'));
    const title = cur.url
      ? h('a', { class: 'np-title', href: cur.url, target: '_blank', rel: 'noopener noreferrer' }, cur.title)
      : h('div', { class: 'np-title' }, cur.title);

    const elapsedEl = h('span');
    const totalEl = h('span');
    const track = h('div', { class: 'progress-track' }, h('span'));
    const statusEl = h('span');

    // 依上次取得的播放位置與經過時間推算進度（每秒更新，不必一直向伺服器要）
    const tick = (state) => {
      const music = state.music;
      if (!music) return;
      const running = music.status === 'playing';
      const pos = music.positionMs + (running ? performance.now() - fetchedAt : 0);
      const totalMs = (music.current.durationSec || 0) * 1000;
      elapsedEl.textContent = fmtClock(totalMs ? Math.min(pos, totalMs) : pos);
      totalEl.textContent = totalMs ? fmtClock(totalMs) : '--:--';
      setVar(track, '--w', totalMs ? `${Math.min(100, (pos / totalMs) * 100)}%` : '0%');
      statusEl.textContent = PLAYER_STATUS[music.status] ?? music.status;
    };
    tick(g);

    const skipBtn = h('button', { type: 'button', class: 'btn', onclick: () => act(g, skipBtn, { action: 'skip' }) }, icon('skip', 'ic-sm'), '跳過');
    const stopBtn = h('button', {
      type: 'button', class: 'btn btn-danger',
      onclick: () => act(g, stopBtn, { action: 'stop' }, {
        confirm: { title: '停止播放', message: `要停止 ${g.name} 的音樂並清空佇列嗎？`, confirmText: '停止', danger: true },
      }),
    }, icon('stop', 'ic-sm'), '停止');
    const loopSeg = segmented({
      ariaLabel: '循環模式', small: true, value: m.randomPlay ? null : m.loopMode, options: LOOP_OPTIONS,
      onChange: async (mode) => {
        const res = await api.post(`/api/music/${seg(g.id)}`, { action: 'loop', mode });
        toast(res.message);
        load();
      },
    });
    const randomSwitch = switchControl({
      checked: m.randomPlay,
      label: '隨機連播',
      onChange: async (on) => {
        const res = await api.post(`/api/music/${seg(g.id)}`, { action: 'random', on });
        toast(res.message);
        load();
      },
    });

    const queueRows = m.queue.map((t, i) => {
      const removeBtn = h('button', {
        type: 'button', class: 'btn btn-sm btn-ghost btn-icon btn-danger', 'aria-label': `從佇列移除「${t.title}」`,
        onclick: () => act(g, removeBtn, { action: 'removeQueue', index: i, key: t.key }),
      }, icon('x'));
      return h('div', { class: 'row' },
        h('span', { class: 'q-index' }, i + 1),
        h('div', { class: 'row-main' },
          h('div', { class: 'truncate' }, t.title),
          h('div', { class: 'row-sub' }, [t.source, t.author, t.durationSec ? fmtClock(t.durationSec * 1000) : null].filter(Boolean).join('・')),
        ),
        removeBtn,
      );
    });
    const clearBtn = h('button', {
      type: 'button', class: 'btn btn-sm btn-danger', disabled: !m.queueLength,
      onclick: () => act(g, clearBtn, { action: 'clearQueue' }, {
        confirm: { title: '清空佇列', message: `要清空 ${g.name} 的佇列（${m.queueLength} 首）嗎？目前這首會繼續播放。`, confirmText: '清空', danger: true },
      }),
    }, icon('trash', 'ic-sm'), '清空');

    const el = h('div', null,
      h('div', { class: 'card-body' }, h('div', { class: 'form' },
        h('div', { class: 'np' },
          thumb,
          h('div', { class: 'np-main' },
            title,
            h('div', { class: 'np-meta' },
              h('span', { class: 'badge' }, cur.source),
              cur.author ? h('span', null, cur.author) : null,
              statusEl,
            ),
            h('div', { class: 'progress' }, elapsedEl, track, totalEl),
          ),
        ),
        h('div', { class: 'controls' }, skipBtn, stopBtn, loopSeg, randomSwitch),
      )),
      h('div', { class: 'list-label queue-head' }, `佇列（${m.queueLength} 首）`, clearBtn),
      m.queue.length
        ? h('div', { class: 'rows queue' }, queueRows)
        : h('div', { class: 'card-body' }, h('div', { class: 'hint' }, m.randomPlay ? '佇列是空的，播完後會隨機挑下一首本地音樂' : '佇列是空的')),
      m.queueLength > m.queue.length ? h('div', { class: 'card-note' }, `還有 ${m.queueLength - m.queue.length} 首未顯示`) : null,
    );
    return { el, tick };
  }

  // 每秒推算播放進度
  const timer = setInterval(() => {
    if (!data || document.hidden) return;
    for (const g of data.guilds) cards.get(g.id)?.update(g);
  }, 1000);
  ctx.onCleanup(() => clearInterval(timer));

  load();
  ctx.poll(load, POLL_MS);
}
