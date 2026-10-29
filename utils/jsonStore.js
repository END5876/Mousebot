// utils/jsonStore.js
// 所有 data/*.json 設定檔共用的讀寫工具。
//
// 過去各模組各自 fs.writeFileSync 直接覆寫目標檔：容器剛好在寫入途中被殺掉（重啟、
// OOM、uncaughtException 觸發的 process.exit）時會留下半份 JSON，下次開機 JSON.parse
// 失敗，該模組就默默以空白設定啟動——使用者的設定等於整份消失。
//
// 這裡統一提供：
//   readJson(file, fallback)     讀取；主檔損毀時自動改讀 .bak，兩者都失敗才回傳 fallback
//   writeJsonAtomic(file, data)  先寫暫存檔再 rename（同目錄 rename 是原子操作），
//                                覆寫前把舊檔留成 .bak
//   createDebouncedWriter(...)   高頻寫入用：合併一段時間內的多次儲存，程序結束時強制寫出

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

function tryParse(file) {
    if (!fs.existsSync(file)) return { exists: false };
    try {
        return { exists: true, value: JSON.parse(fs.readFileSync(file, 'utf-8')) };
    } catch (err) {
        return { exists: true, error: err };
    }
}

/**
 * @template T
 * @param {string} file
 * @param {T} fallback 檔案不存在或無法解析時的回傳值
 * @returns {T}
 */
function readJson(file, fallback) {
    const main = tryParse(file);
    if (main.exists && !main.error) return main.value;

    const backup = tryParse(`${file}.bak`);
    const name = path.basename(file);
    if (main.error) {
        if (backup.exists && !backup.error) {
            logger.warn('JsonStore', `${name} 損毀（${main.error.message}），已改用 .bak 備份`);
            return backup.value;
        }
        logger.warn('JsonStore', `${name} 損毀且無可用備份（${main.error.message}），改用預設值`);
        return fallback;
    }
    // 主檔不存在：可能是 rename 前一刻被中斷，有 .bak 就用
    if (backup.exists && !backup.error) {
        logger.warn('JsonStore', `${name} 不存在，已從 .bak 備份還原`);
        return backup.value;
    }
    return fallback;
}

/**
 * @param {string} file
 * @param {unknown} data
 * @param {{ pretty?: boolean }} [opts]
 */
function writeJsonAtomic(file, data, { pretty = true } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);

    const fd = fs.openSync(tmp, 'w');
    try {
        // writeFileSync 會一直寫到全部寫完；單次 writeSync 在磁碟快滿時可能只寫一部分卻不報錯
        fs.writeFileSync(fd, json, 'utf-8');
        fs.fsyncSync(fd);
    } catch (err) {
        fs.closeSync(fd);
        fs.rmSync(tmp, { force: true });
        throw err;
    }
    fs.closeSync(fd);

    try {
        // 主檔能解析才輪替成 .bak：避免損毀的主檔蓋掉最後一份好的備份
        const current = tryParse(file);
        if (current.exists && !current.error) fs.copyFileSync(file, `${file}.bak`);
        fs.renameSync(tmp, file);
    } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
    }
}

/**
 * 建立一個合併寫入的 writer：schedule() 後 debounceMs 內的多次呼叫只寫一次；
 * flush() 立即寫出；程序 exit 時若有尚未寫出的資料會自動 flush。
 *
 * @param {string} file
 * @param {() => unknown} getData 寫入時才取資料，確保寫的是最新狀態
 * @param {{ debounceMs?: number, pretty?: boolean, label?: string }} [opts]
 */
function createDebouncedWriter(file, getData, { debounceMs = 1000, pretty = true, label = 'JsonStore' } = {}) {
    let timer = null;

    function flush() {
        if (timer) { clearTimeout(timer); timer = null; }
        try {
            writeJsonAtomic(file, getData(), { pretty });
        } catch (err) {
            logger.warn(label, `寫入 ${path.basename(file)} 失敗：${err.message}`);
        }
    }

    function schedule() {
        if (timer) return;
        timer = setTimeout(flush, debounceMs);
        timer.unref?.();
    }

    process.on('exit', () => { if (timer) flush(); });

    return { schedule, flush };
}

module.exports = { readJson, writeJsonAtomic, createDebouncedWriter };
