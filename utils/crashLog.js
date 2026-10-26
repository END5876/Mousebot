// utils/crashLog.js
// 記下最近一次崩潰（未捕捉例外）的原因，寫在 data/lastCrash.json。
//
// 程序崩潰後 supervisord 會馬上重啟，原因只留在容器 log 裡，而 log 會輪替、管理面板的「日誌」頁
// 也只保留這次啟動之後的訊息——重啟後就看不出上一次為什麼掛掉。這裡在結束前同步寫一份檔案，
// 管理面板總覽讀它顯示（admin/api/overview.js）。只保留最近一次，不累積。

const path = require('path');
const { readJson, writeJsonAtomic } = require('./jsonStore');

const CRASH_FILE = path.join(__dirname, '..', 'data', 'lastCrash.json');
const STACK_MAX = 4000;

/** 同步寫入（呼叫端接著就會結束程序，不能等非同步寫檔） */
function recordCrash(origin, error) {
    try {
        const err = error instanceof Error ? error : new Error(String(error));
        writeJsonAtomic(CRASH_FILE, {
            at: new Date().toISOString(),
            origin: String(origin || 'unknown'),
            name: err.name,
            message: String(err.message || '').slice(0, 500),
            stack: String(err.stack || '').slice(0, STACK_MAX),
            uptimeSec: Math.round(process.uptime()),
        });
    } catch {
        // 寫不進去（磁碟滿、權限）也不能妨礙後面的結束流程
    }
}

/** @returns {{ at: string, origin: string, name: string, message: string, stack: string, uptimeSec: number } | null} */
function getLastCrash() {
    const data = readJson(CRASH_FILE, null);
    return data && typeof data.at === 'string' ? data : null;
}

module.exports = { recordCrash, getLastCrash, CRASH_FILE };
