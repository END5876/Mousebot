'use strict';
/**
 * 存取權限判斷：擁有者金鑰 vs 分享連結 token。
 * 從 webui/server.js 抽出，集中管理「誰可以存取/寫入哪個行程」的邏輯，
 * 供 webui/routes/*.js 底下所有路由共用。
 */

/**
 * 🆕 [分享連結] 金鑰驗證中介層（僅保護 /api/* 路由）。
 * 除了擁有者金鑰，也接受「分享連結」的 token 當憑證——但分享 token 只認得
 * 「它被建立時綁定的那一個行程」，不能拿去存取別的行程或 /api/guilds 這種
 * 會列出全部行程名稱的端點，因此不能在這裡（還不知道請求要存取哪個行程）
 * 就直接判斷通過或拒絕，只能先把「這把金鑰是不是擁有者本人」記在
 * req.isOwner，實際的存取範圍留給各自的路由處理常式判斷（見下方
 * authorizeTripAccess / requireOwner / hasShareableCredential）。
 *
 * 例外：/api/shared-trip/:token 系列端點本身就是「token 寫在路徑裡」當
 * 憑證使用，因此直接放行、把驗證完全交給該端點自己依路徑上的 token 判斷；
 * 路徑以 /events 結尾的 SSE 端點則因瀏覽器原生 EventSource 不支援自訂
 * header，改在路由本身用一次性票券驗證（見 lib/sse.js、routes/sse.js），
 * 這裡也直接放行、不吃這裡的 header 檢查。
 */
function createApiKeyMiddleware(apiKey) {
  return function apiKeyMiddleware(req, res, next) {
    if (req.path.startsWith('/shared-trip/')) return next();
    if (req.path.endsWith('/events')) return next();
    if (!apiKey) return next(); // 沒設定金鑰就不驗證（僅建議在受信任的內網／VPN 環境這樣用）
    const provided = req.get('x-api-key');
    if (!provided) {
      return res.status(401).json({ error: '缺少或錯誤的 API Key' });
    }
    req.providedKey = provided;
    req.isOwner = (provided === apiKey);
    next();
  };
}

function createAuthHelpers({ storage, apiKey }) {
  /**
   * 🆕 [分享連結] 檢查這次請求是否有權限存取指定的行程。
   * 擁有者金鑰永遠全權放行；否則檢查提供的金鑰是不是這個行程自己名下、
   * 尚未過期的分享連結 token，並依 needWrite 決定該連結的權限（read/write）
   * 是否足夠。回傳 true 時呼叫端才可以繼續往下處理；回傳 false 時已經
   * 直接寫好錯誤回應，呼叫端應立即 return。
   */
  function authorizeTripAccess(req, res, trip, needWrite) {
    if (req.isOwner) return true;
    const link = (trip.shareLinks || []).find((l) => l.token === req.providedKey);
    if (!link) {
      res.status(403).json({ error: '沒有權限存取此行程' });
      return false;
    }
    if (storage.isShareLinkExpired(link)) {
      res.status(403).json({ error: '此分享連結已過期或已被撤銷，請跟建立連結的人索取新的連結' });
      return false;
    }
    if (needWrite && link.permission !== 'write') {
      res.status(403).json({ error: '此分享連結為唯讀，無法儲存變更' });
      return false;
    }
    return true;
  }

  /**
   * 🆕 [分享連結] 擁有者專用端點的守門：建立／列出／修改／撤銷分享連結，
   * 永遠只接受擁有者本人的 SPLITBILL_API_KEY，即使是「可編輯」的分享連結
   * 也不能呼叫——分享連結的管理權本身不能被分享出去，否則等於任何拿到一個
   * 可編輯連結的人都能再幫自己開一把全新、甚至是更高權限的連結，形同權限
   * 可以無限擴散。同樣的守門也用在「建立新行程」（見 routes/trips.js 的
   * PUT，existing 不存在時）。
   */
  function requireOwner(req, res) {
    if (apiKey && !req.isOwner) {
      res.status(403).json({ error: '此操作僅限擁有者本人執行' });
      return false;
    }
    return true;
  }

  /**
   * 🆕 [分享連結] 給「不特定行程」的共用工具端點用（即時匯率查詢、帳單照片
   * 辨識）：擁有者永遠放行；否則檢查提供的金鑰是不是「任何一個行程」名下
   * 尚未過期的分享連結——這兩個端點本身不吃 guildId/tripId，也不會回傳任何
   * 特定行程的私密資料，所以不像 authorizeTripAccess() 那樣需要綁定「這一個」
   * 行程，只要是任何一把有效的分享連結就算數。requireWrite=true 時進一步
   * 限定只有「可編輯」權限的連結才算數（唯讀訪客不能用來新增資料，帳單辨識
   * 屬於這一類）。
   */
  function hasShareableCredential(req, requireWrite) {
    if (req.isOwner) return true;
    if (!req.providedKey) return false;
    const found = storage.findTripByShareToken(req.providedKey);
    if (!found) return false;
    if (storage.isShareLinkExpired(found.shareLink)) return false;
    if (requireWrite && found.shareLink.permission !== 'write') return false;
    return true;
  }

  return { authorizeTripAccess, requireOwner, hasShareableCredential };
}

module.exports = { createApiKeyMiddleware, createAuthHelpers };
