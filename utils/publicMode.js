// utils/publicMode.js
// 公開模式：Bot 開放給不認識的伺服器使用時，換成比較保守的預設值。
//
// 環境變數 PUBLIC_MODE=1（或 true / yes / on）才啟用；沒設＝私人版，所有行為和以前一樣。
// 每個受影響的設定仍可用各自的環境變數覆寫，公開模式只改「沒設定時的預設值」。
// 完整清單見 docs/PUBLIC-MODE.md。
//
// 每次呼叫都重新讀 process.env（不在載入時快取），測試可以直接改環境變數。

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function isPublicMode() {
    return TRUTHY.has(String(process.env.PUBLIC_MODE ?? '').trim().toLowerCase());
}

/**
 * 讀取非負整數環境變數；沒設或格式不對時，依目前模式回傳私人／公開預設值
 * @param {string} name
 * @param {number} privateValue
 * @param {number} publicValue
 */
function envIntByMode(name, privateValue, publicValue) {
    const n = Number.parseInt(process.env[name] ?? '', 10);
    if (Number.isFinite(n) && n >= 0) return n;
    return isPublicMode() ? publicValue : privateValue;
}

/**
 * 讀取 0～1 的小數環境變數；沒設或格式不對時，依目前模式回傳私人／公開預設值
 * @param {string} name
 * @param {number} privateValue
 * @param {number} publicValue
 */
function envRatioByMode(name, privateValue, publicValue) {
    const raw = process.env[name];
    const n = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
    return isPublicMode() ? publicValue : privateValue;
}

module.exports = { isPublicMode, envIntByMode, envRatioByMode };
