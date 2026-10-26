// .github/scripts/audit.js — CI 的相依套件漏洞檢查
// 用法：npm audit --omit=dev --json > audit.json || true; node .github/scripts/audit.js audit.json
//
// high 以上的漏洞一律讓 CI 失敗，只有一種例外：漏洞的根源是 tar，而且 tar 只被
// @discordjs/node-pre-gyp 用到。node-pre-gyp 只在 npm install 時下載並解壓 @discordjs/opus 的預編譯檔，
// 執行期完全不會碰 tar；上游目前沒有修正版（@discordjs/opus 0.10.0 仍依賴 node-pre-gyp 0.4.5 → tar 6），
// 每次 tar 有新漏洞就讓 CI 紅燈也沒辦法處理。只要 tar 被任何其他套件用到，這個例外就自動失效。
'use strict';
/* eslint-disable no-console -- CI 腳本，結果直接印在 GitHub Actions 的 log */

const fs = require('fs');

const BUILD_ONLY_ROOT = 'tar';
const BUILD_ONLY_PARENTS = new Set(['@discordjs/node-pre-gyp']);
const FAIL_LEVELS = new Set(['high', 'critical']);

const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const vulns = report.vulnerabilities || {};

const root = vulns[BUILD_ONLY_ROOT];
const rootIsBuildOnly = !!root && root.effects.every((name) => BUILD_ONLY_PARENTS.has(name));

// 這個漏洞是否完全來自「只在安裝時用到的 tar」
const memo = new Map();
function buildOnly(name, seen = new Set()) {
  if (memo.has(name)) return memo.get(name);
  if (seen.has(name)) return false;
  seen.add(name);
  const v = vulns[name];
  const ok = !!v && v.via.every((via) => (typeof via === 'string'
    ? buildOnly(via, seen)
    : name === BUILD_ONLY_ROOT && rootIsBuildOnly));
  memo.set(name, ok);
  return ok;
}

const failing = [];
const allowed = [];
for (const [name, v] of Object.entries(vulns)) {
  if (!FAIL_LEVELS.has(v.severity)) continue;
  (buildOnly(name) ? allowed : failing).push(`${name} (${v.severity})`);
}

if (allowed.length) console.log(`允許（只在安裝時經由 @discordjs/node-pre-gyp 用到的 tar）：${allowed.join(', ')}`);
if (failing.length) {
  console.error(`有 high 以上的漏洞需要處理：${failing.join(', ')}`);
  console.error('執行 npm audit --omit=dev 看細節；能修的用 npm audit fix，不能修的請評估後再決定是否加進這支腳本的例外。');
  process.exit(1);
}
console.log('npm audit：沒有需要處理的 high 以上漏洞');
