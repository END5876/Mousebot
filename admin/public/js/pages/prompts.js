// AI 人格：各模式的 system prompt 與共用規則（data/prompts/，存檔後立即生效，不必重啟）
// 送給 Gemini 的 system instruction ＝ 人格 prompt ＋ 全局規則（語音對話再加上語音規則）

import { fill, h, icon } from '../dom.js';
import { api, seg } from '../api.js';
import { fmtInt } from '../format.js';
import { confirmDialog, emptyState, errorState, loadingState, toast, toastError, withBusy } from '../ui.js';

const SHARED_INFO = {
  _general: { title: '全局規則', desc: '接在每個人格的 prompt 後面，文字與語音回覆都會用到。' },
  _voice: { title: '語音規則', desc: '語音對話（喚醒詞、錄音按鈕）時再額外接上。' },
};
const MODE_KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_PROMPT = 30000;

const sameTarget = (a, b) => !!a && !!b && a.kind === b.kind && a.key === b.key && !!a.isNew === !!b.isNew;

export default function mountPrompts(root, ctx) {
  let list = null;        // GET /api/prompts
  let selected = null;    // { kind: 'mode' | 'shared', key, isNew? }
  let save = null;        // 目前編輯器的儲存函式（Ctrl+S 用）
  let selectToken = 0;

  const listCard = h('section', { class: 'card' }, loadingState());
  const editorCard = h('section', { class: 'card' }, emptyState('從左邊選一個人格或共用規則來編輯', 'sparkle'));
  root.append(h('div', { class: 'split' }, listCard, editorCard));

  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && save) {
      e.preventDefault();
      save();
    }
  };
  document.addEventListener('keydown', onKey);
  ctx.onCleanup(() => document.removeEventListener('keydown', onKey));

  async function loadList() {
    try {
      list = await api.get('/api/prompts');
      if (!ctx.disposed) renderList();
    } catch (err) {
      if (!ctx.disposed) listCard.replaceChildren(errorState(err, loadList));
    }
  }

  function pick(target, title, sub) {
    return h('button', {
      type: 'button', class: 'pick', 'aria-current': String(sameTarget(target, selected)),
      onclick: () => select(target),
    }, h('span', { class: 'pick-title' }, title), h('span', { class: 'pick-sub' }, sub));
  }

  function renderList() {
    const shared = list.shared.map((s) => pick(
      { kind: 'shared', key: s.key },
      SHARED_INFO[s.key]?.title ?? s.key,
      `${s.key}.md・${s.length ? `${fmtInt(s.length)} 字` : '空白'}`,
    ));
    const modes = list.modes.map((m) => pick(
      { kind: 'mode', key: m.key },
      [m.name,
        m.key === list.defaultMode ? h('span', { class: 'badge badge-accent' }, '預設') : null,
        m.users ? h('span', { class: 'badge' }, `${m.users} 人使用`) : null],
      `${m.key}・${m.shortDescription || `${fmtInt(m.length)} 字`}`,
    ));
    const newPick = selected?.isNew ? pick(selected, '（新的人格）', '尚未儲存') : null;

    fill(listCard,
      h('div', { class: 'list-label' }, '共用規則'),
      ...shared,
      h('div', { class: 'list-label' }, `人格模式（${list.modes.length}）`,
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => select({ kind: 'mode', key: '', isNew: true }) }, icon('plus', 'ic-sm'), '新增')),
      ...modes,
      newPick,
      list.modes.length ? null : emptyState('還沒有任何人格，按「新增」建立第一個'),
    );
  }

  async function confirmDiscard() {
    if (!ctx.isDirty()) return true;
    return confirmDialog({ title: '還有未儲存的變更', message: '切換後，目前編輯中的內容會遺失。確定要切換嗎？', confirmText: '放棄變更' });
  }

  async function select(target, { force = false } = {}) {
    if (!force && sameTarget(target, selected)) return;
    if (!force && !await confirmDiscard()) return;
    ctx.setDirty(false);
    save = null;
    selected = target;
    if (list) renderList();

    const token = ++selectToken;
    editorCard.replaceChildren(loadingState());
    try {
      let data = null;
      if (target.kind === 'shared') data = await api.get(`/api/prompts/shared/${seg(target.key)}`);
      else if (!target.isNew) data = await api.get(`/api/prompts/modes/${seg(target.key)}`);
      if (token !== selectToken || ctx.disposed) return;
      if (target.kind === 'shared') renderSharedEditor(data);
      else renderModeEditor(data);
    } catch (err) {
      if (token === selectToken && !ctx.disposed) editorCard.replaceChildren(errorState(err, () => select(target, { force: true })));
    }
  }

  // ── 編輯器共用：計數、未儲存狀態 ─────────────────────────
  function trackChanges(inputs, snapshot, { saveBtn, revertBtn, counter, promptEl, canSave = () => true }) {
    let original = snapshot();
    const update = () => {
      const dirty = snapshot() !== original;
      ctx.setDirty(dirty);
      saveBtn.disabled = !dirty || !canSave();
      revertBtn.disabled = !dirty;
      const len = promptEl.value.length;
      counter.textContent = `${fmtInt(len)} / ${fmtInt(MAX_PROMPT)} 字`;
      counter.classList.toggle('is-over', len > MAX_PROMPT);
    };
    inputs.forEach((el) => el.addEventListener('input', update));
    update();
    return { update, markSaved: () => { original = snapshot(); update(); } };
  }

  function renderModeEditor(mode) {
    const isNew = !mode;
    const key = h('input', {
      class: 'input mono', id: 'pm-key', value: mode?.key ?? '', readOnly: !isNew, maxlength: 32,
      placeholder: '例如 catgirl', autocomplete: 'off', spellcheck: 'false',
    });
    const name = h('input', { class: 'input', id: 'pm-name', value: mode?.name ?? '', maxlength: 100, placeholder: '例如 貓娘模式' });
    const short = h('input', { class: 'input', id: 'pm-short', value: mode?.shortDescription ?? '', maxlength: 200 });
    const clearMsg = h('input', { class: 'input', id: 'pm-clear', value: mode?.clearMemoryMessage ?? '', maxlength: 500, placeholder: '🧠 已清除你的對話記憶。' });
    const prompt = h('textarea', { class: 'textarea code editor-textarea', id: 'pm-prompt', value: mode?.prompt ?? '', spellcheck: 'false' });
    const counter = h('span', { class: 'counter' });

    const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => save() }, icon('save', 'ic-sm'), isNew ? '建立' : '儲存');
    const revertBtn = h('button', {
      type: 'button', class: 'btn',
      onclick: async () => {
        if (await confirmDialog({ title: '還原變更', message: '要捨棄目前的修改，回到上次儲存的內容嗎？', confirmText: '還原' })) {
          select(selected, { force: true });
        }
      },
    }, icon('undo', 'ic-sm'), '還原');
    const isDefault = mode?.key === list?.defaultMode;
    const deleteBtn = isNew ? null : h('button', {
      type: 'button', class: 'btn btn-sm btn-danger', disabled: isDefault,
      title: isDefault ? '預設模式不能刪除' : null,
      onclick: () => removeMode(mode),
    }, icon('trash', 'ic-sm'), '刪除');

    const fields = [key, name, short, clearMsg, prompt];
    const tracker = trackChanges(fields, () => JSON.stringify(fields.map((f) => f.value)), {
      saveBtn, revertBtn, counter, promptEl: prompt,
      canSave: () => MODE_KEY_RE.test(key.value.trim()) && !!prompt.value.trim(),
    });

    save = async () => {
      const k = key.value.trim();
      if (!MODE_KEY_RE.test(k)) { toast('模式代號只能使用英數、底線、連字號（1~32 字）', { type: 'error' }); key.focus(); return; }
      if (!prompt.value.trim()) { toast('Prompt 本文不可為空', { type: 'error' }); prompt.focus(); return; }
      if (prompt.value.length > MAX_PROMPT) { toast(`Prompt 最多 ${fmtInt(MAX_PROMPT)} 字`, { type: 'error' }); return; }
      if (!ctx.isDirty()) return;

      const ok = await withBusy(saveBtn, () => api.put(`/api/prompts/modes/${seg(k)}`, {
        name: name.value, shortDescription: short.value, clearMemoryMessage: clearMsg.value, prompt: prompt.value, create: isNew,
      }));
      if (!ok) return;
      tracker.markSaved();
      toast(isNew ? `已建立人格「${name.value.trim() || k}」，立即生效` : '已儲存，立即生效');
      await loadList();
      if (isNew) select({ kind: 'mode', key: k }, { force: true });
    };

    editorCard.replaceChildren(
      h('div', { class: 'card-head' },
        h('h2', null, icon('sparkle'), isNew ? '新增人格' : mode.name),
        isNew ? null : h('span', { class: 'badge mono' }, mode.key),
        h('div', { class: 'card-head-actions' }, deleteBtn),
      ),
      h('div', { class: 'card-body' }, h('div', { class: 'form' },
        h('div', { class: 'form-row' },
          h('div', { class: 'field' }, h('label', { for: 'pm-key' }, '模式代號'), key,
            h('div', { class: 'hint' }, isNew ? '英數、底線、連字號，1～32 字；建立後不能修改' : '也是檔名：data/prompts/modes/' + mode.key + '.md')),
          h('div', { class: 'field' }, h('label', { for: 'pm-name' }, '顯示名稱'), name,
            h('div', { class: 'hint' }, '在 /ai mode 選單與 log 中顯示')),
        ),
        h('div', { class: 'form-row' },
          h('div', { class: 'field' }, h('label', { for: 'pm-short' }, '簡短說明（選填）'), short,
            h('div', { class: 'hint' }, '備註用，Bot 回覆時不會用到')),
          h('div', { class: 'field' }, h('label', { for: 'pm-clear' }, '清除記憶時的回覆'), clearMsg,
            h('div', { class: 'hint' }, '使用者執行 /ai clear 時，Bot 回的那句話')),
        ),
        h('div', { class: 'field' },
          h('label', { for: 'pm-prompt' }, 'Prompt 本文'),
          prompt,
          h('div', { class: 'toolbar' }, counter, h('span', { class: 'spacer' }), h('span', { class: 'hint' }, 'Ctrl + S 儲存')),
        ),
      )),
      h('div', { class: 'card-foot' }, revertBtn, h('span', { class: 'spacer' }), saveBtn),
    );
    (isNew ? key : prompt).focus({ preventScroll: true });
  }

  function renderSharedEditor(data) {
    const info = SHARED_INFO[data.key] ?? { title: data.key, desc: '' };
    const text = h('textarea', { class: 'textarea code editor-textarea', id: 'ps-text', value: data.text, spellcheck: 'false' });
    const counter = h('span', { class: 'counter' });
    const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => save() }, icon('save', 'ic-sm'), '儲存');
    const revertBtn = h('button', {
      type: 'button', class: 'btn',
      onclick: async () => {
        if (await confirmDialog({ title: '還原變更', message: '要捨棄目前的修改，回到上次儲存的內容嗎？', confirmText: '還原' })) {
          select(selected, { force: true });
        }
      },
    }, icon('undo', 'ic-sm'), '還原');
    const tracker = trackChanges([text], () => text.value, { saveBtn, revertBtn, counter, promptEl: text });

    save = async () => {
      if (!ctx.isDirty()) return;
      if (text.value.length > MAX_PROMPT) { toast(`最多 ${fmtInt(MAX_PROMPT)} 字`, { type: 'error' }); return; }
      const ok = await withBusy(saveBtn, () => api.put(`/api/prompts/shared/${seg(data.key)}`, { text: text.value }));
      if (!ok) return;
      tracker.markSaved();
      toast('已儲存，立即生效');
      loadList();
    };

    editorCard.replaceChildren(
      h('div', { class: 'card-head' }, h('h2', null, icon('sparkle'), info.title), h('span', { class: 'badge mono' }, `${data.key}.md`)),
      h('div', { class: 'card-body' }, h('div', { class: 'form' },
        h('div', { class: 'callout' }, icon('info', 'ic-sm'), h('span', null, info.desc)),
        h('div', { class: 'field' },
          h('label', { for: 'ps-text' }, '規則內容'),
          text,
          h('div', { class: 'toolbar' }, counter, h('span', { class: 'spacer' }), h('span', { class: 'hint' }, 'Ctrl + S 儲存')),
        ),
      )),
      h('div', { class: 'card-foot' }, revertBtn, h('span', { class: 'spacer' }), saveBtn),
    );
    text.focus({ preventScroll: true });
  }

  async function removeMode(mode) {
    const users = list?.modes.find((m) => m.key === mode.key)?.users ?? 0;
    const ok = await confirmDialog({
      title: '刪除人格',
      message: `確定要刪除「${mode.name}」（${mode.key}.md）嗎？這個動作無法復原。`
        + (users ? `\n\n目前有 ${users} 位使用者指定這個模式，刪除後他們會改用預設判斷。` : ''),
      confirmText: '刪除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/prompts/modes/${seg(mode.key)}`);
      toast(`已刪除「${mode.name}」`);
      ctx.setDirty(false);
      save = null;
      selected = null;
      editorCard.replaceChildren(emptyState('從左邊選一個人格或共用規則來編輯', 'sparkle'));
      await loadList();
    } catch (err) {
      toastError(err);
    }
  }

  loadList();
}
