// 通知與報時：Steam / Epic 限免通知頻道（與 /notify channel 共用）、整點報時（與 /timeannounce 共用）

import { fill, h, icon } from '../dom.js';
import { api, seg } from '../api.js';
import { fmtDateTime } from '../format.js';
import {
  avatar, card, confirmDialog, emptyState, errorState, loadingState, openModal, selectEl, switchControl, toast, withBusy,
} from '../ui.js';

const endDateFmt = new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

// Epic 是 ISO 格式；Steam（GamerPower）是「2026-10-20 23:59:00」或「未知 / 隨時結束」
function formatEndDate(raw) {
  if (!raw) return '未知';
  const d = new Date(String(raw).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(raw) : endDateFmt.format(d);
}

export default function mountNotify(root, ctx) {
  let data = null;
  root.append(loadingState());

  async function load() {
    try {
      data = await api.get('/api/notify');
      if (!ctx.disposed) render();
    } catch (err) {
      if (!ctx.disposed) root.replaceChildren(errorState(err, load));
    }
  }

  function render() {
    root.replaceChildren(
      h('div', { class: 'grid grid-2' }, data.platforms.map(platformCard)),
      announcerCard(),
    );
  }

  // ── 限免通知 ─────────────────────────────────────────────
  function platformCard(p) {
    const taken = new Set(p.channels.map((c) => c.id));
    const groups = data.guilds
      .map((g) => ({
        label: g.name,
        options: g.textChannels
          .filter((c) => !taken.has(c.id))
          .map((c) => ({ value: c.id, label: c.category ? `#${c.name}（${c.category}）` : `#${c.name}` })),
      }))
      .filter((g) => g.options.length);
    const sel = selectEl({ groups, placeholder: '選擇要新增的文字頻道…', ariaLabel: `新增 ${p.name} 通知頻道` });
    const addBtn = h('button', { type: 'button', class: 'btn btn-primary', disabled: true }, icon('plus', 'ic-sm'), '新增');
    sel.addEventListener('change', () => { addBtn.disabled = !sel.value; });
    addBtn.addEventListener('click', async () => {
      const ok = await withBusy(addBtn, () => api.post(`/api/notify/${seg(p.key)}/channels`, { channelId: sel.value }));
      if (ok) { toast(`已新增 ${p.name} 通知頻道`); load(); }
    });

    const rows = p.channels.map((c) => {
      const removeBtn = h('button', {
        type: 'button', class: 'btn btn-sm btn-ghost btn-danger', 'aria-label': `移除 #${c.name ?? c.id}`,
        onclick: async () => {
          const ok = await confirmDialog({
            title: '移除通知頻道',
            message: `之後不會再把 ${p.name} 的限免遊戲推播到 ${c.name ? `#${c.name}` : '這個頻道'}。`,
            confirmText: '移除',
            danger: true,
          });
          if (!ok) return;
          const done = await withBusy(removeBtn, () => api.del(`/api/notify/${seg(p.key)}/channels/${seg(c.id)}`));
          if (done) { toast('已移除'); load(); }
        },
      }, icon('trash', 'ic-sm'), '移除');
      return h('div', { class: 'row' },
        icon('hash'),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' }, c.missing ? '（找不到這個頻道）' : c.name),
          h('div', { class: 'row-sub' }, c.missing ? `${c.id}・頻道可能已刪除，或 Bot 已離開該伺服器` : c.guildName),
        ),
        removeBtn,
      );
    });

    const checkBtn = h('button', { type: 'button', class: 'btn btn-sm', disabled: !p.channels.length, title: p.channels.length ? null : '先新增通知頻道' }, icon('send', 'ic-sm'), '立即檢查並推播');
    checkBtn.addEventListener('click', () => checkNow(p, checkBtn));

    return card({
      title: `${p.name} 限免通知`,
      sub: `${p.channels.length} 個頻道`,
      iconName: 'gift',
      tight: true,
      actions: [
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => previewGames(p) }, icon('search', 'ic-sm'), '查看目前限免'),
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => openHistory(p) }, icon('history', 'ic-sm'), '通知紀錄'),
        checkBtn,
      ],
      body: [
        p.channels.length ? h('div', { class: 'rows' }, rows) : emptyState('還沒有設定通知頻道', 'bell'),
        h('div', { class: 'guild-block' },
          groups.length
            ? h('div', { class: 'add-inline' }, sel, addBtn)
            : h('div', { class: 'hint' }, '沒有其他可以新增的文字頻道'),
        ),
      ],
      note: '每 30 分鐘檢查一次，發現新的限免遊戲就推播到這些頻道（同一款遊戲只通知一次）。',
    });
  }

  async function checkNow(p, button) {
    const ok = await confirmDialog({
      title: `立即檢查 ${p.name} 限免`,
      message: `現在就檢查一次；有還沒通知過的限免遊戲，會馬上推播到 ${p.channels.length} 個通知頻道（和每 30 分鐘的定時檢查是同一個流程，不會重複推播）。`,
      confirmText: '檢查並推播',
    });
    if (!ok) return;
    let result = null;
    const done = await withBusy(button, async () => { result = await api.post(`/api/notify/${seg(p.key)}/check`); });
    if (!done) return;
    if (result.skipped) toast(`沒有檢查：${result.skipped}`, { type: 'info' });
    else if (!result.newGames.length) toast(`目前 ${result.found} 款限免都已經通知過，沒有新遊戲`, { type: 'info' });
    else toast(`已推播 ${result.newGames.length} 款：${result.newGames.join('、')}${result.failed ? `（${result.failed} 則發送失敗，詳見日誌）` : ''}`);
  }

  async function openHistory(p) {
    const body = h('div', null, loadingState());
    openModal({ title: `${p.name} 通知紀錄`, body, wide: true });
    const load = async () => {
      try {
        const { items } = await api.get(`/api/notify/${seg(p.key)}/history`);
        if (!items.length) { fill(body, emptyState('還沒有通知過任何遊戲', 'history')); return; }
        fill(body,
          h('div', { class: 'callout' }, icon('info', 'ic-sm'),
            h('span', null, '同一款遊戲只會通知一次，紀錄保留 90 天。移除紀錄後，下次檢查時如果它還在限免，會再推播一次（例如上次推播失敗）。較舊的紀錄沒有遊戲名稱。')),
          h('div', { class: 'rows history-list' }, items.map((item) => {
            const removeBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost btn-danger' }, icon('trash', 'ic-sm'), '移除紀錄');
            removeBtn.addEventListener('click', async () => {
              const ok = await confirmDialog({
                title: '移除通知紀錄',
                message: `移除「${item.name ?? item.id}」的紀錄後，下次檢查時如果它還在限免，會再推播一次。`,
                confirmText: '移除',
              });
              if (!ok) return;
              const done = await withBusy(removeBtn, () => api.del(`/api/notify/${seg(p.key)}/history/${seg(item.id)}`));
              if (done) { toast('已移除紀錄'); load(); }
            });
            return h('div', { class: 'row' },
              h('div', { class: 'row-main' },
                h('div', { class: 'row-title' }, item.name ?? `（沒有名稱）${item.id}`),
                h('div', { class: 'row-sub' }, `通知時間：${fmtDateTime(item.notifiedAt)}${item.name ? `・ID ${item.id}` : ''}`),
              ),
              removeBtn,
            );
          })),
        );
      } catch (err) {
        fill(body, errorState(err, load));
      }
    };
    load();
  }

  async function previewGames(p) {
    const list = h('div', null, loadingState(`正在向 ${p.name} 查詢…（Steam 需要逐款查詢，可能要十幾秒）`));
    openModal({ title: `${p.name} 目前的限免遊戲`, body: list, wide: true });
    try {
      const { games } = await api.get(`/api/notify/${seg(p.key)}/games`);
      if (!games.length) {
        list.replaceChildren(emptyState('目前沒有偵測到限免遊戲', 'gift'));
        return;
      }
      list.replaceChildren(
        h('div', { class: 'callout' }, icon('info', 'ic-sm'), h('span', null, '這裡只是查詢，不會推播到任何頻道。')),
        h('div', { class: 'games' }, games.map((g) => h('article', { class: 'game' },
          g.image ? h('img', { src: g.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('div', { class: 'np-thumb np-thumb-fallback' }, icon('gift')),
          h('div', null,
            h('a', { class: 'game-title', href: g.url, target: '_blank', rel: 'noopener noreferrer' }, g.name, ' ', icon('external', 'ic-sm')),
            h('div', { class: 'np-meta' },
              g.originalPrice && g.originalPrice !== '未知' ? h('span', null, `原價 ${g.originalPrice} → 免費`) : h('span', null, '免費'),
              h('span', null, `截止：${formatEndDate(g.endDate)}`),
            ),
            g.description ? h('p', { class: 'game-desc' }, g.description) : null,
          ),
        ))),
      );
    } catch (err) {
      list.replaceChildren(errorState(err));
    }
  }

  // ── 整點報時 ─────────────────────────────────────────────
  function announcerCard() {
    const { timezone, sounds } = data.timeAnnouncer;
    const missing = sounds.filter((s) => !s.exists);

    const rows = data.guilds.map((g) => h('div', { class: 'row' },
      avatar({ url: g.iconUrl, name: g.name, size: 'sm', square: true }),
      h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, g.name)),
      switchControl({
        checked: g.timeAnnouncer,
        ariaLabel: `${g.name} 整點報時`,
        onChange: async (on) => {
          await api.put(`/api/time-announcer/${seg(g.id)}`, { enabled: on });
          g.timeAnnouncer = on;
          toast(`${g.name}：整點報時已${on ? '開啟' : '關閉'}`);
        },
      }),
    ));

    const hours = h('div', { class: 'hours' }, sounds.map((s) => h('div', {
      class: ['hour', s.exists ? 'is-ok' : 'is-missing'],
      title: `${s.file}${s.exists ? '' : '（找不到檔案）'}`,
    }, icon(s.exists ? 'check' : 'x'), `${s.hour} 點`)));

    return card({
      title: '整點報時',
      sub: `時區 ${timezone}`,
      iconName: 'clock',
      tight: true,
      body: [
        data.guilds.length ? h('div', { class: 'rows' }, rows) : emptyState('Bot 還沒加入任何伺服器'),
        h('div', { class: 'guild-block' },
          h('div', { class: 'field-label' }, '報時音效（data/timeAnnouncer/）'),
          missing.length
            ? h('div', { class: 'callout callout-warn' }, icon('alert', 'ic-sm'), h('span', null, `缺少 ${missing.length} 個音檔，那幾個整點不會報時`))
            : null,
          hours,
        ),
      ],
      note: '整點時，只在「Bot 正在語音頻道裡」且已開啟的伺服器播放；正在放音樂會先暫停，報完再繼續。',
    });
  }

  load();
}
