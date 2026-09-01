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
  expenses: [],  
  deposits: [],      // [{ id, collectorId, payerId, amount, currency, amountInBase, note, createdAt }]
  // 🆕 [分享連結] 這個行程目前開放的分享連結清單。每筆連結都是一組獨立的隨機
  // token，只認得「這一個行程」，不像 SPLITBILL_API_KEY 那樣擁有全部伺服器/
  // 行程的讀寫權限——外洩一筆分享連結，最多只會曝險這一個行程，且權限受
  // permission 限制、可設過期時間、可隨時單獨撤銷（直接從這個陣列移除）。
  // 詳見 webui/server.js 的 /api/shared-trip/:token 系列端點。
  shareLinks: [],    // [{ token, label, permission:'read'|'write', expiresAt:number|null, createdAt }]
  archived: false,
  createdAt: Date.now(),
});

const DEFAULT_GUILD = () => ({
  // 🔄 [修正：切換行程影響全體] 舊版用單一 activeTripId 讓「整個伺服器」共用同一個
  // 作用中行程，任何人按下「切換行程」都會讓全部人的畫面一起跳轉，甚至讓別人正在
  // 操作到一半的記帳流程被切換到別的行程去。
  // 新版拆成兩個欄位：
  //   - defaultTripId：伺服器層級的「預設」行程，只在使用者「從未自己選過」時作為後備
  //   - activeTripByUser：{ [userId]: tripId }，每個使用者各自獨立的作用中行程
  defaultTripId: null,
  activeTripByUser: {},
  trips: {},
});

function genId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * 🆕 [分享連結] 產生分享連結用的 token。
 * 刻意跟 genId() 分開：genId() 只需要「不重複」，用來當內部物件 ID；
 * 這裡的 token 本身就是一組會被拿去當 API 憑證使用的「密碼」，安全性
 * 要求高得多，因此用 24 bytes（192 bits）亂數、遠超過 genId() 的 4 bytes，
 * 避免被暴力猜測或字典攻擊。
 */
function genShareToken() {
  return crypto.randomBytes(24).toString('hex');
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

  trip.deposits = Array.isArray(trip.deposits) ? trip.deposits : [];
  trip.deposits = trip.deposits.map((d) => repairDeposit(d));

  // 🆕 [分享連結]
  trip.shareLinks = Array.isArray(trip.shareLinks) ? trip.shareLinks : [];
  trip.shareLinks = trip.shareLinks.map((l) => repairShareLink(l)).filter(Boolean);

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

/**
 * 資料防呆：修復預收款/訂金紀錄，補齊缺漏欄位，避免壞掉的資料
 * 在結算計算（calcNetBalances 等）中悄悄產生 NaN 或算錯淨額。
 */
function repairDeposit(rawDep) {
  const d = rawDep || {};
  return {
    id: d.id || genId('dep'),
    collectorId: d.collectorId || null,
    payerId: d.payerId || null,
    amount: typeof d.amount === 'number' ? d.amount : 0,
    currency: d.currency || 'TWD',
    amountInBase: typeof d.amountInBase === 'number' ? d.amountInBase : (typeof d.amount === 'number' ? d.amount : 0),
    note: d.note || '',
    createdAt: typeof d.createdAt === 'number' ? d.createdAt : Date.now(),
  };
}

/**
 * 🆕 [分享連結] 資料防呆：修復單筆分享連結紀錄。
 * token 是這筆連結的核心憑證，若缺漏或損毀（理論上不該發生，但防呆原則
 * 一律不憑空補一組新的隨機 token 給壞掉的紀錄——那等於憑空「復活」一筆
 * 使用者從未真正建立、也從未真正分享出去過的有效連結，回傳 null 讓呼叫端
 * 直接丟棄這筆壞資料，比較安全。
 * @returns {object|null}
 */
function repairShareLink(rawLink) {
  const l = rawLink || {};
  if (!l.token || typeof l.token !== 'string') return null;
  return {
    token: l.token,
    label: typeof l.label === 'string' ? l.label.slice(0, 50) : '',
    permission: l.permission === 'write' ? 'write' : 'read',
    expiresAt: typeof l.expiresAt === 'number' ? l.expiresAt : null,
    createdAt: typeof l.createdAt === 'number' ? l.createdAt : Date.now(),
  };
}

function repairGuild(rawGuild) {
  const def = DEFAULT_GUILD();
  const guild = { ...def, ...(rawGuild || {}) };
  guild.trips = typeof guild.trips === 'object' && guild.trips !== null ? guild.trips : {};

  // 🔄 舊資料相容：把舊版全域 activeTripId 遷移成新版 defaultTripId，
  // 讓升級前就存在的伺服器不會突然找不到行程。
  if (rawGuild && rawGuild.activeTripId && !guild.defaultTripId) {
    guild.defaultTripId = rawGuild.activeTripId;
  }
  delete guild.activeTripId;

  guild.activeTripByUser = (typeof guild.activeTripByUser === 'object' && guild.activeTripByUser !== null)
    ? guild.activeTripByUser
    : {};

  for (const tripId of Object.keys(guild.trips)) {
    guild.trips[tripId] = repairTrip(guild.trips[tripId]);
    guild.trips[tripId].id = tripId; // 確保 key 與 id 一致
  }

  if (guild.defaultTripId && !guild.trips[guild.defaultTripId]) {
    guild.defaultTripId = null; // 指向不存在的行程時清空，避免崩潰
  }

  // 個人指標若指向已刪除的行程，一併清掉，避免資料檔越長越大
  for (const uid of Object.keys(guild.activeTripByUser)) {
    const tid = guild.activeTripByUser[uid];
    if (!tid || !guild.trips[tid]) delete guild.activeTripByUser[uid];
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

/**
 * 🆕 [分享連結] 判斷一筆分享連結是否已過期。expiresAt 為 null 代表永久有效。
 */
function isShareLinkExpired(link) {
  if (!link) return true;
  if (link.expiresAt === null || link.expiresAt === undefined) return false;
  return Date.now() > link.expiresAt;
}

/**
 * 🆕 [分享連結] 依 token 在「所有伺服器、所有行程」裡找出對應的行程與連結。
 * 分享連結的網址只帶 token、不帶 guildId/tripId（見 webui/server.js 的
 * /api/shared-trip/:token），所以伺服器收到請求時得靠這個函式反查是哪個
 * guild 的哪個行程；也順便讓分享連結的持有者永遠無法從網址本身推測出
 * 內部的 guildId/tripId，多一層資訊不外洩的保護。
 * @returns {{ guild: object, trip: object, shareLink: object } | null}
 */
function findTripByShareToken(token) {
  if (!token) return null;
  const all = loadAll();
  for (const guildId of Object.keys(all)) {
    const guild = all[guildId];
    for (const tripId of Object.keys(guild.trips)) {
      const trip = guild.trips[tripId];
      const shareLink = (trip.shareLinks || []).find((l) => l.token === token);
      if (shareLink) return { guild, trip, shareLink };
    }
  }
  return null;
}

module.exports = {
  genId,
  genShareToken,
  getGuild,
  persist,
  loadAll,
  DEFAULT_TRIP,
  repairTrip,
  repairExpense,
  repairDeposit,
  repairShareLink,
  isShareLinkExpired,
  findTripByShareToken,
};