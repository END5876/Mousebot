'use strict';
// 頁面載入時的啟動流程：分享模式偵測優先，否則嘗試恢復上次連線或自動連線。
/* init */
window.addEventListener('beforeunload', disconnectTripEventStream); // 🆕 [即時同步] 離開頁面時主動關閉 SSE 連線，讓伺服器能立即釋放資源
initFsApiUi();
renderAll();
// 🆕 [分享連結] 分享連結模式優先於一般的擁有者自動連線流程——兩者互斥，
// 一個分頁只會是「擁有者」或「分享連結訪客」其中一種身分。
// 網址 hash 裡的 token（剛點連結進來）優先；如果沒有，改看這個分頁的
// sessionStorage 裡有沒有「重新整理前」還在用的 token，讓訪客重新整理
// 頁面後可以繼續留在同一個行程，不用回頭跟建立連結的人再要一次網址。
const __shareToken = detectShareTokenFromUrl() || getPersistedShareToken();
if (__shareToken){
  initShareMode(__shareToken);
} else {
  (async function autoConnectOnLoad(){
    const usedUrlParams = await applyUrlParams();
    if (usedUrlParams) return;
    // 🆕 擁有者這邊：網址沒帶明確的連線參數時，嘗試用上次連線成功時記住的
    // 伺服器/行程自動接回去，不用每次重新整理都重新輸入金鑰、重新選一次
    // 行程。（帶了明確網址參數的書籤網址優先權比較高，畢竟是使用者當下
    // 明確點的那個連結，理應照著它的設定連線。）
    const restored = await restoreOwnerConnectionState();
    if (restored) return;
    // 若此頁是由 webui/server.js 同源提供、且伺服器沒設金鑰，嘗試安靜地自動連線一次；
    // 若連線失敗或伺服器要求驗證，顯示無權限阻擋頁。
    try {
      const res = await fetch('/api/guilds');
      if (res.ok) {
        refreshGuildList();
      } else {
        showNoAccessScreen();
      }
    } catch(e) {
      showNoAccessScreen();
    }
  })();
}
