// AI 設定：模型與額度（唯讀）、使用者人格模式、各伺服器的隨機插話機率與頻道開關

import { h, icon } from '../dom.js';
import { api, qs, seg } from '../api.js';
import { fmtInt } from '../format.js';
import {
  avatar, card, confirmDialog, emptyState, errorState, loadingState, selectEl, switchControl, toast, toastError, userCell, withBusy,
} from '../ui.js';

const SEARCH_DEBOUNCE_MS = 300;

export default function mountAiSettings(root, ctx) {
  let data = null;

  root.append(loadingState());

  async function load() {
    try {
      data = await api.get('/api/ai/settings');
      if (!ctx.disposed) render();
    } catch (err) {
      if (!ctx.disposed) root.replaceChildren(errorState(err, load));
    }
  }

  const modeOptions = () => data.modes.map((m) => ({ value: m.key, label: m.name && m.name !== m.key ? `${m.name}（${m.key}）` : m.key }));
  const modeLabel = (key) => {
    const m = data.modes.find((x) => x.key === key);
    return m ? (m.name || m.key) : key;
  };

  function render() {
    root.replaceChildren(
      h('div', { class: 'grid grid-2' }, modelCard(), specialCard()),
      userModesCard(),
      chanceCard(),
    );
  }

  // ── 模型與額度（環境變數，唯讀）───────────────────────────
  function modelCard() {
    const { limits } = data;
    const limit = (n, unit) => (n > 0 ? `${fmtInt(n)} ${unit}` : '不限制');
    return card({
      title: '模型與額度',
      iconName: 'sliders',
      body: h('dl', { class: 'kv' },
        h('dt', null, '對話模型'), h('dd', { class: 'mono' }, data.model),
        h('dt', null, '帳單辨識模型'), h('dd', { class: 'mono' }, data.visionModel),
        h('dt', null, '每人頻率限制'), h('dd', null, limits.userRateLimit > 0 ? `${limits.userRateLimit} 次 / ${limits.userRateWindowSec} 秒` : '不限制'),
        h('dt', null, '每人每日上限'), h('dd', null, limit(limits.userDailyBudget, 'tokens')),
        h('dt', null, '全體每日上限'), h('dd', null, limit(limits.dailyBudget, 'tokens')),
        h('dt', null, 'Google 搜尋'), h('dd', null, data.searchGuilds.length
          ? data.searchGuilds.map((g) => g.name ?? g.id).join('、')
          : '停用'),
      ),
      note: '這些設定來自環境變數（GEMINI_MODEL、AI_* 、GEMINI_SEARCH_GUILD_IDS），修改後需要重新啟動 Bot。擁有者不受每人限制。',
    });
  }

  function specialCard() {
    const group = (title, mode, users) => h('div', { class: 'field' },
      h('span', { class: 'field-label' }, `${title}（${mode}）`),
      users.length
        ? h('div', { class: 'rows' }, users.map((u) => h('div', { class: 'row' }, userCell(u))))
        : h('div', { class: 'hint' }, '未設定'),
    );
    return card({
      title: '特殊身分',
      iconName: 'user',
      body: h('div', { class: 'form' },
        group('戀人模式', 'lover', data.specialUsers.lover),
        group('開發者模式', 'developer', data.specialUsers.developer),
      ),
      note: '由環境變數 LOVER_MODE_USER_IDS、DEVELOPER_MODE_USER_IDS 指定。下方「使用者人格模式」的設定優先於這裡。',
    });
  }

  // ── 使用者人格模式 ───────────────────────────────────────
  function userModesCard() {
    const rows = data.userModes.map((entry) => {
      const sel = selectEl({
        options: modeOptions(),
        value: data.modes.some((m) => m.key === entry.mode) ? entry.mode : '',
        placeholder: data.modes.some((m) => m.key === entry.mode) ? null : `（${entry.mode} 已不存在）`,
        ariaLabel: `${entry.user?.name ?? entry.user?.id} 的人格模式`,
        onchange: async () => {
          const prev = entry.mode;
          sel.disabled = true;
          try {
            await api.put(`/api/ai/user-modes/${seg(entry.user.id)}`, { mode: sel.value });
            entry.mode = sel.value;
            toast(`已將 ${entry.user.name ?? entry.user.id} 設為「${modeLabel(sel.value)}」`);
          } catch (err) {
            sel.value = prev;
            toastError(err);
          } finally {
            sel.disabled = false;
          }
        },
      });
      const removeBtn = h('button', {
        type: 'button', class: 'btn btn-sm btn-ghost btn-danger', 'aria-label': '移除指定',
        onclick: async () => {
          const ok = await confirmDialog({
            title: '移除人格指定',
            message: `移除後，${entry.user?.name ?? entry.user?.id} 會回到預設判斷（特殊身分或預設模式 ${data.defaultMode}）。`,
            confirmText: '移除',
          });
          if (!ok) return;
          const done = await withBusy(removeBtn, () => api.del(`/api/ai/user-modes/${seg(entry.user.id)}`));
          if (done) { toast('已移除'); load(); }
        },
      }, icon('trash', 'ic-sm'), '移除');
      return h('tr', null,
        h('td', null, userCell(entry.user)),
        h('td', null, sel),
        h('td', { class: 'num' }, removeBtn),
      );
    });

    return card({
      title: '使用者人格模式',
      sub: `${data.userModes.length} 人`,
      iconName: 'sparkle',
      tight: true,
      body: [
        data.userModes.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
            h('thead', null, h('tr', null, h('th', null, '使用者'), h('th', null, '人格模式'), h('th', { class: 'num' }, h('span', { class: 'sr-only' }, '操作')))),
            h('tbody', null, rows),
          ))
          : emptyState('還沒有指定任何人的人格模式', 'user'),
        h('div', { class: 'guild-block' }, addUserModeForm()),
      ],
      note: `優先順序：這裡的指定 → 特殊身分 → 預設模式「${modeLabel(data.defaultMode)}」。也可以在 Discord 用 /ai mode 設定。`,
    });
  }

  function addUserModeForm() {
    let chosen = null;
    const picker = memberPicker((user) => { chosen = user; addBtn.disabled = !chosen; });
    const modeSel = selectEl({ options: modeOptions(), value: data.defaultMode, ariaLabel: '要指定的人格模式' });
    const addBtn = h('button', {
      type: 'button', class: 'btn btn-primary', disabled: true,
      onclick: async () => {
        if (!chosen) return;
        const done = await withBusy(addBtn, () => api.put(`/api/ai/user-modes/${seg(chosen.id)}`, { mode: modeSel.value }));
        if (done) { toast(`已將 ${chosen.name} 設為「${modeLabel(modeSel.value)}」`); load(); }
      },
    }, icon('plus', 'ic-sm'), '指定');

    return h('div', { class: 'add-row' },
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, '新增指定：搜尋成員'), picker),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, '人格模式'), modeSel),
      addBtn,
    );
  }

  /** 成員搜尋：輸入名稱（或貼上使用者 ID）→ 從 Bot 所在的伺服器找人 */
  function memberPicker(onPick) {
    const listId = `member-list-${Math.random().toString(36).slice(2, 8)}`;
    const input = h('input', {
      class: 'input', type: 'search', placeholder: '輸入名稱或使用者 ID', autocomplete: 'off',
      role: 'combobox', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-autocomplete': 'list',
    });
    const listEl = h('ul', { class: 'combo-list', id: listId, role: 'listbox', hidden: true });
    const wrap = h('div', { class: 'combo' }, h('div', { class: 'input-icon' }, icon('search'), input), listEl);
    let results = [];
    let active = -1;
    let timer = null;
    let reqToken = 0;

    function showList(show) {
      listEl.hidden = !show;
      input.setAttribute('aria-expanded', String(show));
    }

    function paintActive() {
      [...listEl.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
      if (active >= 0) input.setAttribute('aria-activedescendant', `${listId}-${active}`);
      else input.removeAttribute('aria-activedescendant');
    }

    function choose(user) {
      showList(false);
      onPick(user);
      const chip = h('div', { class: 'chosen' },
        avatar({ url: user.avatarUrl, name: user.name, size: 'sm' }),
        h('div', { class: 'row-main' },
          h('div', { class: 'user-cell-name truncate' }, user.displayName || user.name),
          h('div', { class: 'user-cell-sub truncate' }, `@${user.username}${user.guildName ? ` · ${user.guildName}` : ''}`),
        ),
        h('button', {
          type: 'button', class: 'btn btn-sm btn-ghost btn-icon', 'aria-label': '重新選擇',
          onclick: () => { chip.replaceWith(wrap); input.value = ''; onPick(null); input.focus(); },
        }, icon('x')),
      );
      wrap.replaceWith(chip);
    }

    async function search(q) {
      const token = ++reqToken;
      try {
        const res = await api.get(qs('/api/members/search', { q }));
        if (token !== reqToken) return;
        results = res.members;
        active = results.length ? 0 : -1;
        listEl.replaceChildren(...(results.length
          ? results.map((u, i) => h('li', {
            class: 'combo-option', role: 'option', id: `${listId}-${i}`,
            onmousedown: (e) => { e.preventDefault(); choose(u); },
          },
            avatar({ url: u.avatarUrl, name: u.name, size: 'sm' }),
            h('div', { class: 'row-main' },
              h('div', { class: 'truncate' }, u.displayName || u.name),
              h('div', { class: 'user-cell-sub truncate' }, `@${u.username}${u.guildName ? ` · ${u.guildName}` : ''}`),
            )))
          : [h('li', { class: 'combo-empty' }, '找不到符合的成員')]));
        paintActive();
        showList(true);
      } catch (err) {
        if (token === reqToken) toastError(err);
      }
    }

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { showList(false); return; }
      timer = setTimeout(() => search(q), SEARCH_DEBOUNCE_MS);
    });
    input.addEventListener('keydown', (e) => {
      if (listEl.hidden || !results.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % results.length; paintActive(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + results.length) % results.length; paintActive(); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(results[active]); }
      else if (e.key === 'Escape') { e.preventDefault(); showList(false); }
    });
    input.addEventListener('blur', () => setTimeout(() => showList(false), 120));
    ctx.onCleanup(() => clearTimeout(timer));
    return wrap;
  }

  // ── 隨機插話 ─────────────────────────────────────────────
  function chanceCard() {
    const def = data.replyChance.default;
    const blocks = data.replyChance.guilds.map((g) => {
      let saved = g.chance;
      const effective = () => (saved ?? def);
      const valueEl = h('span', { class: 'chance-value' });
      const range = h('input', {
        class: 'range', type: 'range', min: 0, max: 100, step: 1, value: Math.round(effective() * 100),
        'aria-label': `${g.name} 的插話機率`,
      });
      const resetBtn = h('button', { type: 'button', class: 'btn btn-sm' }, '重設為預設');
      const paint = () => {
        valueEl.textContent = `${range.value}%`;
        resetBtn.hidden = saved == null;
      };
      range.addEventListener('input', paint);
      range.addEventListener('change', async () => {
        const chance = Number(range.value) / 100;
        try {
          await api.put(`/api/ai/chance/${seg(g.id)}`, { chance });
          saved = chance;
          toast(`${g.name} 的插話機率已設為 ${range.value}%`);
        } catch (err) {
          range.value = Math.round(effective() * 100);
          toastError(err);
        }
        paint();
      });
      resetBtn.addEventListener('click', async () => {
        const done = await withBusy(resetBtn, () => api.del(`/api/ai/chance/${seg(g.id)}`));
        if (!done) return;
        saved = null;
        range.value = Math.round(def * 100);
        paint();
        toast(`${g.name} 已恢復預設機率`);
      });
      paint();

      const disabledCount = g.channels.filter((c) => c.disabled).length;
      const channelList = h('div', { class: 'channel-toggles' }, g.channels.map((c) => h('div', { class: 'channel-toggle' },
        h('span', { class: 'channel-name' }, icon(c.kind === 'voice' ? 'volume' : 'hash', 'ic-sm'), h('span', null, c.name ?? c.id)),
        switchControl({
          checked: !c.disabled,
          ariaLabel: `#${c.name ?? c.id} 隨機插話`,
          onChange: async (on) => {
            await api.put(`/api/ai/channels/${seg(c.id)}`, { disabled: !on });
            c.disabled = !on;
          },
        }),
      )));

      return h('div', { class: 'guild-block' },
        h('div', { class: 'chance-row' },
          h('div', { class: 'guild-title' }, avatar({ url: g.iconUrl, name: g.name, size: 'sm', square: true }), h('span', { class: 'truncate' }, g.name)),
          range,
          valueEl,
          resetBtn,
        ),
        g.channels.length
          ? h('details', { class: 'disclosure' },
            h('summary', null, icon('chevron'), `頻道開關（${g.channels.length - disabledCount} 開 / ${disabledCount} 關）`),
            channelList,
          )
          : null,
      );
    });

    return card({
      title: '隨機插話',
      sub: `預設 ${Math.round(def * 100)}%`,
      iconName: 'message',
      tight: true,
      body: blocks.length ? blocks : emptyState('Bot 還沒加入任何伺服器'),
      note: 'Bot 對一般訊息隨機插話的機率；頻道開關關閉後，該頻道不會隨機插話（被 @ 提及時仍會回覆）。也可以用 /ai chance 設定。',
    });
  }

  load();
}
