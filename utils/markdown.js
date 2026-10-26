// utils/markdown.js
// 外部來源的文字（影片標題、作者、網頁播放器送來的歌名）放進 Discord 訊息前用。
//
// 🔒 標題由影片上傳者或網頁播放器的使用者決定：沒跳脫的話，「Free Nitro](https://evil.example/login) [x」
// 這種標題放進 `[${title}](${url})` 會變成以 Bot 身分顯示、指向任意網域的偽裝連結。
// 除了 discord.js 的 escapeMarkdown（* _ ~ ` | > 等），再跳脫遮罩連結用的 [ ] ( ) 與角括號。
// 只用在要送進 Discord 的字串；回給網頁或寫進 log 的不要用（畫面上會多出反斜線）。

const { escapeMarkdown } = require('discord.js');

function md(text) {
  return escapeMarkdown(String(text ?? '')).replace(/[[\]()<>]/g, (c) => `\\${c}`);
}

module.exports = { md };
