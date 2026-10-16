// 數字、時間的顯示格式

const intFmt = new Intl.NumberFormat('zh-TW');
const compactFmt = new Intl.NumberFormat('zh-TW', { notation: 'compact', maximumFractionDigits: 1 });

export const fmtInt = (n) => intFmt.format(Math.round(Number(n) || 0));

/** 一萬以下照常顯示，以上用「1.2萬」「3.4億」 */
export function fmtCompact(n) {
  const v = Number(n) || 0;
  return Math.abs(v) < 10000 ? intFmt.format(Math.round(v)) : compactFmt.format(v);
}

export const fmtPercent = (ratio, digits = 0) => `${(ratio * 100).toFixed(digits)}%`;

/** 秒數 → 「3 天 4 小時」「5 小時 12 分」「12 分 3 秒」 */
export function fmtDuration(totalSec) {
  const sec = Math.max(0, Math.floor(totalSec || 0));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d) return `${d} 天 ${h} 小時`;
  if (h) return `${h} 小時 ${m} 分`;
  if (m) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

/** 毫秒 → 播放時間「3:07」「1:02:03」 */
export function fmtClock(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const timeFmt = new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateTimeFmt = new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export const fmtTime = (ts) => timeFmt.format(new Date(ts));
export const fmtDateTime = (ts) => dateTimeFmt.format(new Date(ts));

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** 'YYYY-MM-DD'（伺服器時區的日期鍵）→ 「10/14」，long 時加上星期 */
export function fmtDayKey(key, long = false) {
  const [y, m, d] = key.split('-').map(Number);
  const short = `${m}/${d}`;
  if (!long) return short;
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${y}/${short}（${weekday}）`;
}
