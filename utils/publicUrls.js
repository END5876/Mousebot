'use strict';

// 使用者點得到的網頁網址（選填環境變數，ui-review 決定 14）：
//   MUSIC_PUBLIC_URL      裊器音樂，例如 https://music.example.com
//   SPLITBILL_PUBLIC_URL  裊器分帳，例如 https://splitbill.example.com
// 跟 MUSIC_LIB_URL、SPLITBILL_SERVICE_URL 不一樣：那兩個是 Docker 內部網址，使用者點不到。
// 沒設定或格式不對時回傳 null，呼叫端就不顯示「在網頁開啟」按鈕，文字也不提網頁。
const { ButtonBuilder, ButtonStyle } = require('discord.js');

function publicUrl(name) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return raw.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

const musicUrl = () => publicUrl('MUSIC_PUBLIC_URL');
const splitbillUrl = () => publicUrl('SPLITBILL_PUBLIC_URL');

/** 連結按鈕；url 是 null 時回傳 null（呼叫端過濾掉） */
function linkButton(label, url, emoji) {
  if (!url) return null;
  const b = new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url);
  if (emoji) b.setEmoji(emoji);
  return b;
}

module.exports = { musicUrl, splitbillUrl, linkButton };
