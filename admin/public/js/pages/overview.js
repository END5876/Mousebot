// 總覽：Bot 狀態、外部服務、今日 AI 用量、語音連線、模組開機摘要、伺服器清單

import { h, icon, setVar } from '../dom.js';
import { api } from '../api.js';
import { fmtCompact, fmtDuration, fmtInt, fmtPercent } from '../format.js';
import { avatar, card, emptyState, errorState, loadingState, statusBadge, toastError } from '../ui.js';

const CHECK = {
  ok: ['good', '正常'],
  recovering: ['warn', '重新連線中'],
  down: ['bad', '離線'],
  disabled: ['neutral', '未設定'],
};
const MODULE = { ok: ['is-good', 'check', '正常'], warn: ['is-warn', 'alert', '降級運作'], off: ['is-off', 'x', '未啟用'] };
const VOICE = { ready: ['good', '已連線'], signalling: ['warn', '連線中'], connecting: ['warn', '連線中'], disconnected: ['bad', '已斷線'] };

function stat(label, value, sub, extra) {
  return h('div', { class: 'stat' },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value' }, value),
    sub ? h('div', { class: 'stat-sub' }, sub) : null,
    extra,
  );
}

function budgetMeter(used, budget) {
  const ratio = budget > 0 ? used / budget : 0;
  const meter = h('div', {
    class: ['meter', ratio >= 1 ? 'is-bad' : ratio >= 0.8 && 'is-warn'],
    role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': budget, 'aria-valuenow': Math.min(used, budget),
    'aria-label': '今日 token 預算使用量',
  }, h('span'));
  setVar(meter, '--w', `${Math.min(100, ratio * 100)}%`);
  return meter;
}

function checkRow(name, check, detail) {
  const [kind, text] = CHECK[check.status] ?? CHECK.down;
  return h('div', { class: 'row' },
    h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, name), detail ? h('div', { class: 'row-sub' }, detail) : null),
    statusBadge(kind, text),
  );
}

function probeDetail(check) {
  if (check.status === 'disabled') return '未設定位址';
  if (check.error) return check.error === 'timeout' ? '逾時沒有回應' : check.error;
  return check.httpStatus ? `HTTP ${check.httpStatus}` : null;
}

export default function mountOverview(root, ctx) {
  let loaded = false;
  const refreshBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => load(true) }, icon('refresh', 'ic-sm'), '重新整理');
  ctx.setActions(refreshBtn);
  root.append(loadingState());

  async function load(manual = false) {
    if (loaded) root.classList.add('is-refreshing');
    try {
      const data = await api.get('/api/overview');
      if (ctx.disposed) return;
      render(data);
      loaded = true;
      if (manual) ctx.refreshBotChip();
    } catch (err) {
      if (ctx.disposed) return;
      if (!loaded) root.replaceChildren(errorState(err, () => load(true)));
      else if (manual) toastError(err);
    } finally {
      root.classList.remove('is-refreshing');
    }
  }

  function render(d) {
    const { checks } = d.health;
    const discord = checks.discord;
    const [dKind, dText] = CHECK[discord.status] ?? CHECK.down;

    const hero = h('section', { class: 'card hero' },
      avatar({ url: d.bot?.avatarUrl, name: d.bot?.name, size: 'lg' }),
      h('div', { class: 'row-main' },
        h('div', { class: 'hero-name' }, d.bot?.name ?? 'Mousebot'),
        h('div', { class: 'hero-meta' },
          d.bot ? h('span', { class: 'mono' }, d.bot.tag) : h('span', null, '尚未登入 Discord'),
          statusBadge(dKind, `Discord ${dText}`),
        ),
      ),
      h('div', { class: 'hero-aside' },
        statusBadge('neutral', `Node ${d.runtime.node}`),
        statusBadge('neutral', `LOG_LEVEL=${d.runtime.logLevel}`),
      ),
    );

    const { usage } = d;
    const budget = usage.limits.dailyBudget;
    const stats = h('div', { class: 'stats' },
      stat('運行時間', fmtDuration(d.health.uptimeSec)),
      stat('記憶體', `${fmtInt(d.health.memoryMB)} MB`, '程序常駐記憶體（RSS）'),
      stat('Discord 延遲', discord.ping >= 0 ? `${fmtInt(discord.ping)} ms` : '—', `WebSocket：${discord.wsStatus}`),
      stat('伺服器', fmtInt(d.guilds.length), `${fmtInt(d.voice.length)} 個語音連線`),
      stat('今日 AI 用量', `${fmtCompact(usage.billable)} tokens`,
        budget > 0 ? `全體每日上限 ${fmtCompact(budget)}（已用 ${fmtPercent(usage.billable / budget)}）` : `${fmtInt(usage.total.calls)} 次呼叫`,
        budget > 0 ? budgetMeter(usage.billable, budget) : null),
    );

    const services = card({
      title: '外部服務',
      iconName: 'server',
      body: h('div', { class: 'rows' },
        checkRow('Discord Gateway', discord, `狀態 ${discord.wsStatus}・${fmtInt(discord.guilds)} 個伺服器`),
        checkRow('喚醒詞服務（OWW）', checks.oww, probeDetail(checks.oww)),
        checkRow('YouTube PO Token 服務', checks.potProvider, probeDetail(checks.potProvider)),
      ),
      tight: true,
      note: 'Discord 斷線超過 60 秒時，健康檢查會回報不健康；其他服務離線時 Bot 會降級運作。',
    });

    const voice = card({
      title: '語音連線',
      iconName: 'headphones',
      actions: h('a', { class: 'btn btn-sm', href: '#/voice' }, '前往控制', icon('chevron', 'ic-sm')),
      tight: true,
      body: d.voice.length
        ? h('div', { class: 'rows' }, d.voice.map((v) => {
          const [kind, text] = VOICE[v.status] ?? ['warn', v.status];
          const parts = [v.channelName ? `🔊 ${v.channelName}` : '頻道未知'];
          if (v.listeners != null) parts.push(`${v.listeners} 人在頻道`);
          return h('div', { class: 'row' },
            h('div', { class: 'row-main' },
              h('div', { class: 'row-title' }, v.guildName),
              h('div', { class: 'row-sub' }, parts.join('・')),
              v.nowPlaying ? h('div', { class: 'row-sub truncate' }, icon('music', 'ic-sm'), ' ', v.nowPlaying, v.queueLength ? `（佇列 ${v.queueLength} 首）` : '') : null,
            ),
            statusBadge(kind, text),
          );
        }))
        : emptyState('Bot 目前不在任何語音頻道', 'volume'),
    });

    const modules = card({
      title: '模組狀態',
      sub: '開機時回報',
      iconName: 'sliders',
      tight: true,
      body: h('div', { class: 'rows' }, d.modules.map((m) => {
        const [cls, ic, label] = MODULE[m.status] ?? MODULE.off;
        return h('div', { class: 'row module-row' },
          h('span', { class: ['status-ic', cls], title: label, 'aria-label': label, role: 'img' }, icon(ic)),
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title' }, m.name),
            m.detail ? h('div', { class: 'row-sub' }, m.detail) : null,
          ),
        );
      })),
    });

    const guilds = card({
      title: '伺服器',
      sub: `${d.guilds.length} 個`,
      iconName: 'server',
      tight: true,
      body: d.guilds.length
        ? h('div', { class: 'rows' }, d.guilds.map((g) => h('div', { class: 'row' },
          avatar({ url: g.iconUrl, name: g.name, square: true }),
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title' }, g.name),
            h('div', { class: 'row-sub mono' }, g.id),
          ),
          g.memberCount != null ? h('span', { class: 'badge' }, icon('user'), fmtInt(g.memberCount)) : null,
        )))
        : emptyState('Bot 還沒加入任何伺服器'),
    });

    root.replaceChildren(
      hero,
      stats,
      h('div', { class: 'grid grid-2' }, services, voice),
      h('div', { class: 'grid grid-2' }, modules, guilds),
    );
  }

  load();
  ctx.poll(load, 15000);
}
