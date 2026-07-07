'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── 統一寫入專案根目錄的 data/ 資料夾（與其他模組的持久化資料同層）──
const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'splitbill.json');

// ---------- 預設欄位（用於資料防呆 / 自動補齊） ----------
const DEFAULT_TRIP = () => ({
  id: '',
  name: '',
  baseCurrency: 'TWD',
  rates: { TWD: 1 }, // rates[currency] = 該幣別兌基準幣的匯率 (1 該幣別 = rate 基準幣)
  members: [],        // [{ id, name }]
  expenses: [],        // [{ id, description, amount, currency, amountInBase, payers, participants, createdAt, createdBy }]
  archived: false,
  createdAt: Date.now(),
});

const DEFAULT_GUILD = () => ({
  activeTripId: null,
  trips: {},
});

function genId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2), 'utf8');
  }
}

/**
 * 資料防呆與自動修復：
 * 補齊缺漏欄位、修正舊版格式，避免程式因缺欄位而崩潰。
 */
function repairTrip(rawTrip) {
  const def = DEFAULT_TRIP();
  const trip = { ...def, ...(rawTrip || {}) };

  trip.rates = { ...def.rates, ...(rawTrip && rawTrip.rates ? rawTrip.rates : {}) };
  if (!trip.rates[trip.baseCurrency]) trip.rates[trip.baseCurrency] = 1;

  trip.members = Array.isArray(trip.members) ? trip.members : [];
  trip.members = trip.members.map((m) => ({
    id: m.id,
    name: m.name || m.id || '未知成員',
  }));

  trip.expenses = Array.isArray(trip.expenses) ? trip.expenses : [];
  trip.expenses = trip.expenses.map((e) => repairExpense(e));

  if (typeof trip.archived !== 'boolean') trip.archived = false;
  if (typeof trip.createdAt !== 'number') trip.createdAt = Date.now();
  if (!trip.id) trip.id = genId('trip');
  if (!trip.name) trip.name = '未命名行程';

  return trip;
}

function repairExpense(rawExp) {
  const e = rawExp || {};
  return {
    id: e.id || genId('exp'),
    description: e.description || '（無說明）',
    amount: typeof e.amount === 'number' ? e.amount : 0,
    currency: e.currency || 'TWD',
    amountInBase: typeof e.amountInBase === 'number' ? e.amountInBase : (typeof e.amount === 'number' ? e.amount : 0),
    payers: Array.isArray(e.payers) ? e.payers : [],
    participants: Array.isArray(e.participants) ? e.participants : [],
    createdAt: typeof e.createdAt === 'number' ? e.createdAt : Date.now(),
    createdBy: e.createdBy || 'unknown',
  };
}

function repairGuild(rawGuild) {
  const def = DEFAULT_GUILD();
  const guild = { ...def, ...(rawGuild || {}) };
  guild.trips = typeof guild.trips === 'object' && guild.trips !== null ? guild.trips : {};

  for (const tripId of Object.keys(guild.trips)) {
    guild.trips[tripId] = repairTrip(guild.trips[tripId]);
    guild.trips[tripId].id = tripId; // 確保 key 與 id 一致
  }

  if (guild.activeTripId && !guild.trips[guild.activeTripId]) {
    guild.activeTripId = null; // 指向不存在的行程時清空，避免崩潰
  }

  return guild;
}

let cache = null;

function loadAll() {
  ensureDataFile();
  if (cache) return cache;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    // 檔案損毀時，備份損毀檔並以空資料重新開始，避免整個機器人掛掉
    const backupPath = DATA_FILE + '.corrupt.' + Date.now();
    try {
      fs.copyFileSync(DATA_FILE, backupPath);
    } catch (_) {}
    raw = {};
  }

  const repaired = {};
  for (const guildId of Object.keys(raw)) {
    repaired[guildId] = repairGuild(raw[guildId]);
  }
  cache = repaired;
  return cache;
}

function saveAll() {
  ensureDataFile();
  const tmpFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmpFile, DATA_FILE); // 原子寫入，避免寫到一半程式崩潰造成檔案損毀
}

function getGuild(guildId) {
  const all = loadAll();
  if (!all[guildId]) {
    all[guildId] = repairGuild(null);
  }
  return all[guildId];
}

function persist() {
  saveAll();
}

module.exports = {
  genId,
  getGuild,
  persist,
  DEFAULT_TRIP,
  repairTrip,
  repairExpense,
};
