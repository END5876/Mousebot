'use strict';
// 深色/淺色模式切換（頁首切換鈕）；FOUC 防閃爍的行內小腳本仍留在 index.html 的 <head>。
/* =====================================================================
   🆕 深色/淺色模式切換
   ---------------------------------------------------------------------
   實際的配色定義在樣式表裡的 :root 與 :root[data-theme="dark"]（見檔案
   最前面），這裡只負責：切換根元素上的 data-theme 屬性、記住使用者的
   選擇、同步頁首那顆切換鈕的圖示與文字。頁面最前面另外有一段行內小型
   腳本，會在畫面第一次繪製前就先套用好 localStorage／系統偏好，避免
   閃一下錯的主題（FOUC），這裡的 syncThemeToggleUI() 只是把圖示狀態接上。
===================================================================== */
function syncThemeToggleUI(theme){
  const icon = document.getElementById('themeToggleIcon');
  const btn = document.getElementById('themeToggleBtn');
  const label = theme === 'dark' ? '切換為淺色模式' : '切換為深色模式';
  if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
  if (btn){ btn.title = label; btn.setAttribute('aria-label', label); }
}
function setTheme(theme, persist){
  document.documentElement.setAttribute('data-theme', theme);
  syncThemeToggleUI(theme);
  if (persist){
    try{ localStorage.setItem('splitbill-theme', theme); }catch(e){}
  }
}
function toggleTheme(){
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  setTheme(current === 'dark' ? 'light' : 'dark', true);
}
// 初始化圖示狀態：data-theme 已經在頁面最前面的行內小型腳本提早設定好了，這裡只需要
// 同步一次圖示與 aria-label 文字，不重新寫入 localStorage——避免把「使用者根本還
// 沒手動選過、目前只是跟隨系統偏好」這個狀態，錯誤地變成「已經手動選過」。
syncThemeToggleUI(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

// 使用者還沒手動選過主題時（localStorage 裡沒存值），跟著作業系統的深色/淺色偏好
// 即時連動；一旦使用者按過切換鈕，就以使用者的手動選擇為準，不再跟系統變動。
if (window.matchMedia){
  const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const handleSystemThemeChange = (e) => {
    let saved = null;
    try{ saved = localStorage.getItem('splitbill-theme'); }catch(err){}
    if (!saved) setTheme(e.matches ? 'dark' : 'light', false);
  };
  if (darkModeQuery.addEventListener) darkModeQuery.addEventListener('change', handleSystemThemeChange);
  else if (darkModeQuery.addListener) darkModeQuery.addListener(handleSystemThemeChange); // Safari 舊版相容
}

