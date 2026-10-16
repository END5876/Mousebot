// 呼叫管理面板 API。所有請求都帶 x-mousebot-admin header（伺服器端的 CSRF 檢查），
// 回應 401 時交給 app.js 顯示登入畫面。

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

let onUnauthorized = () => {};

export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(method, path, body) {
  const init = {
    method,
    headers: { 'x-mousebot-admin': '1' },
    credentials: 'same-origin',
    cache: 'no-store',
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, '無法連線到 Bot，請確認 Bot 是否正在執行');
  }

  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== '/api/login') {
    onUnauthorized();
    throw new ApiError(401, data?.error || '請先登入');
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `請求失敗（HTTP ${res.status}）`);
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  put: (path, body = {}) => request('PUT', path, body),
  del: (path) => request('DELETE', path, {}),
};

/** 組出帶查詢字串的路徑：qs('/api/x', { a: 1 }) → /api/x?a=1 */
export function qs(path, params) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) search.set(k, String(v));
  const s = search.toString();
  return s ? `${path}?${s}` : path;
}

/** 路徑片段編碼（ID、模式代號） */
export const seg = (v) => encodeURIComponent(v);
