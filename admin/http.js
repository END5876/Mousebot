'use strict';
// admin/http.js
// ─────────────────────────────────────────────────────────────
// 管理面板 API 的共用工具：極簡路由、HttpError，以及請求內容的驗證函式。
// 處理函式回傳的值會轉成 JSON；要回傳錯誤時丟出 HttpError（訊息會直接顯示在網頁上）。

class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message 給使用者看的錯誤訊息
   */
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** 處理函式回傳這個物件時，伺服器改以檔案下載的形式回應（例如設定備份） */
class FileResponse {
  /**
   * @param {{ filename: string, contentType: string, body: string|Buffer }} opts
   */
  constructor({ filename, contentType, body }) {
    this.filename = filename;
    this.contentType = contentType;
    this.body = body;
  }
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class Router {
  constructor() {
    this.routes = [];
  }

  /**
   * @param {string} method
   * @param {string} pattern 例如 /api/prompts/modes/:key（:name 會比對一個路徑片段）
   * @param {(ctx: { params: Record<string,string>, query: URLSearchParams, body: any }) => any} handler
   */
  add(method, pattern, handler) {
    const keys = [];
    const source = pattern
      .split('/')
      .map((seg) => {
        if (!seg.startsWith(':')) return escapeRegExp(seg);
        keys.push(seg.slice(1));
        return '([^/]+)';
      })
      .join('/');
    this.routes.push({ method, re: new RegExp(`^${source}$`), keys, handler });
    return this;
  }

  get(pattern, handler) { return this.add('GET', pattern, handler); }
  post(pattern, handler) { return this.add('POST', pattern, handler); }
  put(pattern, handler) { return this.add('PUT', pattern, handler); }
  delete(pattern, handler) { return this.add('DELETE', pattern, handler); }

  /**
   * @returns {{ handler: Function, params: Record<string,string> } | { methodNotAllowed: true } | null}
   */
  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;

      const params = {};
      route.keys.forEach((key, i) => {
        try {
          params[key] = decodeURIComponent(m[i + 1]);
        } catch {
          throw new HttpError(400, '網址格式錯誤');
        }
      });
      return { handler: route.handler, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

// ════════════════════════════════════════════════════════
//  驗證
// ════════════════════════════════════════════════════════
const SNOWFLAKE_RE = /^\d{17,20}$/;

/**
 * 字串欄位：去頭尾空白後檢查長度
 * @param {unknown} value
 * @param {string} label 錯誤訊息裡的欄位名稱
 * @param {{ max?: number, allowEmpty?: boolean, trim?: boolean }} [opts]
 */
function str(value, label, { max = 2000, allowEmpty = false, trim = true } = {}) {
  if (value == null && allowEmpty) return '';
  if (typeof value !== 'string') throw new HttpError(400, `${label}格式不正確`);
  const v = trim ? value.trim() : value;
  if (!v && !allowEmpty) throw new HttpError(400, `${label}不可為空`);
  if (v.length > max) throw new HttpError(400, `${label}最多 ${max} 個字`);
  return v;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new HttpError(400, `${label}必須是開或關`);
  return value;
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new HttpError(400, `${label}不正確`);
  return value;
}

function snowflake(value, label) {
  if (typeof value !== 'string' || !SNOWFLAKE_RE.test(value)) throw new HttpError(400, `${label}不是有效的 Discord ID`);
  return value;
}

/** Discord 還沒連上時，需要查伺服器 / 頻道的 API 直接回 503 */
function requireReady(client) {
  if (!client.isReady()) throw new HttpError(503, 'Bot 尚未連上 Discord，請稍後再試');
}

module.exports = { HttpError, FileResponse, Router, str, bool, oneOf, snowflake, requireReady, SNOWFLAKE_RE };
