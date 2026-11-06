// utils/bootSummary.js
// 開機摘要收集器：
//   各模組在 setup 時呼叫 report()，記下自己「有沒有正常啟用」，
//   不要各自 console.log 洗版。等所有模組都跑完，index.js 最後統一呼叫 print()，
//   印出一張整齊的表格，一眼看完整個 Bot 的啟動狀態。
//
// 用法：
//   const bootSummary = require('../../utils/bootSummary');
//   bootSummary.report('AI 對話 (/ai)', 'ok', 'Gemini API 已連線，9 種人格模式可用');
//   bootSummary.report('文字轉語音 (/tts)', 'warn', 'SoVITS 離線，改用 edge-tts fallback');
//   bootSummary.report('限免通知 (/notify)', 'off', '尚未設定任何通知頻道');
//
// 會回報哪些模組、依什麼順序，由 utils/features.js 的 MODULES 決定
//   （啟用的模組在自己的 setup 裡回報；沒啟用的由 setupModules() 回報成 off）。
//   另外還有模組內部或 index.js 自己回報的列，例如線上音樂 (YouTube/Bilibili)、
//   網頁正在播放同步、擁有者權限、Slash Commands 註冊。

const items = [];

/**
 * @param {string} name   模組顯示名稱，例如 'AI 對話'
 * @param {'ok'|'warn'|'off'} status
 * @param {string} [detail] 補充說明，會印在同一行
 */
function report(name, status, detail = '') {
  items.push({ name, status, detail });
}

// 計算「顯示寬度」：全形字元（中日韓文字、標點）算 2，半形算 1
// 一般 String.length 對中文字只算 1，會導致等寬對齊跑掉
function displayWidth(str) {
  let width = 0;
  for (const ch of str) {
    width += /[\u1100-\uFFFD]/.test(ch) && ch.charCodeAt(0) > 0x2E80 ? 2 : 1;
  }
  return width;
}

function padDisplay(str, targetWidth) {
  const gap = targetWidth - displayWidth(str);
  return gap > 0 ? str + ' '.repeat(gap) : str;
}

function print() {
  const ICONS = { ok: '✅', warn: '⚠️ ', off: '⛔' };
  const nameWidth = Math.max(...items.map(i => displayWidth(i.name)), 8);

  console.log('\n┌─ Mousebot 啟動摘要 ' + '─'.repeat(30));
  for (const { name, status, detail } of items) {
    const icon = ICONS[status] ?? '•';
    console.log(`│ ${icon} ${padDisplay(name, nameWidth)}  ${detail}`);
  }
  console.log('└' + '─'.repeat(50));

  const warnCount = items.filter(i => i.status === 'warn').length;
  const offCount = items.filter(i => i.status === 'off').length;
  if (warnCount > 0 || offCount > 0) {
    console.log(`   （${warnCount} 項降級運作、${offCount} 項未啟用，詳見上表）\n`);
  } else {
    console.log('   全部模組正常啟動 🎉\n');
  }
}

function reset() {
  items.length = 0;
}

/** 目前已回報的模組狀態（管理面板總覽頁用） */
function getItems() {
  return items.map(i => ({ ...i }));
}

module.exports = { report, print, reset, getItems };
