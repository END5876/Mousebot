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
}

module.exports = { install, setFatalHook };
