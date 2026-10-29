'use strict';
// admin/auth.js
// ─────────────────────────────────────────────────────────────
// 管理面板的登入驗證：密碼登入 → HttpOnly Cookie，以及登入嘗試限流。
// 做法與 music-library-service 的 webplayer/webAuth.js 相同，只是改成直接處理 node:http 的 req / res。
//
// Cookie 內容是「到期時間.簽章」，簽章金鑰由隨機金鑰檔與密碼一起衍生：
//   - 換密碼 = 所有裝置登出
//   - 金鑰檔不在 Cookie 裡，拿到 Cookie 也無法離線暴力猜密碼
//   - 不需要 session 表，Bot 重新啟動後仍維持登入
// 登出時把該 Cookie 的簽章記進撤銷清單，並存到 data/admin-revoked.json（重新啟動後仍然有效，到期後自動清掉）。
//
// CSRF：Cookie 是 SameSite=Strict，且 server.js 要求所有寫入請求帶自訂 header 與 JSON body——
// 跨站的表單無法自訂 header，要自訂就得先過 CORS 預檢，而這裡沒有開 CORS。

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const logger = require('../utils/logger');
const { alert } = require('../utils/alert');
const { readJson, writeJsonAtomic } = require('../utils/jsonStore');

const COOKIE_NAME = 'mb_admin';
// 成功登入過的裝置：不受全站登入鎖定影響（攻擊者灌錯誤密碼鎖不住擁有者），只受自己來源的計數限制
const DEVICE_COOKIE = 'mb_admin_dev';
const DEVICE_DAYS = 90;

// 登入限流：每個來源 10 分鐘內最多失敗 10 次；全站 10 分鐘內最多失敗 50 次（大量 IP 一起猜時整體暫停登入，
// 已登入的裝置不受影響）
const MAX_FAILS = 10;
const GLOBAL_MAX_FAILS = 50;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED_SOURCES = 10000;
const MAX_REVOKED = 10000;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

// 固定長度雜湊後再 timingSafeEqual，避免長度不同時洩漏資訊
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// 讀取（沒有就建立）隨機的 Session 金鑰檔；檔案系統不能寫時退回只存在記憶體（重新啟動＝全部登出）
function loadOrCreateSecret(file) {
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (v.length >= 32) return v;
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('Admin', `讀取 Session 金鑰失敗：${err.message}`);
  }
  const v = crypto.randomBytes(32).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${v}\n`, { mode: 0o600 });
  } catch (err) {
    logger.warn('Admin', `無法寫入 ${file}（${err.message}），Session 金鑰只存在記憶體：Bot 重新啟動後需要重新登入`);
  }
  return v;
}

// ── 來源 IP（限流用）─────────────────────────────────────
// 直接連線時用連線位址；連線來自信任的反向代理時，改用 X-Forwarded-For 最右邊那一個——
// 那是最近一層代理親眼看到的來源（Caddy 會用真實來源覆寫這個標頭）。
// 🔒 信任哪些代理由 ADMIN_TRUSTED_PROXIES 決定（逗號分隔的 CIDR，例如 172.18.0.0/16）：
//   - 沒設定：信任私有網段（10/8、172.16/12、192.168/16、127/8、100.64/10、fc00::/7、fe80::/10、::1），跟以前一樣。
//     VPS 上 Caddy 經由 Docker 私有網路連進來，需要這個預設才看得到使用者的真實 IP。
//     代價是同一個私有網路裡的其他程式直接連管理面板時，可以自己帶 X-Forwarded-For 換來源，繞過單一來源的限流
//     （全站上限仍然有效）。知道代理的網段時，請設成只包含代理的範圍。
//   - 設成 none 或空字串：完全不讀 X-Forwarded-For（管理面板直接對外、前面沒有代理時）
const DEFAULT_TRUSTED = [
  ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['100.64.0.0', 10],
  ['fc00::', 7], ['fe80::', 10], ['::1', 128],
];

function parseTrustedProxies(raw) {
  const list = new net.BlockList();
  if (raw === undefined) {
    for (const [addr, prefix] of DEFAULT_TRUSTED) list.addSubnet(addr, prefix, net.isIPv6(addr) ? 'ipv6' : 'ipv4');
    return list;
  }
  const value = String(raw).trim();
  if (!value || value.toLowerCase() === 'none') return list;
  for (const part of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [addr, bits] = part.split('/');
    const ip = normalizeIp(addr);
    const family = ip && net.isIPv6(ip) ? 'ipv6' : 'ipv4';
    const prefix = bits === undefined ? (family === 'ipv6' ? 128 : 32) : Number(bits);
    if (!ip || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 'ipv6' ? 128 : 32)) {
      logger.warn('Admin', `ADMIN_TRUSTED_PROXIES 裡的「${part}」不是合法的 IP／CIDR，已略過`);
      continue;
    }
    list.addSubnet(ip, prefix, family);
  }
  return list;
}

const TRUSTED_PROXIES = parseTrustedProxies(process.env.ADMIN_TRUSTED_PROXIES);

// '::ffff:1.2.3.4'（IPv4-mapped IPv6）→ '1.2.3.4'；不是合法 IP 時回傳 null
function normalizeIp(raw) {
  let ip = String(raw || '').trim();
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7);
  return net.isIP(ip) ? ip : null;
}

// IPv6 以 /64 為單位計算（一般使用者都分到整個 /64，換位址繞不過限流）
function ipv6Prefix64(ip) {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16)).join(':')}::/64`;
}

// 回傳 { key, peer, forwarded }：key 是限流用的來源；peer 是 TCP 連線的位址；
// forwarded 表示 key 取自信任代理帶來的 X-Forwarded-For
function resolveClient(req, trusted = TRUSTED_PROXIES) {
  const peer = normalizeIp(req.socket.remoteAddress);
  let ip = peer;
  let forwarded = false;
  if (peer && trusted.check(peer, net.isIPv6(peer) ? 'ipv6' : 'ipv4')) {
    const list = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map(normalizeIp)
      .filter(Boolean);
    if (list.length) {
      ip = list[list.length - 1];
      forwarded = true;
    }
  }
  const key = !ip ? 'unknown' : net.isIPv6(ip) ? ipv6Prefix64(ip) : ip;
  return { key, peer: peer || 'unknown', forwarded };
}

function clientKey(req) {
  return resolveClient(req).key;
}

// 稽核紀錄用的來源：經由代理時一併記下 TCP 連線的位址，X-Forwarded-For 被偽造時也看得出來
function describeSource(req) {
  const { key, peer, forwarded } = resolveClient(req);
  return forwarded && peer !== key ? `${key}，經由 ${peer}` : key;
}

function isHttps(req) {
  if (req.socket.encrypted) return true;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

/**
 * @param {{ password: string, secretFile: string, sessionHours: number, revokedFile?: string }} opts
 *   revokedFile：撤銷清單存檔位置（沒給＝只存在記憶體）
 */
function createAuth({ password, secretFile, sessionHours, revokedFile }) {
  // 不論金鑰從哪裡來，都和密碼一起衍生：換密碼一定會讓所有裝置登出
  const secret = process.env.ADMIN_SESSION_SECRET || loadOrCreateSecret(secretFile);
  const sessionKey = crypto.createHmac('sha256', secret).update(`mb-admin:${password}`).digest();
  const sessionMs = sessionHours * 3600 * 1000;

  const sign = (payload) => crypto.createHmac('sha256', sessionKey).update(payload).digest('base64url');

  function issueToken() {
    const exp = String(Date.now() + sessionMs);
    return `${exp}.${sign(exp)}`;
  }

  // 已登出的 token：簽章 → 到期時間。Cookie 是無狀態的、金鑰重新啟動後不變，
  // 只放記憶體的話重新啟動後被複製走的 Cookie 又能用，所以要存檔
  const revoked = new Map();
  if (revokedFile) {
    const saved = readJson(revokedFile, {});
    const now = Date.now();
    for (const [mac, exp] of Object.entries(saved && typeof saved === 'object' ? saved : {})) {
      if (typeof exp === 'number' && exp >= now && revoked.size < MAX_REVOKED) revoked.set(mac, exp);
    }
  }
  function saveRevoked() {
    if (!revokedFile) return;
    try {
      writeJsonAtomic(revokedFile, Object.fromEntries(revoked), { pretty: false });
    } catch (err) {
      logger.warn('Admin', `無法寫入登出清單 ${path.basename(revokedFile)}（${err.message}），Bot 重新啟動後已登出的 Cookie 會在到期前恢復有效`);
    }
  }

  function verifyToken(token) {
    if (!token) return false;
    const dot = token.indexOf('.');
    if (dot < 0) return false;
    const exp = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
    return safeEqual(mac, sign(exp)) && !revoked.has(mac);
  }

  function cookieString(req, value, maxAgeSec, name = COOKIE_NAME) {
    const secure = isHttps(req) ? '; Secure' : '';
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
  }

  // 信任裝置 Cookie：<到期時間>.<簽章>，簽章金鑰同 session（換密碼＝失效）
  function issueDeviceToken() {
    const exp = String(Date.now() + DEVICE_DAYS * 86400e3);
    return `${exp}.${sign(`device:${exp}`)}`;
  }
  function isTrustedDevice(req) {
    const token = getCookie(req, DEVICE_COOKIE);
    const dot = token ? token.indexOf('.') : -1;
    if (dot < 0) return false;
    const exp = token.slice(0, dot);
    return /^\d+$/.test(exp) && Number(exp) >= Date.now() && safeEqual(token.slice(dot + 1), sign(`device:${exp}`));
  }

  const failures = new Map(); // 來源 -> { count, resetAt }
  let globalFails = { count: 0, resetAt: Date.now() + WINDOW_MS };
  setInterval(() => {
    const now = Date.now();
    for (const [key, f] of failures) if (f.resetAt <= now) failures.delete(key);
    for (const [mac, exp] of revoked) if (exp < now) revoked.delete(mac);
  }, WINDOW_MS).unref();

  /**
   * @returns {{ status: number, body: object, headers?: Record<string,string> }}
   */
  function login(req, body) {
    const now = Date.now();
    const source = clientKey(req);
    let rec = failures.get(source);
    if (!rec || rec.resetAt <= now) rec = { count: 0, resetAt: now + WINDOW_MS };
    if (globalFails.resetAt <= now) globalFails = { count: 0, resetAt: now + WINDOW_MS };

    // 全站上限不擋成功登入過的裝置（見 DEVICE_COOKIE）；單一來源的上限照樣適用
    const blockedUntil = rec.count >= MAX_FAILS ? rec.resetAt
      : (globalFails.count >= GLOBAL_MAX_FAILS && !isTrustedDevice(req)) ? globalFails.resetAt : 0;
    if (blockedUntil) {
      const retryAfterSec = Math.ceil((blockedUntil - now) / 1000);
      return {
        status: 429,
        headers: { 'Retry-After': String(retryAfterSec) },
        body: { error: `嘗試次數過多，請 ${Math.ceil(retryAfterSec / 60)} 分鐘後再試` },
      };
    }

    const given = typeof body?.password === 'string' ? body.password : '';
    if (!given || !safeEqual(given, password)) {
      rec.count += 1;
      globalFails.count += 1;
      // 表滿了就不再記新的來源（全站上限仍會計數），不刪舊紀錄——否則灌入大量 IP 就能洗掉別人的失敗次數
      if (failures.has(source) || failures.size < MAX_TRACKED_SOURCES) failures.set(source, rec);
      // 剛好達到上限的那一次通知維運：有人在猜管理面板密碼
      if (rec.count === MAX_FAILS) {
        alert(`admin-lock:${source}`, `管理面板登入失敗 ${MAX_FAILS} 次，來源 ${describeSource(req)} 已暫時鎖定 ${WINDOW_MS / 60000} 分鐘`);
      }
      if (globalFails.count === GLOBAL_MAX_FAILS) {
        alert('admin-lock:global', `管理面板 ${WINDOW_MS / 60000} 分鐘內登入失敗達 ${GLOBAL_MAX_FAILS} 次，全站登入暫時鎖定（成功登入過的裝置不受影響）`);
      }
      return { status: 401, body: { error: '密碼錯誤' } };
    }

    failures.delete(source);
    return {
      status: 200,
      headers: {
        'Set-Cookie': [
          cookieString(req, issueToken(), Math.floor(sessionMs / 1000)),
          cookieString(req, issueDeviceToken(), DEVICE_DAYS * 86400, DEVICE_COOKIE),
        ],
      },
      body: { ok: true },
    };
  }

  // revoked：這次請求真的帶著有效的 session 並把它登出了（server.js 只在這時寫稽核紀錄）
  function logout(req) {
    const token = getCookie(req, COOKIE_NAME);
    let didRevoke = false;
    // 讓這個 Cookie 就算被複製走也不能再用
    if (verifyToken(token)) {
      const dot = token.indexOf('.');
      if (revoked.size >= MAX_REVOKED) revoked.delete(revoked.keys().next().value);
      revoked.set(token.slice(dot + 1), Number(token.slice(0, dot)));
      saveRevoked(); // 登出不常發生，直接同步寫入
      didRevoke = true;
    }
    return {
      status: 200,
      revoked: didRevoke,
      // 信任裝置 Cookie 保留：這台裝置下次登入仍不受全站鎖定影響
      headers: { 'Set-Cookie': cookieString(req, '', 0) },
      body: { ok: true },
    };
  }

  return {
    isAuthenticated: (req) => verifyToken(getCookie(req, COOKIE_NAME)),
    login,
    logout,
  };
}

module.exports = {
  createAuth, clientKey, describeSource,
  _clientKey: clientKey, _ipv6Prefix64: ipv6Prefix64, _resolveClient: resolveClient, _parseTrustedProxies: parseTrustedProxies,
};
