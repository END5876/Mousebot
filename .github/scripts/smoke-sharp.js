// .github/scripts/smoke-sharp.js — 在建好的 Docker 映像裡確認圖片解碼防護真的生效（CI 用）
// docker run --rm -v "$PWD/.github/scripts:/ci:ro" --entrypoint node <image> /ci/smoke-sharp.js
//
// sharp 的 loader 名稱來自 libvips，換版本或換平台時可能改名：名稱對不上的話 block()／unblock() 不會報錯，
// 只會靜悄悄地沒有效果。這裡載入 Bot 真正的設定（handlers/ai/aiUtils.js），確認 PNG 能解、SVG 與 TIFF 被擋。
'use strict';
/* eslint-disable no-console -- CI 腳本，結果直接印在 GitHub Actions 的 log */

// 載入 aiUtils 會順便載入 TTS 等模組，有些會掛計時器；最後一律 process.exit
require('/app/handlers/ai/aiUtils.js');
const sharp = require(require.resolve('sharp', { paths: ['/app'] }));

async function decodes(buf) {
  try { await sharp(buf).metadata(); return true; } catch { return false; }
}

(async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const tiff = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).tiff().toBuffer().catch(() => null);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>');

  const results = { png: await decodes(png), svg: await decodes(svg), tiff: tiff ? await decodes(tiff) : false };
  console.log('sharp', sharp.versions, results);
  if (!results.png) throw new Error('PNG 應該要能解碼');
  if (results.svg) throw new Error('SVG 應該被 sharp.block() 擋下');
  if (results.tiff) throw new Error('TIFF 應該被 sharp.block() 擋下');
  console.log('圖片解碼防護：OK');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
