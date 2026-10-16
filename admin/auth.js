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
// 登出時把該 Cookie 的簽章記進撤銷清單（只存在記憶體；重新啟動後清空，Cookie 本身仍會到期）。
//
// CSRF：Cookie 是 SameSite=Strict，且 server.js 要求所有寫入請求帶自訂 header 與 JSON body——
// 跨站的表單無法自訂 header，要自訂就得先過 CORS 預檢，而這裡沒有開 CORS。

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const logger = require('../utils/logger');

const COOKIE_NAME = 'mb_admin';

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
// 直接連線時用連線位址；連線來自私有網段（部署平台的反向代理）時，
// 改用 X-Forwarded-For 最右邊那一個——那是最近一層代理親眼看到的來源，偽造不了。
const PRIVATE_NETS = new net.BlockList();
for (const [addr, prefix] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['100.64.0.0', 10]]) {
  PRIVATE_NETS.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [['fc00::', 7], ['fe80::', 10], ['::1', 128]]) {
  PRIVATE_NETS.addSubnet(addr, prefix, 'ipv6');
}

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

function clientKey(req) {
  const peer = normalizeIp(req.socket.remoteAddress);
  let ip = peer;
  if (peer && PRIVATE_NETS.check(peer, net.isIPv6(peer) ? 'ipv6' : 'ipv4')) {
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map(normalizeIp)
      .filter(Boolean);
    if (forwarded.length) ip = forwarded[forwarded.length - 1];
  }
  if (!ip) return 'unknown';
  return net.isIPv6(ip) ? ipv6Prefix64(ip) : ip;
}

function isHttps(req) {
  if (req.socket.encrypted) return true;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

/**
 * @param {{ password: string, secretFile: string, sessionHours: number }} opts
 */
function createAuth({ password, secretFile, sessionHours }) {
  // 不論金鑰從哪裡來，都和密碼一起衍生：換密碼一定會讓所有裝置登出
  const secret = process.env.ADMIN_SESSION_SECRET || loadOrCreateSecret(secretFile);
  const sessionKey = crypto.createHmac('sha256', secret).update(`mb-admin:${password}`).digest();
  const sessionMs = sessionHours * 3600 * 1000;

  const sign = (payload) => crypto.createHmac('sha256', sessionKey).update(payload).digest('base64url');

  function issueToken() {
    const exp = String(Date.now() + sessionMs);
    return `${exp}.${sign(exp)}`;
  }

  // 已登出的 token：簽章 → 到期時間
  const revoked = new Map();

  function verifyToken(token) {
    if (!token) return false;
    const dot = token.indexOf('.');
    if (dot < 0) return false;
    const exp = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
    return safeEqual(mac, sign(exp)) && !revoked.has(mac);
  }

  function cookieString(req, value, maxAgeSec) {
    const secure = isHttps(req) ? '; Secure' : '';
    return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
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

    const blockedUntil = rec.count >= MAX_FAILS ? rec.resetAt
      : globalFails.count >= GLOBAL_MAX_FAILS ? globalFails.resetAt : 0;
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
      return { status: 401, body: { error: '密碼錯誤' } };
    }

    failures.delete(source);
    return {
      status: 200,
      headers: { 'Set-Cookie': cookieString(req, issueToken(), Math.floor(sessionMs / 1000)) },
      body: { ok: true },
    };
  }

  function logout(req) {
    const token = getCookie(req, COOKIE_NAME);
    // 讓這個 Cookie 就算被複製走也不能再用
    if (verifyToken(token)) {
      const dot = token.indexOf('.');
      if (revoked.size >= MAX_REVOKED) revoked.delete(revoked.keys().next().value);
      revoked.set(token.slice(dot + 1), Number(token.slice(0, dot)));
    }
    return {
      status: 200,
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

module.exports = { createAuth, clientKey, _clientKey: clientKey, _ipv6Prefix64: ipv6Prefix64 };
