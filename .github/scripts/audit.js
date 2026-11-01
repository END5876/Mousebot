// .github/scripts/audit.js — CI 的相依套件漏洞檢查
// 用法：npm audit --omit=dev --json > audit.json || true; node .github/scripts/audit.js audit.json
//
// high 以上的漏洞一律讓 CI 失敗，只有一種例外：漏洞的根源是 tar，而且 tar 只被
// @discordjs/node-pre-gyp 用到。node-pre-gyp 只在 npm install 時下載並解壓 @discordjs/opus 的預編譯檔，
// 執行期完全不會碰 tar；上游目前沒有修正版（@discordjs/opus 0.10.0 仍依賴 node-pre-gyp 0.4.5 → tar 6），
// 每次 tar 有新漏洞就讓 CI 紅燈也沒辦法處理。同樣的道理也適用於 node-pre-gyp 帶進來的 rimraf → glob → minimatch
// （minimatch 的 DoS 公告）。只要這些根源套件被任何其他套件用到，例外就自動失效。
'use strict';
/* eslint-disable no-console -- CI 腳本，結果直接印在 GitHub Actions 的 log */

const fs = require('fs');

const BUILD_ONLY_ROOTS = new Set(['tar', 'minimatch']);
const BUILD_ONLY_PARENTS = new Set(['@discordjs/node-pre-gyp']);
const FAIL_LEVELS = new Set(['high', 'critical']);

const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const vulns = report.vulnerabilities || {};

// 誰依賴誰：從 via 反推。npm 的 effects 欄位對較低嚴重度的套件（rimraf）可能是空的，不能拿來往上追
const users = {};
for (const [name, v] of Object.entries(vulns)) {
  for (const via of v.via) if (typeof via === 'string') (users[via] ??= []).push(name);
}

// 套件的所有使用者（沿著 users 往上追）是否最後都只到 node-pre-gyp
const onlyViaBuild = (name, seen = new Set()) => {
  if (BUILD_ONLY_PARENTS.has(name)) return true;
  if (seen.has(name)) return false;
  seen.add(name);
  const parents = users[name] ?? [];
  return parents.length > 0 && parents.every((e) => onlyViaBuild(e, seen));
};
const buildOnlyRoots = new Set([...BUILD_ONLY_ROOTS].filter((r) => vulns[r] && onlyViaBuild(r)));

// 這個漏洞是否完全來自「只在安裝時用到的」套件
const memo = new Map();
function buildOnly(name, seen = new Set()) {
  if (memo.has(name)) return memo.get(name);
  if (seen.has(name)) return false;
  seen.add(name);
  const v = vulns[name];
  const ok = !!v && v.via.every((via) => (typeof via === 'string'
    ? buildOnly(via, seen)
    : buildOnlyRoots.has(name)));
  memo.set(name, ok);
  return ok;
}

const failing = [];
const allowed = [];
for (const [name, v] of Object.entries(vulns)) {
  if (!FAIL_LEVELS.has(v.severity)) continue;
  (buildOnly(name) ? allowed : failing).push(`${name} (${v.severity})`);
}

if (allowed.length) console.log(`允許（只在安裝時經由 @discordjs/node-pre-gyp 用到的 tar／minimatch）：${allowed.join(', ')}`);
if (failing.length) {
  console.error(`有 high 以上的漏洞需要處理：${failing.join(', ')}`);
  console.error('執行 npm audit --omit=dev 看細節；能修的用 npm audit fix，不能修的請評估後再決定是否加進這支腳本的例外。');
  process.exit(1);
}
console.log('npm audit：沒有需要處理的 high 以上漏洞');
