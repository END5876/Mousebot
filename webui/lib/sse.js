'use strict';
// ════════════════════════════════════════════════════════════════
// 🆕 [即時同步] SSE（Server-Sent Events）：讓多個同時開著這個行程的分頁
// （包含 webui 彼此之間、以及 webui 與 Discord 面板之間）在資料被任一方
// 改動時互相即時同步，不用手動重新整理才會看到別人剛存的東西。
//
// 設計重點：
// - 廣播來源統一掛在 storage.tripEvents（見 storage.js 的 touchTrip()），
//   涵蓋所有寫入路徑，不用在每個 API 端點各自補播送邏輯。
// - 瀏覽器原生 EventSource 不支援自訂 header，因此無法沿用其餘 /api/*
//   路由靠 x-api-key header 驗證的方式。擁有者連線改用「短效、一次性
//   票券」：先用一般帶 header 的請求換票（POST /api/sse-ticket），
//   再用票券建立 SSE 連線，避免把長效的 SPLITBILL_API_KEY 直接放進
//   連線網址、留在伺服器存取紀錄裡。
// - 分享連結路由（見 routes/sse.js 的 /api/shared-trip/:token/events）
//   沿用既有設計：token 本身就是寫在路徑上的憑證，不需要額外換票。
//
// 本檔案只負責「訂閱表 + 換票 + 開串流 + 廣播」這幾個底層機制，實際的
// HTTP 路由定義在 routes/sse.js。
// ════════════════════════════════════════════════════════════════

const sseTickets = new Map(); // ticket -> { isOwner, providedKey, expiresAt }
const SSE_TICKET_TTL_MS = 30 * 1000; // 換票後 30 秒內沒拿去開 SSE 連線就作廢

function pruneSseTickets() {
  const now = Date.now();
  for (const [ticket, entry] of sseTickets) {
    if (entry.expiresAt < now) sseTickets.delete(ticket);
  }
}

// tripId -> Set<express.Response>，每個 res 都是一條保持開啟中的 SSE 連線
const tripSubscribers = new Map();

function addTripSubscriber(tripId, res) {
  if (!tripSubscribers.has(tripId)) tripSubscribers.set(tripId, new Set());
  tripSubscribers.get(tripId).add(res);
}
function removeTripSubscriber(tripId, res) {
  const set = tripSubscribers.get(tripId);
  if (!set) return;
  set.delete(res);
  if (!set.size) tripSubscribers.delete(tripId);
}

/**
 * 開啟一條 SSE 串流並掛進訂閱表。連線本身不主動關閉，靠使用者關閉分頁／
 * 網路中斷觸發 res 的 'close' 事件時清理；期間定期送出註解行當心跳，
 * 避免部分反向代理或 PaaS 因為連線閒置太久而主動斷開。
 */
function openTripSseStream(res, tripId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 避免 nginx 等反向代理把 SSE 資料流緩衝住不即時送出
  });
  res.write('event: connected\ndata: {}\n\n');

  addTripSubscriber(tripId, res);

  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);
  if (typeof keepAlive.unref === 'function') keepAlive.unref();

  res.on('close', () => {
    clearInterval(keepAlive);
    removeTripSubscriber(tripId, res);
  });
}

// 🆕 [多人協作] 廣播「帳單辨識認領進度」有更新／已結束，直接重用既有的
// tripSubscribers 訂閱表——不管是擁有者的 SSE 連線，還是分享連結持有者
// 的 SSE 連線，本來就已經依 tripId 訂閱在這裡，不需要另外開一組端點或
// 另外換票。entry 為 null 時代表協作已結束（帳單已建立成支出，或被取消）。
function broadcastReceiptSession(tripId, entry) {
  const subscribers = tripSubscribers.get(tripId);
  if (!subscribers || !subscribers.size) return;
  const payload = entry
    ? `event: receipt-session-updated\ndata: ${JSON.stringify({
        state: entry.state,
        updatedAt: entry.updatedAt,
        writerId: entry.writerId,
      })}\n\n`
    : 'event: receipt-session-cleared\ndata: {}\n\n';
  for (const res of subscribers) {
    res.write(payload);
  }
}

function createSseHub() {
  return {
    sseTickets,
    pruneSseTickets,
    SSE_TICKET_TTL_MS,
    tripSubscribers,
    addTripSubscriber,
    removeTripSubscriber,
    openTripSseStream,
    broadcastReceiptSession,
  };
}

// 訂閱 storage 層的變更事件：不管是 webui 存檔，還是 Discord 面板操作，
// 只要呼叫過 storage.touchTrip()，這裡就會收到通知並廣播給該行程目前
// 所有開著的 SSE 連線。
function attachTripEventBroadcast(storage, hub) {
  storage.tripEvents.on('trip-updated', (tripId, meta) => {
    const subscribers = hub.tripSubscribers.get(tripId);
    if (!subscribers || !subscribers.size) return; // 沒有人在看這個行程，省下組資料的成本

    const found = storage.findTripById(tripId);
    if (!found) return; // 理論上不會發生（剛觸發過 touchTrip 代表行程存在），防呆用

    // 🆕 [即時同步] 用 envelope 包一層，除了行程本身還夾帶 writerId：
    // 讓寫入者本人的分頁可以精準比對「這筆是不是我自己剛存的」，不用靠比較
    // updatedAt 的時間先後（那個做法在 SSE 推播跟 PUT 回應是兩條獨立連線的
    // 情況下會有競速問題，見 storage.js 的 touchTrip() 說明）。
    const envelope = { trip: found.trip, writerId: (meta && meta.writerId) || null };
    const payload = `event: trip-updated\ndata: ${JSON.stringify(envelope)}\n\n`;
    for (const res of subscribers) {
      res.write(payload);
    }
  });

  // 🆕 [即時同步] 行程被刪除時：通知所有訂閱者一聲，然後直接把連線關掉——
  // 這個行程已經不存在了，之後也不會再有任何 'trip-updated' 事件可以推播，
  // 繼續留著連線沒有意義，不如讓伺服器跟前端都能立刻釋放資源。
  storage.tripEvents.on('trip-deleted', (tripId) => {
    const subscribers = hub.tripSubscribers.get(tripId);
    if (!subscribers || !subscribers.size) return;

    const payload = 'event: trip-deleted\ndata: {}\n\n';
    for (const res of subscribers) {
      res.write(payload);
      res.end();
    }
    hub.tripSubscribers.delete(tripId);
  });
}

module.exports = { createSseHub, attachTripEventBroadcast };
