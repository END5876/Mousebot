const path = require('path');
const fs   = require('fs');
const logger = require('../../utils/logger');

// ════════════════════════════════════════════════════════
//  Prompt 存放區
// ════════════════════════════════════════════════════════
// 所有 AI 模式的 system prompt 都放在 data/prompts/（已被 .gitignore 排除），
// 不再寫死在程式碼裡，修改後不需重啟：
//
//   data/prompts/_general.md        所有文字回覆共用的全局規則
//   data/prompts/_voice.md          語音回覆時額外附加的規則
//   data/prompts/modes/<mode>.md    各模式，檔名即模式代號
//   data/prompts/.history/          覆寫或刪除前自動保留的舊版本（每個代號最近 20 版）
//
// 模式檔格式（front matter 只支援單行 `key: value`）：
//   ---
//   name: 戀人模式
//   shortDescription: ...
//   clearMemoryMessage: 已經清除記憶了喔~
//   ---
//   （以下為 system prompt 本文）
//
// 熱重載：每次讀取時若距上次檢查超過 RELOAD_CHECK_MS，就比對檔案 mtime，
// 有變動才重新解析。不用 fs.watch，是因為它在 Docker bind mount / 網路磁碟上
// 常收不到事件。解析失敗時保留上一版內容，不讓壞檔案把 bot 弄掛。
// ════════════════════════════════════════════════════════

const PROMPTS_DIR   = path.resolve(__dirname, '../../data/prompts');
const MODES_DIR     = path.join(PROMPTS_DIR, 'modes');
const RELOAD_CHECK_MS = 2000;

const SHARED_FILES = {
    _general: path.join(PROMPTS_DIR, '_general.md'),
    _voice:   path.join(PROMPTS_DIR, '_voice.md'),
};

const MODE_KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;
const META_KEYS   = ['name', 'shortDescription', 'clearMemoryMessage'];
const DEFAULT_CLEAR_MESSAGE = '🧠 已清除你的對話記憶。';

/** @type {Map<string, {name:string, shortDescription?:string, clearMemoryMessage:string, prompt:string, mtimeMs:number}>} */
let modes  = new Map();
/** @type {{_general?: {text:string, mtimeMs:number}, _voice?: {text:string, mtimeMs:number}}} */
let shared = {};
let lastCheck = 0;

// ── 解析 / 序列化 ─────────────────────────────────────────

function parseModeFile(key, raw) {
    const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const meta = {};
    let body = text;

    const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
    if (fm) {
        for (const line of fm[1].split('\n')) {
            const idx = line.indexOf(':');
            if (idx === -1) continue;
            meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
        body = text.slice(fm[0].length);
    }

    return {
        name:               meta.name || key,
        shortDescription:   meta.shortDescription || undefined,
        clearMemoryMessage: meta.clearMemoryMessage || DEFAULT_CLEAR_MESSAGE,
        prompt:             body.trim(),
    };
}

function serializeModeFile(mode) {
    const fm = META_KEYS
        .filter(k => mode[k])
        .map(k => `${k}: ${String(mode[k]).replace(/\r?\n/g, ' ').trim()}`)
        .join('\n');
    return `---\n${fm}\n---\n${mode.prompt.trim()}\n`;
}

// ── 載入 / 熱重載 ─────────────────────────────────────────

function readIfChanged(file, prevMtime) {
    const stat = fs.statSync(file);
    if (prevMtime === stat.mtimeMs) return null;
    return { raw: fs.readFileSync(file, 'utf-8'), mtimeMs: stat.mtimeMs };
}

function refresh(force = false) {
    const now = Date.now();
    if (!force && now - lastCheck < RELOAD_CHECK_MS) return;
    lastCheck = now;

    // 共用規則
    for (const [key, file] of Object.entries(SHARED_FILES)) {
        try {
            if (!fs.existsSync(file)) {
                if (shared[key]) logger.warn('PromptStore', `${key}.md 已被移除`);
                delete shared[key];
                continue;
            }
            const res = readIfChanged(file, shared[key]?.mtimeMs);
            if (!res) continue;
            shared[key] = { text: res.raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim(), mtimeMs: res.mtimeMs };
            if (!force) logger.success('PromptStore', `已重新載入 ${key}.md`);
        } catch (err) {
            logger.warn('PromptStore', `讀取 ${key}.md 失敗，沿用舊版：${err.message}`);
        }
    }

    // 各模式
    let files;
    try {
        files = fs.existsSync(MODES_DIR) ? fs.readdirSync(MODES_DIR) : [];
    } catch (err) {
        logger.warn('PromptStore', `讀取 modes 資料夾失敗：${err.message}`);
        return;
    }

    const next = new Map();
    for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const key = file.slice(0, -3);
        if (!MODE_KEY_RE.test(key)) continue;

        const prev = modes.get(key);
        try {
            const res = readIfChanged(path.join(MODES_DIR, file), prev?.mtimeMs);
            if (!res) { next.set(key, prev); continue; }
            const parsed = parseModeFile(key, res.raw);
            if (!parsed.prompt) throw new Error('prompt 本文為空');
            next.set(key, { ...parsed, mtimeMs: res.mtimeMs });
            if (!force) logger.success('PromptStore', `已重新載入模式 ${key}`);
        } catch (err) {
            logger.warn('PromptStore', `解析 ${file} 失敗${prev ? '，沿用舊版' : ''}：${err.message}`);
            if (prev) next.set(key, prev);
        }
    }
    for (const key of modes.keys()) {
        if (!next.has(key) && !force) logger.warn('PromptStore', `模式 ${key} 已被移除`);
    }
    modes = next;
}

// ── 讀取 API ─────────────────────────────────────────────

/** 目前所有可用的模式代號 */
function listModes() {
    refresh();
    return [...modes.keys()];
}

/** 取得模式資料，不存在回傳 null */
function getMode(key) {
    refresh();
    return modes.get(key) ?? null;
}

/** 取得共用規則（_general / _voice），不存在回傳空字串 */
function getShared(key) {
    refresh();
    return shared[key]?.text ?? '';
}

// ── 版本紀錄 ─────────────────────────────────────────────
// 覆寫或刪除前把目前的檔案留一份到 data/prompts/.history/<modes|shared>/<代號>/<存檔時間>.md，
// 每個代號保留最近 HISTORY_KEEP 版。/ai prompt edit 與管理面板都會經過這裡。
// 保存失敗只記警告，不影響存檔本身。

const HISTORY_DIR  = path.join(PROMPTS_DIR, '.history');
const HISTORY_KEEP = 20;
const HISTORY_KINDS = ['modes', 'shared'];

function historyDir(kind, key) {
    if (!HISTORY_KINDS.includes(kind)) throw new Error(`未知的版本類型：${kind}`);
    if (kind === 'modes' ? !MODE_KEY_RE.test(key) : !SHARED_FILES[key]) throw new Error(`代號不正確：${key}`);
    return path.join(HISTORY_DIR, kind, key);
}

// 版本檔名是當初存檔的時間（毫秒），由新到舊排序
function listVersionFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => /^\d+\.md$/.test(f))
        .sort((a, b) => Number(b.slice(0, -3)) - Number(a.slice(0, -3)));
}

// next：即將寫入的新內容（刪除時為 null）
function archive(kind, key, file, next) {
    try {
        if (!fs.existsSync(file)) return;
        const dir = historyDir(kind, key);
        const content = fs.readFileSync(file, 'utf-8');
        // 存的內容沒有變（例如連按兩次儲存）、或目前內容已經是最近一版，就不重複保存
        if (content === next) return;
        const versions = listVersionFiles(dir);
        if (versions.length && fs.readFileSync(path.join(dir, versions[0]), 'utf-8') === content) return;

        fs.mkdirSync(dir, { recursive: true });
        const savedAt = Math.floor(fs.statSync(file).mtimeMs);
        const target = path.join(dir, `${savedAt}.md`);
        if (!fs.existsSync(target)) fs.writeFileSync(target, content, 'utf-8');
        for (const old of listVersionFiles(dir).slice(HISTORY_KEEP)) fs.rmSync(path.join(dir, old), { force: true });
    } catch (err) {
        logger.warn('PromptStore', `保存 ${key} 的舊版本失敗：${err.message}`);
    }
}

/**
 * 列出舊版本（由新到舊）
 * @param {'modes'|'shared'} kind
 * @returns {Array<{ id: string, savedAt: number, size: number }>}
 */
function listHistory(kind, key) {
    const dir = historyDir(kind, key);
    return listVersionFiles(dir).map(f => ({
        id: f.slice(0, -3),
        savedAt: Number(f.slice(0, -3)),
        size: fs.statSync(path.join(dir, f)).size,
    }));
}

/** 讀取某個舊版本：模式回傳解析後的欄位，共用規則回傳 { text }；不存在時回傳 null */
function getHistoryVersion(kind, key, id) {
    if (!/^\d+$/.test(String(id))) return null;
    const file = path.join(historyDir(kind, key), `${id}.md`);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf-8');
    if (kind === 'shared') return { text: raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim() };
    return parseModeFile(key, raw);
}

/** 已經刪除、但還留有舊版本可以還原的模式代號 */
function listDeletedModes() {
    refresh();
    const dir = path.join(HISTORY_DIR, 'modes');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(key => MODE_KEY_RE.test(key) && !modes.has(key) && listVersionFiles(path.join(dir, key)).length > 0);
}

// ── 寫入 API（給 /ai prompt edit 用）─────────────────────

function atomicWrite(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, file);
}

/**
 * 新增或覆寫模式檔
 * @param {string} key
 * @param {{name?:string, shortDescription?:string, clearMemoryMessage?:string, prompt:string}} data
 */
function saveMode(key, data) {
    if (!MODE_KEY_RE.test(key)) throw new Error(`模式代號只能使用英數、底線、連字號（1~32 字）：${key}`);
    if (!data.prompt?.trim()) throw new Error('prompt 本文不可為空');
    const prev = modes.get(key);
    const merged = {
        name:               data.name?.trim() || prev?.name || key,
        shortDescription:   data.shortDescription ?? prev?.shortDescription,
        clearMemoryMessage: data.clearMemoryMessage?.trim() || prev?.clearMemoryMessage || DEFAULT_CLEAR_MESSAGE,
        prompt:             data.prompt,
    };
    const file = path.join(MODES_DIR, `${key}.md`);
    const content = serializeModeFile(merged);
    archive('modes', key, file, content);
    atomicWrite(file, content);
    refresh(true);
}

/** 覆寫共用規則（_general / _voice） */
function saveShared(key, text) {
    if (!SHARED_FILES[key]) throw new Error(`未知的共用規則：${key}`);
    const content = `${text.trim()}\n`;
    archive('shared', key, SHARED_FILES[key], content);
    atomicWrite(SHARED_FILES[key], content);
    refresh(true);
}

/** 刪除模式檔（給管理面板用；刪除前留一份到版本紀錄，可以還原）；檔案不存在時回傳 false */
function deleteMode(key) {
    if (!MODE_KEY_RE.test(key)) throw new Error(`模式代號只能使用英數、底線、連字號（1~32 字）：${key}`);
    const file = path.join(MODES_DIR, `${key}.md`);
    if (!fs.existsSync(file)) return false;
    archive('modes', key, file, null);
    fs.unlinkSync(file);
    refresh(true);
    return true;
}

// ── 啟動時載入 ───────────────────────────────────────────
refresh(true);
if (modes.size === 0) {
    logger.warn('PromptStore', `找不到任何模式檔，請將 prompt 放到 ${MODES_DIR}`);
} else {
    logger.debug('PromptStore', `已載入 ${modes.size} 個模式：${[...modes.keys()].join(', ')}`);
}

module.exports = {
    PROMPTS_DIR,
    SHARED_KEYS: Object.keys(SHARED_FILES),
    MODE_KEY_RE,
    listModes,
    getMode,
    getShared,
    saveMode,
    saveShared,
    deleteMode,
    listHistory,
    getHistoryVersion,
    listDeletedModes,
};
