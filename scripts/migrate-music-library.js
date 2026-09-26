#!/usr/bin/env node
'use strict';
// scripts/migrate-music-library.js
// ─────────────────────────────────────────────────────────────
// 一次性遷移工具：把「現有那台 Bot、掛著舊 Volume」裡的 data/music
// 整個目錄，透過 library-service 的上傳 API 搬到新的共用音樂庫服務。
//
// 使用時機：
//   1. Library Service 已經部署好，MUSIC_LIB_URL / MUSIC_LIB_SECRET
//      都已經在「原本這台 Bot」的環境變數設定好之後
//   2. 在原本這台（目前仍掛著舊 Volume）的 Bot 服務上執行一次：
//        node scripts/migrate-music-library.js
//   3. 執行完畢後，用 Library Service 的 GET /api/music/list
//      （或之後 /music local list 指令）確認筆數／曲目跟本地一致
//
// 具備續傳能力：本地檔案已經存在於遠端、且大小相同時會直接略過，
// 中斷後重新執行不會重複上傳，也不會導致資料損毀（Library Service
// 端一律是暫存檔 + rename 的原子寫入）。
//
// 這支腳本只讀取本地檔案、只呼叫 library-service 的 API，
// 不會刪除或修改本地任何檔案，執行完之後要不要清掉舊 Volume
// 由你自己決定。

const fs = require('fs');
const path = require('path');
const libraryClient = require('../handlers/musicplayer/musicLibraryClient');

const MUSIC_DIR = path.join(__dirname, '..', 'data', 'music');

function walkFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let out = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(walkFiles(fullPath));
    } else if (!entry.name.endsWith('.tmp')) {
      out.push(fullPath);
    }
  }
  return out;
}

async function main() {
  if (!libraryClient.isConfigured()) {
    console.error('❌ 未設定 MUSIC_LIB_URL，請先設定環境變數再執行遷移。');
    process.exit(1);
  }

  if (!fs.existsSync(MUSIC_DIR)) {
    console.error(`❌ 找不到本地音樂資料夾: ${MUSIC_DIR}`);
    process.exit(1);
  }

  const files = walkFiles(MUSIC_DIR);
  console.log(`🔍 找到 ${files.length} 個檔案，開始檢查／上傳到共用音樂庫...\n`);

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const fp of files) {
    const relPath = path.relative(MUSIC_DIR, fp).split(path.sep).join('/');
    try {
      const localSize = fs.statSync(fp).size;
      const remote = await libraryClient.checkExists(relPath);

      if (remote && remote.exists && remote.size === localSize) {
        skipped++;
        continue;
      }

      await libraryClient.uploadFile(relPath, fp);
      uploaded++;
      console.log(`  ✅ ${relPath}`);
    } catch (err) {
      failed++;
      console.error(`  ❌ ${relPath}：${err.message}`);
    }
  }

  console.log(`\n完成：上傳 ${uploaded} 個、略過（遠端已存在且大小相同）${skipped} 個、失敗 ${failed} 個`);
  if (failed > 0) {
    console.log('有檔案上傳失敗，請確認錯誤訊息後重新執行這支腳本（已成功的部分會自動略過，不會重複上傳）。');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ 遷移腳本發生未預期錯誤:', err);
  process.exit(1);
});
