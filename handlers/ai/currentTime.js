// handlers/ai/currentTime.js
// 給 AI 的「現在時間」。模型本身不知道今天幾號、星期幾，常把日期、倒數天數算錯，
// 所以每次對話在本次訊息最前面附上一行現在時間（搜尋階段、工具判斷、人格回覆都看得到）。
//
// 放在本次訊息、不放 system instruction：system instruction 與歷史要固定不變才吃得到隱式快取，
// 每分鐘都在變的時間只能放在請求最後面。歷史每次都從 Discord 重抓，這行不會累積進歷史。
//
// 環境變數：
//   AI_TIMEZONE  IANA 時區名稱（例如 Asia/Tokyo），預設 Asia/Taipei；寫錯時退回預設並記一筆警告。

const logger = require('../../utils/logger');

const DEFAULT_TIME_ZONE = 'Asia/Taipei';

function resolveTimeZone(name) {
    if (!name) return DEFAULT_TIME_ZONE;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: name });
        return name;
    } catch {
        logger.warn('AI', `AI_TIMEZONE「${name}」不是有效的時區，改用 ${DEFAULT_TIME_ZONE}`);
        return DEFAULT_TIME_ZONE;
    }
}

const TIME_ZONE = resolveTimeZone((process.env.AI_TIMEZONE || '').trim());

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * @param {Date} [date]
 * @param {string} [timeZone]
 * @returns {string} 例：2026年11月8日（星期日）14:05，時區 Asia/Taipei
 */
function formatNow(date = new Date(), timeZone = TIME_ZONE) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
            weekday: 'short',
        }).formatToParts(date).map(p => [p.type, p.value])
    );
    const weekday = WEEKDAYS[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)];
    return `${parts.year}年${parts.month}月${parts.day}日（星期${weekday}）${parts.hour}:${parts.minute}，時區 ${timeZone}`;
}

const TIME_LABEL = '現在時間';

/** 附在本次訊息最前面的 part */
function currentTimePart(date = new Date()) {
    return { text: `【${TIME_LABEL}：${formatNow(date)}】` };
}

// 模型偶爾會照抄這行標籤：回覆送出前（也在 TTS 朗讀與寫進歷史之前）整段拿掉。
// 只擋原樣照抄；用自己的話講時間（「現在下午兩點喔」）是正常回答，不處理。
const TIME_ECHO = new RegExp(`[ \\t]*【${TIME_LABEL}：[^】\\n]*】[ \\t]*\\n?`, 'g');

/** 移除回覆中照抄的【現在時間：…】 */
function stripTimeEcho(text) {
    if (!text || !text.includes(`【${TIME_LABEL}：`)) return text;
    return text.replace(TIME_ECHO, '').trim();
}

module.exports = { currentTimePart, stripTimeEcho, formatNow, TIME_ZONE, DEFAULT_TIME_ZONE, _resolveTimeZone: resolveTimeZone };
