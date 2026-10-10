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
//   SIGTERM / SIGINT   → 先關閉 Discord 連線（最多等 SHUTDOWN_TIMEOUT_MS），再以 process.exit() 結束。
//                        沒有這個處理時程序是被訊號直接殺掉，process.on('exit') 不會執行，
//                        tokenTracker 尚未寫入的用量、yt-dlp 子程序清理都會被跳過。

const SHUTDOWN_TIMEOUT_MS = 3000;

let installed = false;
let exiting = false;
let fatalHook = null;

function setFatalHook(fn) {
  fatalHook = typeof fn === 'function' ? fn : null;
}

function install() {
  if (installed) return;
  installed = true;

  process.on('unhandledRejection', (reason) => {
    console.error('❌ 未處理的 Promise 拒絕：', reason);
  });

  process.on('uncaughtException', (error, origin) => {
    console.error(`❌ 未捕捉的例外 (${origin})：`, error);

    if (process.env.EXIT_ON_UNCAUGHT === '0') return;
    if (exiting) return;
    exiting = true;

    console.error('⛔ 程序狀態可能已不一致，將於 1 秒內結束並交由 supervisord 重啟');
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

  console.log(`⏹️ 收到 ${signal}，正在關閉...`);
  const timeout = new Promise(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));
  try {
    await Promise.race([Promise.resolve(fatalHook?.()), timeout]);
  } catch {}
  // process.exit() 會觸發各模組註冊的 'exit' 處理（寫入用量紀錄、結束子程序）
  process.exit(0);
}

module.exports = { install, setFatalHook };
