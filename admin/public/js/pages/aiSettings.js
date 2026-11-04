// AI 設定：模型與額度（唯讀）、使用者人格模式、長期記憶、各伺服器的範圍（多人格／單一人格）、隨機插話機率與頻道開關

import { h, icon } from '../dom.js';
import { api, qs, seg } from '../api.js';
import { fmtDateTime, fmtInt } from '../format.js';
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
      memoryCard(),
      memoriesCard(),
      chanceCard(),
    );
  }

  // ── 清除對話記憶（短期＋個人長期記憶，可選連群組成員記憶）─────────────────
  async function clearMemory(user, button, { scopes = false } = {}) {
    const ok = await confirmDialog({
      title: '清除對話記憶',
      message: `要清除 ${user.name ?? user.id} 和 AI 的對話記憶嗎？之後 AI 不會再參考他先前的對話，並刪除他所有的個人長期記憶`
        + `${scopes ? '，以及他在各單一人格群組記憶裡的成員記憶' : ''}。`,
      confirmText: '清除',
    });
    if (!ok) return;
    let res = null;
    const done = await withBusy(button, async () => { res = await api.post(`/api/ai/memory/${seg(user.id)}`, { scopes }); });
    if (!done) return;
    const extra = [`個人長期記憶 ${res?.facts ?? 0} 條`, scopes ? `成員記憶 ${res?.memberFacts ?? 0} 條` : null].filter(Boolean).join('、');
    toast(`已清除 ${user.name ?? user.id} 的對話記憶（${extra}）`);
  }

  function memoryCard() {
    let chosen = null;
    const scopesSwitch = switchControl({ checked: false, label: '連群組成員記憶一起刪除', onChange: () => {} });
    const clearBtn = h('button', {
      type: 'button', class: 'btn', disabled: true,
      onclick: () => chosen && clearMemory(chosen, clearBtn, { scopes: scopesSwitch.input.checked }),
    }, icon('eraser', 'ic-sm'), '清除記憶');
    const picker = memberPicker((user) => { chosen = user; clearBtn.disabled = !user; });
    return card({
      title: '清除對話記憶',
      iconName: 'eraser',
      body: [
        h('div', { class: 'add-row add-row-2' },
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, '搜尋成員'), picker),
          clearBtn,
        ),
        h('div', { class: 'field' }, scopesSwitch),
      ],
      note: '多人格時 AI 參考同一個頻道最近 10 分鐘內的對話（單一人格是整個頻道最近 30 分鐘）；清除後，在那之前的訊息都不會再被當成上下文，Bot 重新啟動後仍然有效。同時會刪除他所有伺服器的個人長期記憶。',
    });
  }

  // ── 長期記憶（摺疊；展開時才載入）──────────────────────
  function memoriesCard() {
    const userBody = h('div', null);
    const scopeBody = h('div', null);
    let loaded = false;

    const fmtExpire = (ts) => (ts ? `到 ${fmtDateTime(ts)}` : null);
    const factRow = (f, { del, meta = [] }) => {
      const btn = h('button', {
        type: 'button', class: 'btn btn-sm btn-ghost btn-danger', 'aria-label': '刪除這條記憶',
        onclick: async () => {
          const ok = await confirmDialog({ title: '刪除記憶', message: `要刪除「${f.text}」嗎？之後 AI 也不會再學回同樣的內容。`, confirmText: '刪除', danger: true });
          if (!ok) return;
          const done = await withBusy(btn, () => api.del(del));
          if (done) { row.remove(); toast('已刪除'); }
        },
      }, icon('trash', 'ic-sm'));
      const row = h('div', { class: 'row' },
        h('div', { class: 'row-main' },
          h('div', null, h('span', { class: 'mono hint' }, f.id), ' ', f.text),
          h('div', { class: 'hint' }, [f.category, ...meta, fmtExpire(f.expiresAt)].filter(Boolean).join(' · ')),
        ),
        btn,
      );
      return row;
    };

    async function loadAll() {
      loaded = true;
      userBody.replaceChildren(loadingState());
      scopeBody.replaceChildren(loadingState());
      try {
        const [u, sc] = await Promise.all([api.get(qs('/api/ai/memories', { type: 'user' })), api.get(qs('/api/ai/memories', { type: 'scope' }))]);
        if (ctx.disposed) return;
        userBody.replaceChildren(...(u.users.length
          ? u.users.map((e) => h('details', { class: 'disclosure' },
            h('summary', null, icon('chevron'), `${e.user?.name ?? e.user?.id}（${e.facts.length} 條）`),
            h('div', { class: 'rows' }, e.facts.map((f) => factRow(f, {
              del: `/api/ai/memories/user/${seg(e.user.id)}/${seg(f.id)}`,
              meta: [f.originName, f.persona],
            }))),
          ))
          : [emptyState('還沒有任何個人長期記憶', 'user')]));
        scopeBody.replaceChildren(...(sc.scopes.length
          ? sc.scopes.map((e) => h('details', { class: 'disclosure' },
            h('summary', null, icon('chevron'), `${e.name}（${e.scopeKey}）`),
            h('div', { class: 'rows' },
              e.groupFacts.map((f) => factRow(f, {
                del: `/api/ai/memories/scope/${seg(e.scopeKey)}/${seg(f.id)}`,
                meta: ['群組', f.reportedBy ? `由 ${f.reportedBy.name ?? f.reportedBy.id} 提供` : null],
              })),
              e.members.flatMap((m) => m.facts.map((f) => factRow(f, {
                del: `/api/ai/memories/scope/${seg(e.scopeKey)}/${seg(f.id)}`,
                meta: [`成員：${m.user?.name ?? m.name ?? m.user?.id}`],
              }))),
            ),
          ))
          : [emptyState('還沒有任何群組公用記憶', 'message')]));
      } catch (err) {
        loaded = false;
        if (!ctx.disposed) userBody.replaceChildren(errorState(err, loadAll));
        scopeBody.replaceChildren();
      }
    }

    const reloadBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => loadAll() }, icon('refresh', 'ic-sm'), '重新載入');
    const wrap = h('details', { class: 'disclosure' },
      h('summary', null, icon('chevron'), '展開記憶清單'),
      h('div', { class: 'form' },
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, '個人記憶（多人格）'), userBody),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, '群組公用記憶（單一人格）'), scopeBody),
        h('div', null, reloadBtn),
      ),
    );
    wrap.addEventListener('toggle', () => { if (wrap.open && !loaded) loadAll(); });
    return card({
      title: '長期記憶',
      iconName: 'list',
      body: wrap,
      note: '個人記憶只在同一個伺服器（或私訊）裡使用；群組公用記憶屬於單一人格的伺服器或頻道。刪除的內容 30 天內不會被重新學回來。成員也可以用 /ai memory 自己查看、刪除或關閉。',
    });
  }

  // ── 範圍：多人格／單一人格（每個伺服器一個下拉選單＋整理公用記憶開關）──────
  function scopeControls(g) {
    const current = g.scope?.kind === 'single' && g.scope.persona ? `single:${g.scope.persona}` : 'multi';
    const options = [
      { value: 'multi', label: '多人格（每人各自的人格）' },
      ...data.modes.map((m) => ({ value: `single:${m.key}`, label: `單一人格：${m.name && m.name !== m.key ? `${m.name}（${m.key}）` : m.key}` })),
    ];
    let saved = current;
    const sel = selectEl({
      options,
      value: current,
      ariaLabel: `${g.name} 的 AI 範圍`,
      onchange: async () => {
        const value = sel.value;
        sel.disabled = true;
        try {
          const [kind, persona = null] = value.split(':');
          await api.put(`/api/ai/scope/${seg(g.id)}`, kind === 'single' ? { kind, persona } : { kind });
          saved = value;
          g.scope = { ...(g.scope ?? {}), kind, persona };
          toast(`${g.name} 已設為${kind === 'single' ? `單一人格「${modeLabel(persona)}」` : '多人格'}`);
        } catch (err) {
          sel.value = saved;
          toastError(err);
        } finally {
          sel.disabled = false;
        }
      },
    });
    const extract = switchControl({
      checked: g.scope?.memoryExtract !== false,
      label: '整理成公用記憶',
      onChange: async (on) => {
        await api.put(`/api/ai/scope/${seg(g.id)}`, { memoryExtract: on });
        g.scope = { ...(g.scope ?? {}), memoryExtract: on };
        toast(`${g.name}：${on ? '開啟' : '關閉'}整理公用記憶`);
      },
    });

    const overrides = Object.entries(g.channelScopes ?? {});
    const overrideRows = overrides.map(([id, e]) => {
      const desc = [
        e.kind === 'single' ? `單一人格「${e.personaName ?? e.persona}」` : e.kind === 'multi' ? '多人格' : '沿用伺服器設定',
        typeof e.memoryExtract === 'boolean' ? `整理公用記憶${e.memoryExtract ? '開' : '關'}` : null,
      ].filter(Boolean).join('、');
      const btn = h('button', {
        type: 'button', class: 'btn btn-sm btn-ghost btn-danger', 'aria-label': `移除 #${e.name ?? id} 的覆寫`,
        onclick: async () => {
          const done = await withBusy(btn, () => api.del(`/api/ai/scope/channel/${seg(id)}`));
          if (done) { row.remove(); toast('已移除頻道覆寫'); }
        },
      }, icon('trash', 'ic-sm'), '移除');
      const row = h('div', { class: 'row' },
        h('span', { class: 'channel-name' }, icon('hash', 'ic-sm'), h('span', null, e.name ?? id)),
        h('span', { class: 'hint' }, desc),
        btn,
      );
      return row;
    });

    return [
      h('div', { class: 'add-row add-row-2' },
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'AI 範圍'), sel),
        h('div', { class: 'field' }, extract),
      ),
      overrides.length
        ? h('details', { class: 'disclosure' },
          h('summary', null, icon('chevron'), `頻道覆寫（${overrides.length}）`),
          h('div', { class: 'rows' }, overrideRows),
        )
        : null,
    ];
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
      const memoryBtn = h('button', {
        type: 'button', class: 'btn btn-sm btn-ghost', 'aria-label': `清除 ${entry.user?.name ?? entry.user?.id} 的對話記憶`,
        onclick: () => clearMemory(entry.user, memoryBtn),
      }, icon('eraser', 'ic-sm'), '清除記憶');
      return h('tr', null,
        h('td', null, userCell(entry.user)),
        h('td', { 'data-label': '人格模式' }, sel),
        h('td', { class: 'num', 'data-label': '' }, h('div', { class: 'row-actions' }, memoryBtn, removeBtn)),
      );
    });

    return card({
      title: '使用者人格模式',
      sub: `${data.userModes.length} 人`,
      iconName: 'sparkle',
      tight: true,
      body: [
        data.userModes.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'table table-stack' },
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
        ...scopeControls(g),
        g.channels.length
          ? h('details', { class: 'disclosure' },
            h('summary', null, icon('chevron'), `頻道開關（${g.channels.length - disabledCount} 開 / ${disabledCount} 關）`),
            channelList,
          )
          : null,
      );
    });

    return card({
      title: '伺服器：範圍與隨機插話',
      sub: `預設插話 ${Math.round(def * 100)}%`,
      iconName: 'message',
      tight: true,
      body: blocks.length ? blocks : emptyState('Bot 還沒加入任何伺服器'),
      note: 'AI 範圍：多人格時每個人用自己的人格；單一人格時整個伺服器（沒有自己覆寫的頻道）共用同一個人格與群組記憶。頻道覆寫請在 Discord 用 /ai scope set channel:true 設定。'
        + '插話機率是 Bot 對一般訊息隨機插話的機率；頻道開關關閉後，該頻道不會隨機插話（被 @ 提及時仍會回覆）。也可以用 /ai chance 設定。',
    });
  }

  load();
}
