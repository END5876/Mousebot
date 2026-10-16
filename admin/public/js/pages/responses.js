// 自訂回應：訊息符合關鍵字時自動回覆（data/responses.json，與 /response 指令共用）

import { h, icon } from '../dom.js';
import { api, qs } from '../api.js';
import {
  confirmDialog, emptyState, errorState, loadingState, openModal, segmented, toast, toastError, withBusy,
} from '../ui.js';

const TYPES = ['exact', 'contains'];
const TYPE_LABEL = { exact: '完全匹配', contains: '包含匹配' };
const TYPE_HINT = {
  exact: '訊息內容和關鍵字一模一樣時回覆。',
  contains: '訊息裡含有關鍵字就回覆；有多條規則符合時，以清單中較前面的為準。',
};
const MAX_MESSAGES = 10;
const MAX_MESSAGE_LENGTH = 2000;

const typeOptions = TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }));

export default function mountResponses(root, ctx) {
  let data = null; // { exact: {}, contains: {} }
  let filterType = 'all';
  let query = '';

  const search = h('input', {
    class: 'input', type: 'search', placeholder: '搜尋關鍵字或回應內容', 'aria-label': '搜尋規則',
    oninput: () => { query = search.value.trim().toLowerCase(); renderList(); },
  });
  const filterSeg = segmented({
    ariaLabel: '依匹配類型篩選',
    value: 'all',
    options: [{ value: 'all', label: '全部' }, ...typeOptions],
    onChange: (v) => { filterType = v; renderList(); },
  });
  ctx.setActions(h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openEditor(null) }, icon('plus'), '新增規則'));

  const countEl = h('span', { class: 'card-sub' });
  const listBody = h('div', null, loadingState());
  root.append(
    h('div', { class: 'toolbar' }, h('div', { class: 'input-icon' }, icon('search'), search), filterSeg),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, icon('message'), '規則列表'), countEl),
      listBody,
      h('div', { class: 'card-note' }, icon('info', 'ic-sm'),
        h('span', null, '修改後立即生效。Discord 上的 /response 指令操作的是同一份資料。')),
    ),
  );

  async function load() {
    try {
      data = await api.get('/api/responses');
      if (!ctx.disposed) renderList();
    } catch (err) {
      if (!ctx.disposed) listBody.replaceChildren(errorState(err, load));
    }
  }

  function allEntries() {
    return TYPES.flatMap((type) => Object.entries(data[type]).map(([keyword, value]) => ({
      type, keyword, messages: Array.isArray(value) ? value : [value],
    })));
  }

  function renderList() {
    if (!data) return;
    const all = allEntries();
    countEl.textContent = `完全匹配 ${Object.keys(data.exact).length} 條・包含匹配 ${Object.keys(data.contains).length} 條`;

    const shown = all.filter((e) => (filterType === 'all' || e.type === filterType)
      && (!query || e.keyword.toLowerCase().includes(query) || e.messages.some((m) => m.toLowerCase().includes(query))));
    if (!shown.length) {
      listBody.replaceChildren(emptyState(all.length ? '沒有符合的規則' : '還沒有任何規則，按右上角「新增規則」開始', 'message'));
      return;
    }

    const rows = shown.map((e) => h('tr', {
      class: 'is-clickable',
      onclick: (ev) => { if (!ev.target.closest('button, a')) openEditor(e); },
    },
      h('td', null, h('span', { class: ['badge', e.type === 'exact' && 'badge-accent'] }, TYPE_LABEL[e.type])),
      h('td', null, h('div', { class: 'kw' }, e.keyword)),
      h('td', null,
        h('div', { class: 'resp-preview' }, e.messages[0]),
        e.messages.length > 1 ? h('span', { class: 'badge' }, `共 ${e.messages.length} 則`) : null,
      ),
      h('td', { class: 'num' }, h('div', { class: 'row-actions' },
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost btn-icon', 'aria-label': `編輯「${e.keyword}」`, onclick: () => openEditor(e) }, icon('edit')),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost btn-icon btn-danger', 'aria-label': `刪除「${e.keyword}」`, onclick: () => remove(e) }, icon('trash')),
      )),
    ));

    listBody.replaceChildren(h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null,
        h('th', null, '類型'), h('th', null, '關鍵字'), h('th', null, '回應'),
        h('th', { class: 'num' }, h('span', { class: 'sr-only' }, '操作')),
      )),
      h('tbody', null, rows),
    )));
  }

  async function remove(entry) {
    const ok = await confirmDialog({
      title: '刪除規則',
      message: `確定要刪除${TYPE_LABEL[entry.type]}「${entry.keyword}」嗎？`,
      confirmText: '刪除',
      danger: true,
    });
    if (!ok) return false;
    try {
      await api.del(qs('/api/responses', { type: entry.type, keyword: entry.keyword }));
      toast('已刪除規則');
      await load();
      return true;
    } catch (err) {
      toastError(err);
      return false;
    }
  }

  function openEditor(entry) {
    const isNew = !entry;
    let type = entry?.type ?? 'exact';
    const typeHint = h('div', { class: 'hint' }, TYPE_HINT[type]);
    const typeSeg = segmented({
      ariaLabel: '匹配類型', value: type, options: typeOptions,
      onChange: (v) => { type = v; typeHint.textContent = TYPE_HINT[v]; },
    });
    const keyword = h('input', { class: 'input', id: 'resp-keyword', value: entry?.keyword ?? '', maxlength: 500, autocomplete: 'off' });

    const list = h('div', { class: 'msg-list' });
    const addBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { addMessage(''); list.lastElementChild?.querySelector('textarea')?.focus(); } },
      icon('plus', 'ic-sm'), '再加一則');

    function renumber() {
      const items = [...list.children];
      items.forEach((item, i) => {
        item.querySelector('.msg-index').textContent = `${i + 1}.`;
        item.querySelector('button').disabled = items.length === 1;
      });
      addBtn.disabled = items.length >= MAX_MESSAGES;
    }

    function addMessage(text) {
      const area = h('textarea', { class: 'textarea', rows: 2, maxlength: MAX_MESSAGE_LENGTH, 'aria-label': '回應內容', value: text });
      const item = h('div', { class: 'msg-item' },
        h('span', { class: 'msg-index' }),
        area,
        h('button', {
          type: 'button', class: 'btn btn-sm btn-ghost btn-icon btn-danger', 'aria-label': '移除這則回應',
          onclick: () => { item.remove(); renumber(); },
        }, icon('x')),
      );
      list.append(item);
      renumber();
    }
    (entry?.messages ?? ['']).forEach(addMessage);

    const snapshot = () => JSON.stringify([type, keyword.value, [...list.querySelectorAll('textarea')].map((t) => t.value)]);
    const initial = snapshot();

    const form = h('form', { class: 'form', novalidate: true, onsubmit: (e) => { e.preventDefault(); save(); } },
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, '匹配類型'), typeSeg, typeHint),
      h('div', { class: 'field' }, h('label', { for: 'resp-keyword' }, '關鍵字'), keyword),
      h('div', { class: 'field' },
        h('span', { class: 'field-label' }, '回應內容'),
        list,
        h('div', { class: 'toolbar' }, addBtn, h('span', { class: 'hint' }, `多則回應會依序各送出一則訊息（最多 ${MAX_MESSAGES} 則）`)),
      ),
    );

    const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => save() }, icon('save', 'ic-sm'), isNew ? '新增' : '儲存');
    const cancelBtn = h('button', { type: 'button', class: 'btn', onclick: () => modal.close() }, '取消');
    const deleteBtn = isNew ? null : h('button', {
      type: 'button', class: 'btn btn-danger',
      onclick: async () => { if (await remove(entry)) modal.close(); },
    }, icon('trash', 'ic-sm'), '刪除');

    const modal = openModal({
      title: isNew ? '新增自動回應' : '編輯自動回應',
      body: form,
      footer: [deleteBtn, h('span', { class: 'spacer' }), cancelBtn, saveBtn],
      beforeClose: () => snapshot() === initial || confirmDialog({ title: '放棄變更？', message: '剛剛輸入的內容還沒有儲存。', confirmText: '放棄' }),
    });
    keyword.focus();

    async function save() {
      const body = {
        type,
        keyword: keyword.value.trim(),
        messages: [...list.querySelectorAll('textarea')].map((t) => t.value.trim()).filter(Boolean),
      };
      if (!body.keyword) { toast('請輸入關鍵字', { type: 'error' }); keyword.focus(); return; }
      if (!body.messages.length) { toast('至少要有一則回應', { type: 'error' }); return; }
      if (entry) body.from = { type: entry.type, keyword: entry.keyword };

      let saved = false;
      await withBusy(saveBtn, async () => {
        try {
          await api.put('/api/responses', body);
        } catch (err) {
          if (err.status !== 409) throw err;
          const overwrite = await confirmDialog({
            title: '關鍵字已經存在',
            message: `${err.message}，要用這次的內容覆蓋它嗎？`,
            confirmText: '覆蓋',
            danger: true,
          });
          if (!overwrite) return;
          await api.put('/api/responses', { ...body, overwrite: true });
        }
        saved = true;
      });
      if (!saved) return;
      modal.close();
      toast(isNew ? '已新增規則' : '已儲存規則');
      await load();
    }
  }

  load();
}
