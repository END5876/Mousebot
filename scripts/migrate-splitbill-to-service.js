'use strict';
/**
 * 一次性遷移腳本：把舊的本地 data/splitbill.json 上傳到獨立部署的 splitbill-service。
 *
 * 用法（在原本 Bot 服務的「服務狀態 → 指令」執行，需要能讀到舊的 data/ Volume）：
 *   node scripts/migrate-splitbill-to-service.js --dry-run   # 只列出會做什麼，不寫入
 *   node scripts/migrate-splitbill-to-service.js             # 實際上傳
 *
 * 需要環境變數：SPLITBILL_SERVICE_URL、SPLITBILL_SERVICE_KEY（或 SPLITBILL_API_KEY）。
 * 可用 SPLITBILL_LEGACY_FILE 指定舊檔路徑（預設 data/splitbill.json）。
 *
 * 行為：
 *  - 已存在於 service 的行程一律略過（不覆蓋 service 上可能更新的資料），所以可安全重跑。
 *  - 每個 guild 先上傳「預設行程」，讓 service 把它設成 defaultTripId，其餘行程接著上傳。
 *  - 上傳後再逐一還原每位使用者的作用行程（activeTripByUser）。
 *  - 舊檔案完全不會被修改或刪除。
 * 確認遷移完成、服務運作正常後，這支腳本就可以刪掉（不屬於長期系統的一部分）。
 */
const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry-run');
const FILE = process.env.SPLITBILL_LEGACY_FILE || path.join(__dirname, '..', 'data', 'splitbill.json');
const URL_BASE = (process.env.SPLITBILL_SERVICE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SPLITBILL_SERVICE_KEY || process.env.SPLITBILL_API_KEY || '';

async function api(method, p, body) {
  const res = await fetch(`${URL_BASE}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(KEY ? { 'x-api-key': KEY } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

(async () => {
  if (!URL_BASE) throw new Error('請先設定 SPLITBILL_SERVICE_URL');
  if (!fs.existsSync(FILE)) throw new Error(`找不到舊資料檔：${FILE}`);
  const all = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const stats = { uploaded: 0, skipped: 0, failed: 0, active: 0 };

  for (const [guildId, guild] of Object.entries(all)) {
    const trips = Object.values((guild && guild.trips) || {});
    const defaultId = guild.defaultTripId || guild.activeTripId || null;
    trips.sort((a, b) => (b.id === defaultId) - (a.id === defaultId)); // 預設行程排最前面
    console.log(`\n[guild ${guildId}] ${trips.length} 個行程，預設：${defaultId || '（無）'}`);

    for (const trip of trips) {
      const exists = await api('GET', `/trip/${encodeURIComponent(guildId)}/${encodeURIComponent(trip.id)}`);
      if (exists.ok) { console.log(`  ⏭  略過（service 已有）：${trip.name} (${trip.id})`); stats.skipped++; continue; }
      if (exists.status !== 404) { console.error(`  ❌ 查詢失敗 ${trip.id}: HTTP ${exists.status}`); stats.failed++; continue; }
      if (DRY) { console.log(`  🔎 [dry-run] 會上傳：${trip.name} (${trip.id}) 支出 ${(trip.expenses || []).length} 筆`); continue; }
      const { updatedAt, ...payload } = trip; // 新建立時不需要版本號
      const r = await api('PUT', `/trip/${encodeURIComponent(guildId)}/${encodeURIComponent(trip.id)}`, payload);
      if (r.ok) { console.log(`  ✅ 已上傳：${trip.name} (${trip.id})`); stats.uploaded++; }
      else { console.error(`  ❌ 上傳失敗 ${trip.id}: ${r.data.error || 'HTTP ' + r.status}`); stats.failed++; }
    }

    for (const [userId, tripId] of Object.entries(guild.activeTripByUser || {})) {
      if (!guild.trips || !guild.trips[tripId]) continue;
      if (DRY) { console.log(`  🔎 [dry-run] 會還原作用行程：${userId} → ${tripId}`); continue; }
      const r = await api('PATCH', `/guild/${encodeURIComponent(guildId)}/active-trip`, { userId, tripId });
      if (r.ok) stats.active++;
      else console.error(`  ⚠️ 還原作用行程失敗 ${userId}: ${r.data.error || 'HTTP ' + r.status}`);
    }
  }

  console.log(`\n完成${DRY ? '（dry-run，未寫入）' : ''}：上傳 ${stats.uploaded}、略過 ${stats.skipped}、失敗 ${stats.failed}、還原作用行程 ${stats.active}`);
  process.exit(stats.failed ? 1 : 0);
})().catch((e) => { console.error('遷移失敗：', e.message); process.exit(1); });
