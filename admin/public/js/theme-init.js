// 在 <head> 裡同步執行：CSS 套用前就先決定主題（記住的選擇 → 系統偏好），避免深色模式閃一下淺色。
// 與 js/app.js 的 THEME_KEY、THEME_COLORS 保持一致。
(function () {
  var dark = false;
  try {
    dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (e) {}
  try {
    var saved = localStorage.getItem('mousebot-admin-theme');
    if (saved === 'dark' || saved === 'light') dark = saved === 'dark';
  } catch (e) {}
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta && dark) meta.setAttribute('content', '#1E1F22');
})();
