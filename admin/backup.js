'use strict';
// admin/backup.js
// ─────────────────────────────────────────────────────────────
// 設定備份的產生、預覽與還原。這個檔案在 Mousebot 與 mousebot-lite 完全相同；
// 各 Bot 備份哪些檔案由 admin/api/system.js 傳進來。
//
// 為什麼還原要等重新啟動才套用：
//   各模組的設定快取在記憶體裡，Bot 關閉時還會把記憶體裡的資料寫回檔案（例如 token 用量、播放快照），
//   直接覆寫的話重啟途中又會被蓋回去。所以還原分兩步：
//   1. stage()：檢查備份檔，把要還原的檔案放進 data/.restore-pending/（還沒動到真正的設定）
//   2. 重新啟動時，index.js 在載入任何模組之前呼叫 applyPendingRestore()：
//      先把目前的檔案複製到 data/backups/restore-<時間>/（還原前的快照，保留最近 5 份），再換成備份裡的內容
//
// 還原是「覆蓋」：備份裡有的檔案會被換掉，備份裡沒有的檔案維持原樣（例如之後新增的人格不會被刪掉）。

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const bootSummary = require('../utils/bootSummary');
const { getDataDir } = require('../utils/dataDir');

const TYPE = 'settings-backup';
const VERSION = 1;
const PENDING_DIR = '.restore-pending';
const SNAPSHOT_PARENT = 'backups';
const KEEP_SNAPSHOTS = 5;
const MAX_FILE_CHARS = 2 * 1024 * 1024;
const MODE_FILE_RE = /^prompts\/modes\/[A-Za-z0-9_-]{1,32}\.md$/;

class BackupError extends Error {}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

// 寫入：先寫暫存檔再 rename（同目錄 rename 是原子操作），中途斷電不會留下半份檔案
function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.restore.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

const serialize = (rel, value) => (rel.endsWith('.json') ? `${JSON.stringify(value, null, 2)}` : value);

/**
 * @param {{ app: string, settingsFiles: string[], statsFiles: string[], sharedPrompts: string[] }} opts
 *   app：備份檔裡的 app 名稱（還原時必須相同，避免把別隻 Bot 的備份還原進來）
 *   sharedPrompts：共用規則的代號，例如 ['_general', '_group']
 */
function createBackupTools({ app, settingsFiles, statsFiles, sharedPrompts }) {
  const dataDir = () => getDataDir();
  const promptFiles = sharedPrompts.map((k) => `prompts/${k}.md`);
  const fixed = new Set([...settingsFiles, ...statsFiles, ...promptFiles]);
  const isAllowed = (rel) => fixed.has(rel) || MODE_FILE_RE.test(rel);

  function readDataFile(rel) {
    const file = path.join(dataDir(), rel);
    if (!fs.existsSync(file)) return undefined;
    const raw = fs.readFileSync(file, 'utf8');
    if (!rel.endsWith('.json')) return raw;
    try { return JSON.parse(raw); } catch { return raw; }
  }

  function build(includeStats) {
    const files = {};
    for (const rel of [...settingsFiles, ...(includeStats ? statsFiles : []), ...promptFiles]) {
      const value = readDataFile(rel);
      if (value !== undefined) files[rel] = value;
    }
    // AI 人格：各模式（不含 .history 版本紀錄）
    const modesDir = path.join(dataDir(), 'prompts', 'modes');
    if (fs.existsSync(modesDir)) {
      for (const f of fs.readdirSync(modesDir).filter((name) => name.endsWith('.md')).sort()) {
        const rel = `prompts/modes/${f}`;
        if (MODE_FILE_RE.test(rel)) files[rel] = readDataFile(rel);
      }
    }
    return { app, type: TYPE, version: VERSION, createdAt: new Date().toISOString(), files };
  }

  /**
   * 檢查備份檔，回傳可以還原的檔案（內容已轉成要寫入的文字）與略過的檔案
   * @returns {{ createdAt: string|null, entries: Array<{ path: string, content: string }>, skipped: Array<{ path: string, reason: string }> }}
   */
  function parse(backup) {
    if (!backup || typeof backup !== 'object' || Array.isArray(backup)) throw new BackupError('不是備份檔（格式不正確）');
    if (backup.type !== TYPE || !backup.files || typeof backup.files !== 'object' || Array.isArray(backup.files)) {
      throw new BackupError('不是設定備份檔（請用「下載備份」產生的 JSON 檔）');
    }
    if (backup.version !== VERSION) throw new BackupError(`不支援的備份版本：${backup.version}`);
    if (backup.app !== app) throw new BackupError(`這是「${backup.app ?? '未知'}」的備份，不能還原到「${app}」`);

    const entries = [];
    const skipped = [];
    for (const [rel, value] of Object.entries(backup.files)) {
      if (!isAllowed(rel)) { skipped.push({ path: rel, reason: '不是這隻 Bot 會備份的檔案' }); continue; }
      let content;
      if (rel.endsWith('.json')) {
        let v = value;
        // 備份時主檔就壞掉的話，內容會是原始文字
        if (typeof v === 'string') {
          try { v = JSON.parse(v); } catch { skipped.push({ path: rel, reason: '內容不是有效的 JSON' }); continue; }
        }
        if (v === null || typeof v !== 'object') { skipped.push({ path: rel, reason: '內容格式不正確' }); continue; }
        content = serialize(rel, v);
      } else {
        if (typeof value !== 'string') { skipped.push({ path: rel, reason: '內容格式不正確' }); continue; }
        content = value;
      }
      if (content.length > MAX_FILE_CHARS) { skipped.push({ path: rel, reason: '檔案太大' }); continue; }
      entries.push({ path: rel, content });
    }
    return { createdAt: typeof backup.createdAt === 'string' ? backup.createdAt : null, entries, skipped };
  }

  // 和目前的檔案比對：new（目前沒有）、changed、same（JSON 比對解析後的內容，不管排版）
  function statusOf(entry) {
    const file = path.join(dataDir(), entry.path);
    if (!fs.existsSync(file)) return 'new';
    const current = fs.readFileSync(file, 'utf8');
    if (entry.path.endsWith('.json')) {
      try {
        return JSON.stringify(JSON.parse(current)) === JSON.stringify(JSON.parse(entry.content)) ? 'same' : 'changed';
      } catch { return 'changed'; }
    }
    return current === entry.content ? 'same' : 'changed';
  }

  function preview(backup) {
    const { createdAt, entries, skipped } = parse(backup);
    return {
      app,
      createdAt,
      files: entries.map((e) => ({ path: e.path, status: statusOf(e) })).sort((a, b) => a.path.localeCompare(b.path)),
      skipped,
    };
  }

  /** 把要還原的檔案放進 data/.restore-pending/（取代之前還沒套用的還原），下次啟動時套用 */
  function stage(backup) {
    const { createdAt, entries, skipped } = parse(backup);
    const changed = entries.filter((e) => statusOf(e) !== 'same');
    if (!changed.length) throw new BackupError('備份裡的設定和目前完全相同，不需要還原');
    const pending = path.join(dataDir(), PENDING_DIR);
    fs.rmSync(pending, { recursive: true, force: true });
    for (const e of changed) writeAtomic(path.join(pending, 'files', e.path), e.content);
    // manifest 最後寫：重新啟動時只認有 manifest 的暫存（寫到一半被中斷的不會被套用）
    writeAtomic(path.join(pending, 'manifest.json'), JSON.stringify({
      app, backupCreatedAt: createdAt, stagedAt: new Date().toISOString(), files: changed.map((e) => e.path),
    }, null, 2));
    return { staged: changed.length, unchanged: entries.length - changed.length, skipped };
  }

  return { build, preview, stage, BackupError };
}

/**
 * 重新啟動時呼叫（index.js，要在載入任何會讀 data/ 的模組之前）：
 * 有暫存的還原就先做快照，再把檔案換成備份裡的內容。
 * @returns {number} 套用了幾個檔案（沒有暫存的還原時是 0）
 */
function applyPendingRestore() {
  const dir = getDataDir();
  const pending = path.join(dir, PENDING_DIR);
  const manifestFile = path.join(pending, 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    // 只有暫存檔、沒有 manifest：上次寫到一半被中斷，直接清掉
    if (fs.existsSync(pending)) fs.rmSync(pending, { recursive: true, force: true });
    return 0;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (err) {
    logger.error('Backup', `還原暫存的 manifest 壞掉了，略過還原：${err.message}`);
    fs.rmSync(pending, { recursive: true, force: true });
    bootSummary.report('設定還原', 'warn', '暫存的還原資料損毀，沒有套用');
    return 0;
  }

  const files = (Array.isArray(manifest.files) ? manifest.files : [])
    .filter((rel) => typeof rel === 'string' && !rel.includes('..') && !path.isAbsolute(rel));
  const snapshot = path.join(dir, SNAPSHOT_PARENT, `restore-${stamp()}`);
  let applied = 0;
  try {
    for (const rel of files) {
      const src = path.join(pending, 'files', rel);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(dir, rel);
      if (fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(path.join(snapshot, rel)), { recursive: true });
        fs.copyFileSync(dest, path.join(snapshot, rel));
      }
      writeAtomic(dest, fs.readFileSync(src, 'utf8'));
      applied++;
    }
  } catch (err) {
    logger.error('Backup', `套用還原時失敗（已套用 ${applied} 個檔案，還原前的檔案在 ${snapshot}）：`, err);
    bootSummary.report('設定還原', 'warn', `套用到一半失敗（${applied}/${files.length}），還原前的檔案在 data/${path.relative(dir, snapshot)}`);
    fs.rmSync(pending, { recursive: true, force: true });
    return applied;
  }
  fs.rmSync(pending, { recursive: true, force: true });
  pruneSnapshots(path.join(dir, SNAPSHOT_PARENT));

  const msg = `已套用 ${applied} 個檔案（備份時間 ${manifest.backupCreatedAt ?? '未知'}）；還原前的檔案在 data/${path.relative(dir, snapshot).split(path.sep).join('/')}`;
  logger.success('Backup', `設定還原：${msg}`);
  bootSummary.report('設定還原', 'ok', msg);
  return applied;
}

function pruneSnapshots(parent) {
  try {
    const dirs = fs.readdirSync(parent).filter((d) => d.startsWith('restore-')).sort();
    for (const d of dirs.slice(0, Math.max(0, dirs.length - KEEP_SNAPSHOTS))) {
      fs.rmSync(path.join(parent, d), { recursive: true, force: true });
    }
  } catch {}
}

module.exports = { createBackupTools, applyPendingRestore, BackupError, _stamp: stamp };
