// utils/processGuards.js
// 整個程序唯一的 unhandledRejection / uncaughtException 處理點。
//
// 過去 index.js、autoJoinHandler.js、onlineMusicHandler.js 各自註冊一份，
// 而且 uncaughtException 只記 log 就繼續跑——Node 官方文件明確指出，
// 發生未捕捉例外後程序狀態可能已不一致（半開的 socket、壞掉的 stream、
// 沒清掉的 timer），繼續執行比重啟更危險。
//
// 行為：
//   unhandledRejection → 只記錄（與舊行為相同，單一 Promise 失敗不該殺掉整個 Bot）
//   uncaughtException  → 記錄完整堆疊後，約 1 秒內以 exit code 1 結束，
//                        由 supervisord（autorestart=true）重新拉起。
//   EXIT_ON_UNCAUGHT=0 → 恢復舊行為（只記錄不結束），本機沒有 supervisor 時可用。
//   SIGTERM / SIGINT   → 執行關閉掛鉤與 fatalHook（若有設定），最多等 SHUTDOWN_TIMEOUT_MS，再以 process.exit() 結束。
//                        沒有這個處理時程序是被訊號直接殺掉，process.on('exit') 不會執行，
//                        tokenTracker 尚未寫入的用量、yt-dlp 子程序清理都會被跳過。
//   onShutdown(fn)     → 註冊「關閉 Discord 連線之前」要執行的動作（例如寫出音樂佇列快照）。
//                        斷線本身會觸發各模組的清理邏輯（stopAll 等），快照必須在那之前寫出。
//                        fn 會依註冊順序同步呼叫；回傳 Promise 的（例如通知網頁「Bot 下線」）
//                        關閉時會等它完成，和 fatalHook 共用同一個 SHUTDOWN_TIMEOUT_MS 上限。

const logger = require('./logger');
const { recordCrash } = require('./crashLog');

const SHUTDOWN_TIMEOUT_MS = 3000;

let installed = false;
let exiting = false;
let fatalHook = null;
const shutdownHooks = [];

function onShutdown(fn) {
  if (typeof fn === 'function') shutdownHooks.push(fn);
}

/** 依序呼叫所有關閉掛鉤；回傳「全部非同步工作都結束」的 Promise（失敗只記錄，不會 reject） */
function runShutdownHooks() {
  const pending = [];
  for (const fn of shutdownHooks) {
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        pending.push(Promise.resolve(result).catch(err => logger.warn('Process', `關閉前處理失敗：${err?.message || err}`)));
      }
    } catch (err) { logger.error('Process', '關閉前處理失敗：', err); }
  }
  return Promise.all(pending);
}

function setFatalHook(fn) {
  fatalHook = typeof fn === 'function' ? fn : null;
}

function install() {
  if (installed) return;
  installed = true;

  process.on('unhandledRejection', (reason) => {
    logger.error('Process', '未處理的 Promise 拒絕：', reason);
  });

  process.on('uncaughtException', (error, origin) => {
    logger.error('Process', `未捕捉的例外 (${origin})：`, error);
    // 重啟後管理面板總覽還看得到上一次為什麼掛掉（data/lastCrash.json）
    recordCrash(origin, error);

    if (process.env.EXIT_ON_UNCAUGHT === '0') return;
    if (exiting) return;
    exiting = true;

    logger.error('Process', '程序狀態可能已不一致，將於 1 秒內結束並交由 supervisord 重啟');
    runShutdownHooks();
    try { fatalHook?.(); } catch {}
    setTimeout(() => process.exit(1), 1000);
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => gracefulShutdown(signal));
  }
}

async function gracefulShutdown(signal) {
  if (exiting) return;
  exiting = true;

  logger.info('Process', `⏹️ 收到 ${signal}，正在關閉...`);
  const hooks = runShutdownHooks();
  const timeout = new Promise(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));
  const fatal = (async () => { try { await fatalHook?.(); } catch {} })();
  await Promise.race([Promise.all([hooks, fatal]), timeout]);
  // process.exit() 會觸發各模組註冊的 'exit' 處理（寫入用量紀錄、結束子程序）
  process.exit(0);
}

/**
 * 主動要求關閉（管理面板的「重新啟動」）：流程與收到 SIGTERM 相同，
 * 結束後由 supervisord（autorestart=true）重新啟動；沒有 supervisor 時就是單純關閉。
 */
function requestShutdown(reason) {
  return gracefulShutdown(reason);
}

/** 是否由 supervisord 管理（它會在子程序的環境變數設定 SUPERVISOR_ENABLED） */
function isSupervised() {
  return !!process.env.SUPERVISOR_ENABLED;
}

module.exports = { install, setFatalHook, onShutdown, requestShutdown, isSupervised };
