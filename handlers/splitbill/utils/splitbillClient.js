'use strict';

/**
 * Splitbill 資料服務的 API client。
 * -----------------------------------------------------------------
 * 取代原本 handlers/splitbill/utils/storage.js 對本地 JSON 檔案的直接讀寫。
 * 所有分帳資料現在都存在獨立部署的 splitbill-service（見該專案），這裡透過
 * Private Networking（SPLITBILL_SERVICE_URL，格式通常是
 * http://<service-name>.internal:<port>）呼叫它的 REST API——跟
 * webui 前端打的是同一組端點，資料模型完全一致。
 *
 * 沒有本地 fallback：SPLITBILL_SERVICE_URL 未設定時直接拋錯，不會偷偷退回
 * 本地檔案（本地 storage.js 的檔案讀寫路徑已經整個移除，不保留雙路徑）。
 * webui 是這個 service 的主要使用端，bot 這邊只是輔助呼叫者。
 *
 * 🆕 [行程獨立化] 行程以 tripId 為主鍵（/api/trip/:tripId），綁定的 Discord
 * 伺服器只是行程上的 guildId 欄位。這裡的讀取一律限定在「綁在這個伺服器上」
 * 的行程；所有寫入都帶 x-actor-id（實際操作的 Discord 使用者），由 service
 * 依同一套規則（建立者／已連結成員）獨立驗證，不只依賴 bot 端的檢查。
 *
 * 環境變數：
 *   SPLITBILL_SERVICE_URL   splitbill-service 的內部網路位址
 *   SPLITBILL_SERVICE_KEY   對 service 認證用的金鑰；沒設定則退回沿用 SPLITBILL_API_KEY
 */

const crypto = require('crypto');

const SERVICE_URL = (process.env.SPLITBILL_SERVICE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SPLITBILL_SERVICE_KEY || process.env.SPLITBILL_API_KEY || '';
const MAX_SAVE_RETRY = 3;

// 產生內部物件 ID（花費／訂金等）。純本地 trivial 工具，不需要打網路，
// 邏輯照抄原本 storage.js 的 genId()——搬到這裡是因為 storage.js 本身
// 已經不在 bot 端了，其他檔案不用再各自複製一份。
function genId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

function isConfigured() {
  return !!SERVICE_URL;
}

const SNOWFLAKE_RE = /^\d{17,20}$/;

function actorHeaders(actorId) {
  if (!SNOWFLAKE_RE.test(String(actorId || ''))) {
    // 寫入一定要宣告操作者：漏帶的話 service 會把這次請求當成「管理端」全權放行，
    // 等於繞過成員檢查。寧可在這裡直接失敗，也不要悄悄用管理端身分寫入。
    throw new Error('內部錯誤：寫入分帳資料時缺少操作者（actorId）');
  }
  return { 'x-actor-id': String(actorId) };
}

function assertConfigured() {
  if (!SERVICE_URL) {
    throw new Error('尚未設定 SPLITBILL_SERVICE_URL，分帳功能無法使用，請確認環境變數。');
  }
}

async function request(method, path, body, extraHeaders) {
  assertConfigured();
  const res = await fetch(`${SERVICE_URL}/api${path}`, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      SERVICE_KEY ? { 'x-api-key': SERVICE_KEY } : {},
      extraHeaders || {}
    ),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

/** 取得整個 guild 結構：{ trips, activeTripByUser, defaultTripId } */
async function getGuild(guildId) {
  return request('GET', `/guild/${encodeURIComponent(guildId)}`);
}

/**
 * 依名稱（可省略）取得行程；未指定名稱則用該使用者自己的作用行程。
 * 邏輯與原本 tripHelper.resolveTrip() 完全相同，只是資料來源從本地
 * storage.getGuild() 換成打 API。
 */
async function resolveTrip(guildId, tripName, userId) {
  const guild = await getGuild(guildId);

  if (tripName) {
    const found = Object.values(guild.trips).find(
      (t) => t.name === tripName || t.id === tripName
    );
    if (!found) return { guild, trip: null, error: `找不到名為「${tripName}」的行程` };
    return { guild, trip: found, error: null };
  }

  const personalTripId = userId ? guild.activeTripByUser[userId] : null;
  if (personalTripId && guild.trips[personalTripId]) {
    return { guild, trip: guild.trips[personalTripId], error: null };
  }

  if (!guild.defaultTripId || !guild.trips[guild.defaultTripId]) {
    return {
      guild,
      trip: null,
      error: '尚未指定行程。請先到「🧳 行程設定」建立或選擇你要使用的行程。',
    };
  }
  return { guild, trip: guild.trips[guild.defaultTripId], error: null };
}

/**
 * 依 ID 直接取得單一行程（不做個人化/預設值回退），用於多步驟流程中途
 * 「鎖定」流程開始當下那個行程，避免使用者中途切換作用行程造成資料寫錯地方。
 * 🆕 行程不是綁在這個伺服器上（例如已在網頁解除綁定、或 customId 被拿到別的
 * 伺服器使用）一律當成找不到。
 */
async function resolveTripById(guildId, tripId) {
  if (!tripId) return null;
  try {
    const trip = await request('GET', `/trip/${encodeURIComponent(tripId)}`);
    return trip && trip.guildId === guildId ? trip : null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function setUserActiveTrip(guildId, userId, tripId) {
  return request('PATCH', `/guild/${encodeURIComponent(guildId)}/active-trip`, { userId, tripId });
}

async function listTripChoices(guildId, query = '') {
  const guild = await getGuild(guildId);
  const q = query.toLowerCase();
  return Object.values(guild.trips)
    .filter((t) => !t.archived)
    .filter((t) => t.name.toLowerCase().includes(q))
    .slice(0, 25)
    .map((t) => ({ name: t.name, value: t.name }));
}

/**
 * 儲存（整包覆蓋）一個既有的行程。新行程請用 createTrip()。
 * 照抄 webui/public/js/tripSync.js 的 saveTripToApi() 樂觀鎖重試邏輯：
 * expectedUpdatedAt 對不上時伺服器回 409，帶著「當下最新版本」讓呼叫端用
 * mergeFn 決定怎麼合併再重試；沒給 mergeFn、或合併不了，例外直接往上拋，
 * 由各 handler 自行決定怎麼提示使用者（跟原本 webui 衝突時的處理一致）。
 *
 * @param {string} guildId
 * @param {string} tripId
 * @param {object} trip 完整的 trip 物件
 * @param {{ actorId: string, mergeFn?: (local:object, server:object)=>object|null }} opts
 *   actorId：實際操作的 Discord 使用者（必填）；mergeFn：版本衝突時的合併策略，回傳 null 代表無法合併
 * @returns {Promise<object>} 伺服器儲存後回傳的最新 trip（含新的 updatedAt）
 */
async function saveTrip(guildId, tripId, trip, opts = {}) {
  const headers = actorHeaders(opts.actorId);
  const mergeFn = opts.mergeFn;
  if (trip.guildId && trip.guildId !== guildId) {
    throw new Error('這個行程已經不在這個伺服器上了，請重新開啟面板。');
  }
  let current = trip;
  for (let attempt = 0; attempt < MAX_SAVE_RETRY; attempt++) {
    try {
      const payload = Object.assign({}, current, { expectedUpdatedAt: current.updatedAt || null });
      return await request('PUT', `/trip/${encodeURIComponent(tripId)}`, payload, headers);
    } catch (err) {
      if (err.status === 409 && mergeFn) {
        const serverTrip = err.body && err.body.currentTrip;
        const merged = serverTrip ? mergeFn(current, serverTrip) : null;
        if (!merged) throw err;
        current = merged; // 用合併後的版本重試
        continue;
      }
      throw err;
    }
  }
  throw new Error('儲存失敗：版本衝突且重試次數已用完，請重新操作一次。');
}

// actorId：實際按下刪除的 Discord 使用者。service 會再獨立驗證一次
// 「是否為建立者或 OWNER_USER_ID」，不只依賴 Bot 端的檢查。
async function deleteTrip(guildId, tripId, actorId) {
  const trip = await resolveTripById(guildId, tripId);
  if (!trip) throw new Error('找不到這個行程（可能已被刪除或已解除綁定）');
  return request('DELETE', `/trip/${encodeURIComponent(tripId)}`, undefined, actorHeaders(actorId));
}

/**
 * 🆕 在這個伺服器建立新行程，建立者＝actorId（同時成為第一位已連結的成員），
 * 建立後直接綁定在這個伺服器。
 * @param {{ name: string, baseCurrency: string, rates?: object, memberName?: string }} fields
 */
async function createTrip(guildId, fields, actorId) {
  return request('POST', '/trips', Object.assign({}, fields, { guildId }), actorHeaders(actorId));
}

/**
 * 🆕 用網頁產生的綁定碼，把網頁上建立的行程綁到這個伺服器。
 * service 端會驗證 actorId 必須是該行程的建立者（或 OWNER_USER_ID）。
 */
async function attachTrip(guildId, code, actorId, actorName) {
  return request('POST', '/attach', { code, guildId, actorName }, actorHeaders(actorId));
}

module.exports = {
  isConfigured,
  genId,
  getGuild,
  resolveTrip,
  resolveTripById,
  setUserActiveTrip,
  listTripChoices,
  saveTrip,
  createTrip,
  deleteTrip,
  attachTrip,
};
