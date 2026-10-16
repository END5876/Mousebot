// 狀態與訊息：Bot 的線上狀態與活動文字（data/presence.json）、以 Bot 身分在頻道發訊息（等同 /say）

import { fill, h, icon } from '../dom.js';
import { api } from '../api.js';
import { fmtTime } from '../format.js';
import { card, errorState, loadingState, selectEl, toast, withBusy } from '../ui.js';

const STATUS = [
  { value: 'online', label: '線上', dot: 'dot-good' },
  { value: 'idle', label: '閒置', dot: 'dot-warn' },
  { value: 'dnd', label: '請勿打擾', dot: 'dot-bad' },
  { value: 'invisible', label: '隱身', dot: '' },
];
const TYPES = [
  { value: 'none', label: '不顯示活動', verb: '' },
  { value: 'playing', label: '正在玩', verb: '正在玩' },
  { value: 'listening', label: '正在聽', verb: '正在聽' },
  { value: 'watching', label: '正在看', verb: '正在看' },
  { value: 'competing', label: '正在參加', verb: '正在參加' },
  { value: 'custom', label: '自訂狀態', verb: '' },
];
const MAX_TEXT = 128;
const MAX_MESSAGE = 2000;

export default function mountStatus(root, ctx) {
  const presenceSlot = h('div', null, loadingState());
  const messageSlot = h('div', null, loadingState());
  root.append(presenceSlot, messageSlot);

  // ── Bot 狀態 ─────────────────────────────────────────────
  async function loadPresence() {
    try {
      const saved = await api.get('/api/presence');
      if (!ctx.disposed) renderPresence(saved);
    } catch (err) {
      if (!ctx.disposed) presenceSlot.replaceChildren(errorState(err, loadPresence));
    }
  }

  function renderPresence(saved) {
    const cfg = { status: saved.status, type: saved.type, text: saved.text };
    const original = JSON.stringify(cfg);

    const statusBtns = STATUS.map((s) => h('button', {
      type: 'button', class: 'seg-btn', role: 'radio',
      onclick: () => { cfg.status = s.value; paint(); },
    }, h('span', { class: ['dot', s.dot] }), s.label));
    const typeSel = selectEl({
      options: TYPES.map((t) => ({ value: t.value, label: t.label })),
      value: cfg.type,
      ariaLabel: '活動類型',
      onchange: () => { cfg.type = typeSel.value; paint(); },
    });
    const textInput = h('input', {
      class: 'input', value: cfg.text, maxlength: MAX_TEXT, placeholder: '例如：逼逼 機油好難喝', 'aria-label': '活動文字',
      oninput: () => { cfg.text = textInput.value; paint(); },
    });
    const preview = h('div', { class: 'presence-preview' });
    const saveBtn = h('button', { type: 'button', class: 'btn btn-primary' }, icon('save', 'ic-sm'), '套用');

    function paint() {
      statusBtns.forEach((b, i) => b.setAttribute('aria-checked', String(STATUS[i].value === cfg.status)));
      textInput.disabled = cfg.type === 'none';
      const type = TYPES.find((t) => t.value === cfg.type);
      const status = STATUS.find((s) => s.value === cfg.status);
      const text = cfg.text.trim();
      fill(preview,
        h('span', { class: ['dot', status.dot] }),
        h('strong', null, status.label),
        cfg.type === 'none' || !text ? h('span', { class: 'hint' }, '（不顯示活動）') : h('span', null, type.verb ? `${type.verb} ${text}` : text),
      );
      saveBtn.disabled = JSON.stringify({ ...cfg, text: cfg.text.trim() }) === original || (cfg.type !== 'none' && !text);
    }

    saveBtn.addEventListener('click', async () => {
      let next = null;
      const ok = await withBusy(saveBtn, async () => {
        next = await api.put('/api/presence', { status: cfg.status, type: cfg.type, text: cfg.text.trim() });
      });
      if (!ok) return;
      toast('已更新 Bot 狀態');
      renderPresence({ ...next });
    });

    presenceSlot.replaceChildren(card({
      title: 'Bot 狀態',
      iconName: 'user',
      body: h('div', { class: 'form' },
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, '線上狀態'),
          h('div', { class: 'seg', role: 'radiogroup', 'aria-label': '線上狀態' }, statusBtns)),
        h('div', { class: 'form-row presence-row' },
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, '活動類型'), typeSel),
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, '活動文字'), textInput),
        ),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, '預覽'), preview),
      ),
      foot: [h('span', { class: 'spacer' }), saveBtn],
      note: '套用後立即生效，Bot 重新啟動後也會沿用（存在 data/presence.json）。「隱身」時 Bot 看起來是離線，但功能照常運作。',
    }));
    paint();
  }

  // ── 以 Bot 身分發訊息 ─────────────────────────────────────
  const sent = [];

  async function loadChannels() {
    try {
      const { guilds } = await api.get('/api/guild-channels');
      if (!ctx.disposed) renderMessage(guilds);
    } catch (err) {
      if (!ctx.disposed) messageSlot.replaceChildren(errorState(err, loadChannels));
    }
  }

  function renderMessage(guilds) {
    const groups = guilds
      .map((g) => ({
        label: g.name,
        options: [
          ...g.textChannels.map((c) => ({ value: c.id, label: `#${c.name}` })),
          ...g.voiceChannels.map((c) => ({ value: c.id, label: `🔊 ${c.name}（語音頻道聊天）` })),
        ],
      }))
      .filter((g) => g.options.length);
    const channelSel = selectEl({ groups, placeholder: '選擇頻道…', ariaLabel: '要發訊息的頻道' });
    const content = h('textarea', { class: 'textarea', rows: 4, maxlength: MAX_MESSAGE, placeholder: '要讓 Bot 說的話', 'aria-label': '訊息內容' });
    const counter = h('span', { class: 'counter' });
    const sendBtn = h('button', { type: 'button', class: 'btn btn-primary', disabled: true }, icon('send', 'ic-sm'), '發送');
    const history = h('div', { class: 'rows sent-list' });

    const paint = () => {
      counter.textContent = `${content.value.length} / ${MAX_MESSAGE}`;
      sendBtn.disabled = !channelSel.value || !content.value.trim();
    };
    const paintHistory = () => fill(history, sent.map((m) => h('div', { class: 'row' },
      icon('check', 'ic-sm'),
      h('div', { class: 'row-main' },
        h('div', { class: 'resp-preview' }, m.content),
        h('div', { class: 'row-sub' }, `${fmtTime(m.at)}・${m.channel}`),
      ),
      h('a', { class: 'btn btn-sm', href: m.url, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 'ic-sm'), '查看'),
    )));
    channelSel.addEventListener('change', paint);
    content.addEventListener('input', paint);

    sendBtn.addEventListener('click', async () => {
      const text = content.value.trim();
      const channelName = channelSel.selectedOptions[0]?.textContent ?? '';
      let res = null;
      const ok = await withBusy(sendBtn, async () => { res = await api.post('/api/messages', { channelId: channelSel.value, content: text }); });
      if (!ok) return;
      toast(`已發送到 ${channelName}`);
      sent.unshift({ content: text, channel: channelName, url: res.url, at: Date.now() });
      content.value = '';
      paint();
      paintHistory();
    });

    messageSlot.replaceChildren(card({
      title: '以 Bot 身分發訊息',
      iconName: 'send',
      body: h('div', { class: 'form' },
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, '頻道'), channelSel),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, '內容'), content,
          h('div', { class: 'toolbar' }, counter, h('span', { class: 'spacer' }), sendBtn)),
        history,
      ),
      note: '等同 /say。@everyone、@here 與身分組提及不會生效（Bot 只允許提及使用者）。',
    }));
    paint();
    paintHistory();
  }

  loadPresence();
  loadChannels();
}
