// 語音與音樂：自動加入語音頻道、加入／離開語音頻道、喚醒詞監聽、點歌與播放控制、閒置自動停止
// 播放控制的邏輯與 Discord 控制面板按鈕相同，操作後 Discord 上的面板與網頁播放器都會同步更新。

import { fill, h, icon, setVar } from '../dom.js';
import { api, qs, seg } from '../api.js';
import { fmtClock, fmtInt } from '../format.js';
import {
  avatar, card, confirmDialog, emptyState, errorState, loadingState, openModal, segmented, selectEl, statusBadge,
  switchControl, toast, toastError, withBusy,
} from '../ui.js';

const POLL_MS = 5000;
const SEARCH_DEBOUNCE_MS = 250;
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

const channelLabel = (c) => (c.category ? `${c.name}（${c.category}）` : c.name);

export default function mountVoice(root, ctx) {
  let data = null;
  let fetchedAt = 0;
  const autoJoinSlot = h('div');
  const guildSlot = h('div', { class: 'page' });
  const idleSlot = h('div');
  const cards = new Map(); // guildId → { sig, el, update }
  let autoJoinSig = '';
  let autoJoinPending = false; // 下拉選單選了新頻道但還沒套用：輪詢時不要蓋掉
  let idleSig = '';

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

  // 自動加入的目標在這個伺服器時，離開或換頻道後約 10 秒會被拉回目標頻道
  function autoJoinNote(g) {
    const aj = data.autoJoin;
    if (!aj.enabled || aj.targetGuildId !== g.id || !aj.channelName) return null;
    return `自動加入已開啟：Bot 會常駐在「${aj.channelName}」，離開或移到其他頻道後約 10 秒會回去。`;
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
      .map((g) => ({ label: g.name, options: g.voiceChannels.map((c) => ({ value: c.id, label: channelLabel(c) })) }));
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
    const others = data.guilds.filter((g) => !g.voice && !g.music);
    const ajSig = JSON.stringify([data.autoJoin.enabled, data.autoJoin.targetGuildId, data.autoJoin.channelName]);

    if (!active.length) {
      cards.clear();
      guildSlot.replaceChildren(card({
        title: '語音連線', iconName: 'headphones',
        body: emptyState('Bot 目前不在任何語音頻道。可以在下方「其他伺服器」讓 Bot 加入，或在 Discord 用 /play 點歌。', 'volume'),
      }));
    } else {
      const els = active.map((g) => {
        // 播放進度每秒在本地推算，不列入比對；其餘狀態有變才重畫，避免使用者正在操作的按鈕、選單被換掉
        const sig = JSON.stringify([{ ...g, music: g.music && { ...g.music, positionMs: undefined } }, ajSig]);
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

    // 其他伺服器（加入語音頻道的下拉選單）也只在內容有變時重畫，選到一半不會被輪詢蓋掉
    const sig = JSON.stringify([others.map((g) => [g.id, g.name, g.iconUrl, g.voiceChannels, g.idleMonitor.enabled]), ajSig]);
    if (sig === idleSig) return;
    idleSig = sig;
    fill(idleSlot, others.length ? card({
      title: '其他伺服器',
      sub: '目前沒有語音連線',
      iconName: 'server',
      tight: true,
      body: h('div', { class: 'rows' }, others.map((g) => h('div', { class: 'row row-wrap' },
        avatar({ url: g.iconUrl, name: g.name, size: 'sm', square: true }),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' }, g.name),
          autoJoinNote(g) ? h('div', { class: 'row-sub' }, autoJoinNote(g)) : null,
        ),
        joinControls(g),
        idleSwitch(g),
      ))),
      note: '開關是「閒置自動停止」：頻道內 30 分鐘沒有其他人，或有人但 60 分鐘沒人說話時，自動停止播放（Bot 不會離開頻道）。',
    }) : null);
  }

  function joinControls(g) {
    if (!g.voiceChannels.length) return h('span', { class: 'hint' }, '沒有語音頻道');
    const sel = selectEl({
      options: g.voiceChannels.map((c) => ({ value: c.id, label: channelLabel(c) })),
      placeholder: '選擇語音頻道…',
      ariaLabel: `${g.name} 要加入的語音頻道`,
    });
    const btn = h('button', { type: 'button', class: 'btn btn-sm', disabled: true }, icon('log-in', 'ic-sm'), '加入');
    sel.addEventListener('change', () => { btn.disabled = !sel.value; });
    btn.addEventListener('click', async () => {
      const channel = g.voiceChannels.find((c) => c.id === sel.value);
      const ok = await withBusy(btn, () => api.post(`/api/voice/${seg(g.id)}/join`, { channelId: sel.value }));
      if (ok) {
        toast(`已加入「${channel?.name ?? '語音頻道'}」`);
        load();
      }
    });
    return h('div', { class: 'add-inline join-inline' }, sel, btn);
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

  function wakeWordControls(g) {
    const sel = selectEl({
      options: g.textChannels.map((c) => ({ value: c.id, label: `#${channelLabel(c)}` })),
      value: g.wakeWord.defaultChannelId ?? '',
      placeholder: g.wakeWord.defaultChannelId ? null : '選擇轉錄頻道…',
      ariaLabel: '喚醒詞的轉錄頻道',
    });
    sel.disabled = g.wakeWord.active;
    const sw = switchControl({
      checked: g.wakeWord.active,
      label: '喚醒詞監聽',
      onChange: async (on) => {
        await api.put(`/api/voice/${seg(g.id)}/wake-word`, on ? { on, textChannelId: sel.value || undefined } : { on });
        toast(on ? '已開始喚醒詞監聽，對 Bot 說「hey taffy」就會回應' : '已停止喚醒詞監聽');
        load();
      },
    });
    return h('div', { class: 'wake-row' },
      sw,
      h('span', { class: 'hint' }, '轉錄與回覆送到'),
      sel,
    );
  }

  async function act(g, button, body, { confirm } = {}) {
    if (confirm && !await confirmDialog(confirm)) return;
    let message = '';
    const run = async () => { message = (await api.post(`/api/music/${seg(g.id)}`, body)).message; };
    const ok = button ? await withBusy(button, run) : await run().then(() => true, (err) => { toastError(err); return false; });
    if (ok) toast(message);
    await load();
  }

  async function leave(g, button) {
    const note = autoJoinNote(g);
    const ok = await confirmDialog({
      title: '離開語音頻道',
      message: `要讓 Bot 離開「${g.name}」的語音頻道嗎？正在播放的音樂會停止、佇列會清空，喚醒詞監聽也會關閉。${note ? `\n\n${note}` : ''}`,
      confirmText: '離開',
      danger: true,
    });
    if (!ok) return;
    const done = await withBusy(button, () => api.post(`/api/voice/${seg(g.id)}/leave`));
    if (done) {
      toast(`已離開「${g.name}」的語音頻道`);
      load();
    }
  }

  function guildCard(g) {
    const v = g.voice;
    const [kind, text] = v ? (VOICE_STATUS[v.status] ?? ['warn', v.status]) : ['neutral', '未連線'];
    const voiceLine = v
      ? [icon('volume', 'ic-sm'), ' ', v.channelName ?? '（頻道未知）', v.listeners != null ? `・${v.listeners} 人在頻道` : '']
      : ['不在語音頻道'];

    const enqueueBtn = v ? h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => openEnqueue(g) }, icon('plus', 'ic-sm'), '點歌') : null;
    const leaveBtn = v ? h('button', { type: 'button', class: 'btn btn-sm btn-danger' }, icon('logout', 'ic-sm'), '離開') : null;
    leaveBtn?.addEventListener('click', () => leave(g, leaveBtn));

    let tick = () => {};
    let body;
    if (g.music) {
      const built = musicBlock(g);
      body = built.el;
      tick = built.tick;
    } else {
      body = h('div', { class: 'card-body' }, emptyState(v ? '目前沒有播放音樂，按右上角「點歌」開始' : '目前沒有播放音樂', 'music'));
    }

    const note = autoJoinNote(g);
    const el = h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        avatar({ url: g.iconUrl, name: g.name, size: 'sm', square: true }),
        h('div', { class: 'row-main' },
          h('h2', null, g.name),
          h('div', { class: 'card-sub' }, voiceLine),
        ),
        h('div', { class: 'card-head-actions' }, statusBadge(kind, text), enqueueBtn, leaveBtn),
      ),
      body,
      v ? h('div', { class: 'card-foot' }, wakeWordControls(g)) : null,
      h('div', { class: 'card-foot' }, idleSwitch(g, true),
        h('span', { class: 'hint' }, g.idleMonitor.active ? '監控中' : '（Bot 進入語音頻道後才開始監控）')),
      note ? h('div', { class: 'card-note' }, icon('info', 'ic-sm'), h('span', null, note)) : null,
    );
    const update = (next) => { g = next; tick(next); };
    return { el, update };
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

  // ── 點歌對話框：本地音樂／線上搜尋／貼上網址 ───────────────
  function openEnqueue(g) {
    const panel = h('div', { class: 'enqueue-panel' });
    const tabs = segmented({
      ariaLabel: '點歌來源', value: 'lib',
      options: [
        { value: 'lib', label: '本地音樂', icon: 'folder' },
        { value: 'search', label: '線上搜尋', icon: 'search' },
        { value: 'url', label: '貼上網址', icon: 'link' },
      ],
      onChange: (v) => renderTab(v),
    });
    openModal({ title: `點歌：${g.name}`, body: [tabs, panel], wide: true });

    // getItem 在 withBusy 裡才呼叫：它丟出的錯誤（例如沒填網址）會變成錯誤提示
    async function add(getItem, next, button) {
      const ok = await withBusy(button, async () => {
        const res = await api.post(`/api/music/${seg(g.id)}`, { action: 'enqueue', item: getItem(), next });
        toast(res.message);
      });
      if (ok) load();
    }

    const addButtons = (getItem) => {
      const nextBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', title: '插到佇列最前面' }, '下一首');
      const addBtn = h('button', { type: 'button', class: 'btn btn-sm' }, icon('plus', 'ic-sm'), '加入佇列');
      nextBtn.addEventListener('click', () => add(getItem, true, nextBtn));
      addBtn.addEventListener('click', () => add(getItem, false, addBtn));
      return h('div', { class: 'row-actions' }, nextBtn, addBtn);
    };

    function renderTab(tab) {
      if (tab === 'lib') libTab();
      else if (tab === 'search') searchTab();
      else urlTab();
    }

    function libTab() {
      const input = h('input', { class: 'input', type: 'search', placeholder: '搜尋本地音樂', 'aria-label': '搜尋本地音樂' });
      const list = h('div', { class: 'rows enqueue-list' }, loadingState());
      const info = h('div', { class: 'hint' });
      let timer = null;
      let token = 0;
      const query = async () => {
        const t = ++token;
        try {
          const res = await api.get(qs('/api/music/library', { q: input.value.trim() || null }));
          if (t !== token) return;
          info.textContent = `共 ${fmtInt(res.total)} 首，依播放次數排序${res.more ? `（只顯示前 ${res.items.length} 筆，請用搜尋縮小範圍）` : ''}`;
          fill(list, res.items.length
            ? res.items.map((f) => h('div', { class: 'row' },
              icon('music'),
              h('div', { class: 'row-main' },
                h('div', { class: 'truncate' }, f.name),
                h('div', { class: 'row-sub truncate' }, `${f.filename}・播放 ${fmtInt(f.playCount)} 次`),
              ),
              addButtons(() => ({ kind: 'lib', filename: f.filename })),
            ))
            : emptyState(input.value ? '找不到符合的歌' : 'data/music 裡沒有音樂', 'music'));
        } catch (err) {
          if (t === token) fill(list, errorState(err));
        }
      };
      input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(query, SEARCH_DEBOUNCE_MS); });
      fill(panel, h('div', { class: 'input-icon' }, icon('search'), input), info, list);
      query();
      input.focus();
    }

    function searchTab() {
      const input = h('input', { class: 'input', type: 'search', placeholder: '輸入關鍵字（YouTube + Bilibili）', 'aria-label': '線上搜尋關鍵字' });
      const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('search', 'ic-sm'), '搜尋');
      const list = h('div', { class: 'rows enqueue-list' }, emptyState('輸入關鍵字後按搜尋', 'search'));
      const form = h('form', { class: 'add-inline', novalidate: true }, input, btn);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const q = input.value.trim();
        if (!q) { input.focus(); return; }
        fill(list, loadingState('搜尋中…（YouTube 與 Bilibili 一起查，約需幾秒）'));
        btn.disabled = true;
        try {
          const { results } = await api.get(qs('/api/music/search', { q }));
          fill(list, results.length
            ? results.map((r) => h('div', { class: 'row' },
              h('span', { class: 'badge' }, r.platform),
              h('div', { class: 'row-main' },
                h('a', { class: 'truncate block-link', href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.title),
                h('div', { class: 'row-sub truncate' }, [r.author, r.duration].filter(Boolean).join('・')),
              ),
              addButtons(() => ({ kind: 'online', url: r.url })),
            ))
            : emptyState(`找不到與「${q}」相關的結果`, 'search'));
        } catch (err) {
          fill(list, errorState(err));
        } finally {
          btn.disabled = false;
        }
      });
      fill(panel, form, list);
      input.focus();
    }

    function urlTab() {
      const input = h('input', { class: 'input', type: 'url', placeholder: 'https://www.youtube.com/watch?v=…  或  https://www.bilibili.com/video/BV…', 'aria-label': '影片網址' });
      fill(panel,
        h('div', { class: 'field' },
          h('span', { class: 'field-label' }, 'YouTube / Bilibili 影片網址'),
          input,
          h('div', { class: 'hint' }, '只會加入這一部影片；播放清單請在 Discord 用 /play 匯入。'),
        ),
        h('div', { class: 'toolbar enqueue-url-actions' }, h('span', { class: 'spacer' }), addButtons(() => {
          const url = input.value.trim();
          if (!url) throw new Error('請貼上影片網址');
          return { kind: 'online', url };
        })),
      );
      input.focus();
    }

    renderTab('lib');
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
