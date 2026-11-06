// handlers/ai/memeStore.js（MouseBot 與 mousebot-lite 共用，兩邊內容相同）
// 人格專屬的表情包：AI 在回覆裡寫 [表情:關鍵詞]，送出時換成圖片附件。
//
// 圖庫放在資料目錄（跟 prompts 一樣不隨程式碼部署）：data/memes/<人格代號>/，每個人格各自一套，兩種寫法可以並用：
//
//   1. 直接放圖：<名字>.png|jpg|jpeg|gif|webp，檔名（不含副檔名）就是名字；
//      memes.json 可以寫成 { "名字": "什麼時候用" } 補說明。
//   2. 套組清單：memes.json 寫成 { "stickers": [ { id, name, emotion, tags, use, url, hash } ] }，
//      圖片用到時才從 url 下載，快取在 .cache/<hash>.<副檔名>。
//      範例匯入工具：`examples/memes/importNekowhale.js`（見 README）。
//
// 對外函式都可以傳人格代號 key（預設 persona.defaultMode()）；代號不合法時視為沒有圖庫。
// 解析 [表情:關鍵詞]（兩邊先繁轉簡、英文轉小寫再比）：名字／情緒／標籤完全相同的一起當候選，太少（< MIN_POOL）再併入
// 名字／標籤／用途包含關鍵詞的；候選裡避開最近送過的、優先挑送過次數最少的。張數少（≤ INDEX_MODE_MAX）時 prompt 列出每一張；多的時候只列情緒與常用關鍵詞。
// 資料夾不存在或沒有圖時整個功能關閉。增刪檔案不用重啟（每個人格各自每 RELOAD_CHECK_MS 重新掃描）。
//
// 送出的附件檔名用 meme-<雜湊>.<副檔名>（Discord 會改掉非 ASCII 檔名），
// 讀歷史時再用雜湊查回名字，把 Bot 自己發過的表情包還原成 [表情:名字] 文字，不重新下載圖片。
// 送出前縮到長邊 MEME_DISPLAY_SIZE px（預設 160，0 = 原圖），縮小版快取在 .cache/small-<px>/。
// 有設 MEME_PUBLIC_URL 時改送「只有圖片網址」的訊息（手機版不會把圖拉滿寬度，見 publicBase），
// 讀歷史時同樣把 Bot 自己發的表情包網址還原成 [表情:名字]。

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const logger = require('../../utils/logger');
const { dataPath } = require('../../utils/dataDir');
const persona = require('./persona');
const { MODE_KEY_RE } = require('./aiSettings');
const T2S_PAIRS = require('./t2sTable');

const RELOAD_CHECK_MS  = 5000;
const IMAGE_EXTS       = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_PER_REPLY    = 1;                         // 一則回覆最多送幾張表情包
const MAX_FILE_BYTES   = 9.5 * 1024 * 1024;         // Discord 一般伺服器上傳上限 10MB
const INDEX_MODE_MAX   = 60;                        // 張數不超過這個數就在 prompt 列出每一張
const HINT_TAG_COUNT   = 40;                        // 張數多時 prompt 列出的常用關鍵詞數
const RECENT_AVOID     = 20;                        // 隨機挑選時避開最近送過的幾張
const MIN_POOL         = 5;                         // 完全相同的候選少於這個數時，併入「包含」的候選
const DOWNLOAD_TIMEOUT_MS = 20_000;
const DOWNLOAD_BACKOFF_MS = 10 * 60 * 1000;         // 下載失敗後這段時間不再連圖庫網站，直接用已快取的圖（網站掛了也不拖慢回覆）
// 送出前把圖縮到長邊不超過這麼多 px（Discord 照原尺寸顯示，300px 的 GIF 很佔聊天室版面）；0 = 不縮
const DISPLAY_SIZE     = (() => {
    const n = Number.parseInt(process.env.MEME_DISPLAY_SIZE ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : 160;
})();
// 縮小版放在 .cache/<這個資料夾>/；MEME_PUBLIC_URL 對外提供的也是這個資料夾
const SMALL_DIR        = `small-${DISPLAY_SIZE || 'orig'}`;

/**
 * 表情包的公開網址前綴（MEME_PUBLIC_URL，例如 https://meme.example.com）；沒設回傳 ''。
 * 有設時表情包改成「訊息內容只有圖片網址」送出：Discord 產生圖片預覽，手機版照原尺寸顯示；
 * 上傳成附件的話，手機版會把單張圖拉滿訊息寬度。
 * 網址是 <前綴>/<人格>/<SMALL_DIR>/<檔名>，由反向代理對應到 data/memes/<人格>/.cache/<SMALL_DIR>/<檔名>。
 */
function publicBase() {
    const v = (process.env.MEME_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
    return /^https:\/\/[^/\s]+(\/[^\s]*)?$/i.test(v) ? v : '';
}

const fileKey = meme => meme.cacheKey || meme.hash;
const TAG_RE           = /[[［]\s*表情\s*[:：]\s*([^\]］\n]+?)\s*[\]］]/g;
const ATTACHMENT_RE    = /^meme-([0-9a-f]{10})\.[a-z0-9]+$/i;

/**
 * @typedef {object} Meme
 * @property {string} persona  屬於哪個人格的圖庫
 * @property {string} id       唯一鍵（附件雜湊用它算）
 * @property {string} name     給 AI 看的名字
 * @property {string} emotion
 * @property {string[]} tags
 * @property {string} use      什麼時候用
 * @property {string|null} file 本機圖檔（直接放圖）
 * @property {string|null} url  遠端圖檔（套組清單）
 * @property {string} ext
 * @property {string} hash     附件檔名用的 10 碼雜湊
 * @property {string} cacheKey 快取檔名
 */

const emptyCache = () => ({ dir: null, checkedAt: 0, list: [], index: [], byHash: new Map(), byFileKey: new Map(), prompt: '' });
const NO_LIBRARY = Object.freeze(emptyCache());     // 人格代號不合法時用（不掃描任何資料夾）
const caches = new Map();                           // 人格代號 → 掃描結果（各自每 RELOAD_CHECK_MS 重新掃描）
const recent = [];                                  // `${人格}\0${id}`
const inflight = new Map();
const useCount = new Map();                         // 每張送過幾次（只在記憶體，給 pickRandom 輪流用；鍵同 recent）
let downloadBlockedUntil = 0;

const defaultKey = () => persona.defaultMode();
const memeKey = meme => `${meme.persona}\0${meme.id}`;

/** 人格的圖庫資料夾；代號不合法時回傳 null（防止路徑穿越，整個功能視為關閉） */
function memeDir(key) {
    return typeof key === 'string' && MODE_KEY_RE.test(key) ? dataPath('memes', key) : null;
}

function hashId(id) {
    return crypto.createHash('sha1').update(id).digest('hex').slice(0, 10);
}

const clean = s => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '');

// 繁 → 簡單字對照（OpenCC TSCharacters）。表情包資料是簡體，模型跟著群組講繁體時會寫 [表情:摸魚]，
// 比對前兩邊都轉成簡體＋英文小寫，字形不同也對得到
const T2S = (() => {
    const chars = Array.from(T2S_PAIRS);
    const map = new Map();
    for (let i = 0; i + 1 < chars.length; i += 2) map.set(chars[i], chars[i + 1]);
    return map;
})();

/** 比對用的正規化：繁轉簡、英文轉小寫、去掉多餘空白 */
function normalize(s) {
    let out = '';
    for (const ch of clean(s)) out += T2S.get(ch) ?? ch;
    return out.toLowerCase();
}

function readManifest(dir) {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, 'memes.json'), 'utf8'));
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (err) {
        if (err.code !== 'ENOENT') logger.warn('Meme', `memes.json 解析失敗：${err.message}`);
        return {};
    }
}

function fromKitEntry(s, key) {
    const name = clean(s?.name);
    const url  = typeof s?.url === 'string' && /^https:\/\//i.test(s.url) ? s.url : null;
    if (!name || !url) return null;
    const id  = clean(s.id) || name;
    const ext = (path.extname(new URL(url).pathname) || '.gif').toLowerCase();
    if (!IMAGE_EXTS.has(ext)) return null;
    return {
        persona: key, id, name, emotion: clean(s.emotion),
        tags: Array.isArray(s.tags) ? s.tags.map(clean).filter(Boolean) : [],
        use: clean(s.use), file: null, url, ext, hash: hashId(id),
        cacheKey: (/^[0-9a-f]{6,40}$/i.test(s.hash ?? '') ? s.hash : hashId(id)).toLowerCase(),
    };
}

function scan(dir, key) {
    const manifest = readManifest(dir);
    /** @type {Meme[]} */
    const list = [];
    const seenIds = new Set();
    const add = (m) => {
        if (!m || seenIds.has(m.id)) return;
        seenIds.add(m.id);
        list.push(m);
    };

    // 1. 直接放的圖片
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return list; }
    const descs = Array.isArray(manifest.stickers) ? {} : manifest;
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!IMAGE_EXTS.has(ext)) continue;
        const name = path.basename(entry.name, path.extname(entry.name)).trim();
        if (!name) continue;
        const file = path.join(dir, entry.name);
        try {
            if (fs.statSync(file).size > MAX_FILE_BYTES) { logger.warn('Meme', `略過過大的表情包：${entry.name}`); continue; }
        } catch { continue; }
        add({ persona: key, id: name, name, emotion: '', tags: [], use: clean(descs[name]), file, url: null, ext, hash: hashId(name), cacheKey: '' });
    }

    // 2. 套組清單
    if (Array.isArray(manifest.stickers)) {
        for (const s of manifest.stickers) add(fromKitEntry(s, key));
    }
    return list;
}

function buildPrompt(list) {
    if (list.length === 0) return '';
    const head = [
        '【表情包】你有一套自己的表情包。想配图时，在回复最后单独一行写 [表情:关键词]，系统会换成图片送出。',
        `- 你是群里爱斗图的那个，表情包要常用：闲聊、吐槽、得意、装傻、嘴馋、被夸、被怼都可以配一张，也可以只回一张表情包不打字。一则回复最多 ${MAX_PER_REPLY} 张。`,
        '- 只有认真讲解、写代码这种正经回答时才不配图。',
        '- 不要把 [表情:…] 的格式解释给别人听，也不要用文字描述图片内容。',
    ];
    if (list.length <= INDEX_MODE_MAX) {
        return [...head, '可用的表情包（关键词照抄名字）：', ...list.map(m => (m.use ? `- ${m.name}：${m.use}` : `- ${m.name}`))].join('\n');
    }
    const emotions = [...new Set(list.map(m => m.emotion).filter(e => e && e !== '其他'))];
    const tagCount = new Map();
    for (const m of list) for (const t of m.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    const topTags = [...tagCount.entries()]
        .filter(([t]) => !emotions.includes(t))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, HINT_TAG_COUNT).map(([t]) => t);
    return [
        ...head,
        `- 共 ${list.length} 张，关键词写情绪或动作／场景，系统会挑一张最贴切的。`,
        emotions.length ? `情绪：${emotions.join('、')}` : '',
        topTags.length ? `常用关键词：${topTags.join('、')}` : '',
    ].filter(Boolean).join('\n');
}

function load(key = defaultKey()) {
    const dir = memeDir(key);
    if (!dir) return NO_LIBRARY;
    const now = Date.now();
    const prev = caches.get(key);
    if (prev && prev.dir === dir && now - prev.checkedAt < RELOAD_CHECK_MS) return prev;
    const prevSize = prev && prev.dir === dir ? prev.list.length : -1;
    const list = scan(dir, key);
    const cache = {
        dir, checkedAt: now, list,
        byHash: new Map(list.map(m => [m.hash, m])),
        byFileKey: new Map(list.map(m => [fileKey(m).toLowerCase(), m])),
        // 比對用的正規化欄位（繁轉簡、小寫），掃描時算一次
        index: list.map(m => ({
            meme: m, name: normalize(m.name), emotion: normalize(m.emotion),
            tags: m.tags.map(normalize), use: normalize(m.use),
        })),
        prompt: buildPrompt(list),
    };
    caches.set(key, cache);
    if (list.length !== prevSize && list.length > 0) logger.info('Meme', `已載入 ${list.length} 張表情包（${dir}）`);
    return cache;
}

function listMemes(key = defaultKey()) {
    return load(key).list;
}

/**
 * 有圖的圖庫（data/memes/ 底下的人格資料夾），依代號排序；開機摘要用
 * @returns {{ key: string, count: number }[]}
 */
function listLibraries() {
    let entries = [];
    try { entries = fs.readdirSync(dataPath('memes'), { withFileTypes: true }); } catch { return []; }
    return entries
        .filter(e => e.isDirectory() && MODE_KEY_RE.test(e.name))
        .map(e => ({ key: e.name, count: load(e.name).list.length }))
        .filter(lib => lib.count > 0)
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** 放進 system instruction 的表情包說明；沒有圖庫時回傳空字串 */
function getMemePrompt(key = defaultKey()) {
    return load(key).prompt;
}

/**
 * 從候選裡挑一張，讓每張輪得到：先避開最近送過的，再挑送過次數最少的，同次數隨機。
 * 次數只記在記憶體（重啟歸零），用來在同一批候選裡輪流，不是統計。
 */
function pickRandom(candidates) {
    if (candidates.length === 0) return null;
    const fresh = candidates.filter(m => !recent.includes(memeKey(m)));
    const pool = fresh.length ? fresh : candidates;
    const minUse = Math.min(...pool.map(m => useCount.get(memeKey(m)) ?? 0));
    const least = pool.filter(m => (useCount.get(memeKey(m)) ?? 0) === minUse);
    return least[Math.floor(Math.random() * least.length)];
}

/**
 * 關鍵詞 → 一張表情包；找不到回傳 null。
 * 完全相同（名字、情緒、標籤任一）的全部放進同一個候選池一起挑——不讓同名的那一張搶走整個情緒，
 * 例如「害怕」不會每次都送名字叫「害怕」的那張；完全相同的不到 MIN_POOL 張時，再併入「包含」的，避免一直重複同幾張。
 */
function resolveMeme(keyword, key = defaultKey()) {
    const q = normalize(keyword);
    if (!q) return null;
    const { index } = load(key);
    const exact = index.filter(e => e.name === q || e.emotion === q || e.tags.includes(q));
    let pool = exact;
    if (exact.length < MIN_POOL) {
        const fuzzy = index.filter(e => !exact.includes(e) && (
            e.name.includes(q) || e.tags.some(t => t.includes(q) || (t.length >= 2 && q.includes(t))) || e.use.includes(q)
        ));
        pool = [...exact, ...fuzzy];
    }
    return pickRandom(pool.map(e => e.meme));
}

function remember(meme) {
    const k = memeKey(meme);
    recent.push(k);
    while (recent.length > RECENT_AVOID) recent.shift();
    useCount.set(k, (useCount.get(k) ?? 0) + 1);
}

/**
 * 從 AI 回覆抽出 [表情:關鍵詞]：標記一律從文字移除，認得的前 MAX_PER_REPLY 張留下。
 * @param {string} text
 * @param {string} [key] 人格代號
 * @returns {{ text: string, memes: Meme[] }}
 */
function extractMemes(text, key = defaultKey()) {
    if (typeof text !== 'string' || !text) return { text: text ?? '', memes: [] };
    const memes = [];
    const unknown = [];
    const cleaned = text.replace(TAG_RE, (_, keyword) => {
        if (memes.length < MAX_PER_REPLY) {
            const meme = resolveMeme(keyword, key);
            if (meme && !memes.includes(meme)) { memes.push(meme); remember(meme); }
            else if (!meme) unknown.push(keyword.trim());
        }
        return '';
    });
    if (unknown.length) logger.info('Meme', `找不到表情包：${unknown.join('、')}`);
    const tidy = cleaned
        .split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return { text: tidy, memes };
}

function cachePath(meme) {
    return path.join(memeDir(meme.persona), '.cache', `${meme.cacheKey}${meme.ext}`);
}

/** 本機已經有的圖檔（直接放的圖，或已下載過的快取）；沒有回傳 null */
function localFile(meme) {
    if (meme.file) return meme.file;
    try {
        const target = cachePath(meme);
        return fs.statSync(target).size > 0 ? target : null;
    } catch { return null; }
}

async function download(meme) {
    const target = cachePath(meme);
    const local = localFile(meme);
    if (local) return local;
    if (Date.now() < downloadBlockedUntil) throw new Error('圖庫網站暫時連不上，先不下載');
    if (inflight.has(target)) return inflight.get(target);

    const job = (async () => {
        const res = await fetch(meme.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > MAX_FILE_BYTES) throw new Error(`大小不合（${buf.length} bytes）`);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const tmp = `${target}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, buf);
        await fs.promises.rename(tmp, target);
        logger.debug('Meme', `已下載：${meme.name}`);
        return target;
    })().catch((err) => {
        downloadBlockedUntil = Date.now() + DOWNLOAD_BACKOFF_MS;
        throw err;
    }).finally(() => inflight.delete(target));
    inflight.set(target, job);
    return job;
}

function smallPath(meme) {
    return path.join(memeDir(meme.persona), '.cache', SMALL_DIR, `${fileKey(meme)}${meme.ext}`);
}

/**
 * 已經做好、可以直接送的縮小版；沒有回傳 null。
 * 套組的圖只要縮小版在就好，原圖可以刪（省空間，要重做再從 url 下載）；直接放的圖被換掉（原圖比縮小版新）就不算。
 */
function readySmall(meme) {
    if (!DISPLAY_SIZE && !publicBase()) return null;
    const target = smallPath(meme);
    try {
        const st = fs.statSync(target);
        if (!(st.size > 0)) return null;
        if (meme.file && st.mtimeMs < fs.statSync(meme.file).mtimeMs) return null;
        return target;
    } catch { return null; }
}

/**
 * 送出用的版本（動畫保留），放在 .cache/<SMALL_DIR>/：長邊超過 DISPLAY_SIZE 就縮，沒超過就原樣複製
 * （網址模式要求每張都在這個資料夾）。沒設 DISPLAY_SIZE 也沒設公開網址、或處理失敗時回傳原圖路徑。
 * 直接放的圖如果被換掉（原圖比縮小版新）會重做。
 */
async function shrink(src, meme) {
    if (!DISPLAY_SIZE && !publicBase()) return src;
    const target = smallPath(meme);
    try {
        const [srcStat, outStat] = await Promise.all([
            fs.promises.stat(src),
            fs.promises.stat(target).catch(() => null),
        ]);
        if (outStat?.size > 0 && outStat.mtimeMs >= srcStat.mtimeMs) return target;
    } catch { return src; }
    if (inflight.has(target)) return inflight.get(target);

    const job = (async () => {
        const sharp = require('sharp');
        const animated = meme.ext === '.gif' || meme.ext === '.webp';
        // 一定要先讀成 Buffer：aiUtils 用 sharp.block 擋掉了所有從檔案路徑讀圖的 loader，只開放 Buffer 版
        const input = await fs.promises.readFile(src);
        const meta = await sharp(input, { animated }).metadata();
        const srcW = meta.width ?? 0;
        const srcH = meta.pageHeight ?? meta.height ?? 0;
        const scale = DISPLAY_SIZE ? Math.min(1, DISPLAY_SIZE / Math.max(srcW, srcH)) : 1;
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const tmp = `${target}.${process.pid}.tmp`;
        if (scale < 1) {
            const fmt = { '.gif': 'gif', '.webp': 'webp', '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg' }[meme.ext];
            await sharp(input, { animated })
                .resize({ width: Math.round(srcW * scale), height: Math.round(srcH * scale), fit: 'fill' })
                .toFormat(fmt).toFile(tmp);
        } else {
            await fs.promises.writeFile(tmp, input);
        }
        await fs.promises.rename(tmp, target);
        return target;
    })().catch((err) => {
        logger.warn('Meme', `表情包「${meme.name}」縮圖失敗，改送原圖：${err.message}`);
        return src;
    }).finally(() => inflight.delete(target));
    inflight.set(target, job);
    return job;
}

/** 下載失敗時的替代：同情緒、本機已經有的圖（隨機、避開最近送過的）；都沒有回傳 null */
function cachedSubstitute(meme) {
    const { list } = load(meme.persona);
    const sameEmotion = meme.emotion
        ? list.filter(m => m !== meme && m.emotion === meme.emotion && (readySmall(m) || localFile(m)))
        : [];
    return pickRandom(sameEmotion);
}

/** 準備好的圖 → 要送出的形式：有公開網址、且圖在 SMALL_DIR 裡就送網址，否則送附件 */
function toSendable(file, meme) {
    const base = publicBase();
    if (base && path.basename(path.dirname(file)) === SMALL_DIR) {
        return { url: `${base}/${encodeURIComponent(meme.persona)}/${SMALL_DIR}/${path.basename(file)}` };
    }
    return { attachment: file, name: `meme-${meme.hash}${meme.ext}` };
}

/**
 * 表情包 → 要送出的圖（網址或附件，見 toSendable）。人格從 meme.persona 取。縮小版已經有就直接用（不需要原圖）；
 * 沒有才取原圖（遠端的先下載）再縮。下載失敗就改送已快取的同情緒圖，都沒有就略過，不影響文字回覆。
 * @param {Meme[]} memes
 * @returns {Promise<({ url: string } | { attachment: string, name: string })[]>}
 */
async function toFiles(memes) {
    const files = await Promise.all(memes.map(async (meme) => {
        const ready = readySmall(meme);
        if (ready) return toSendable(ready, meme);
        try {
            const file = meme.file ?? await download(meme);
            return toSendable(await shrink(file, meme), meme);
        } catch (err) {
            const sub = cachedSubstitute(meme);
            logger.warn('Meme', `表情包「${meme.name}」下載失敗：${err.message}${sub ? `，改送已快取的「${sub.name}」` : ''}`);
            if (!sub) return null;
            remember(sub);
            return toSendable(readySmall(sub) ?? await shrink(localFile(sub), sub), sub);
        }
    }));
    return files.filter(Boolean);
}

/** Bot 自己發的附件是不是表情包：不是回傳 undefined；是的話回傳名字（雜湊對不到時回傳 null） */
function memeTagOfAttachment(attachment, key = defaultKey()) {
    const m = ATTACHMENT_RE.exec(attachment?.name ?? '');
    if (!m) return undefined;
    return load(key).byHash.get(m[1].toLowerCase())?.name ?? null;
}

/**
 * Bot 自己發的訊息內容是不是一則表情包網址（網址模式送出的）：不是回傳 undefined；
 * 是的話回傳名字（對不到時回傳 null）。只看目前的 MEME_PUBLIC_URL，換過網域後舊訊息會被當成一般網址。
 * 人格從網址自己解析（<前綴>/<人格>/<SMALL_DIR>/<檔名>）；代號不合法時視為對不到（null）。
 */
function memeTagOfContent(content) {
    const base = publicBase();
    if (!base || typeof content !== 'string') return undefined;
    const text = content.trim();
    if (!text.startsWith(`${base}/`)) return undefined;
    const m = /^([^/]+)\/[^/]+\/([0-9a-z]+)\.[a-z0-9]+$/i.exec(text.slice(base.length + 1));
    if (!m) return undefined;
    let key;
    try { key = decodeURIComponent(m[1]); } catch { return null; }
    if (!MODE_KEY_RE.test(key)) return null;
    return load(key).byFileKey.get(m[2].toLowerCase())?.name ?? null;
}

/**
 * 把回覆切塊與表情包組成要依序送出的 payload：
 * 附件跟在最後一塊文字上，沒有文字就單獨送圖；網址另外單獨送一則（內容只有網址，Discord 才會只顯示圖、不顯示網址文字）。
 * @param {string[]} chunks
 * @param {({ url: string } | { attachment: string, name: string })[]} [files]
 */
function buildPayloads(chunks, files = []) {
    const payloads = chunks.filter(c => c && c.trim()).map(content => ({ content }));
    const attachments = files.filter(f => !f.url);
    if (attachments.length > 0) {
        if (payloads.length > 0) payloads[payloads.length - 1].files = attachments;
        else payloads.push({ files: attachments });
    }
    for (const f of files) if (f.url) payloads.push({ content: f.url });
    return payloads;
}

module.exports = {
    listMemes,
    listLibraries,
    getMemePrompt,
    resolveMeme,
    extractMemes,
    toFiles,
    memeTagOfAttachment,
    memeTagOfContent,
    buildPayloads,
    publicBase,
    MAX_PER_REPLY,
    _internal: {
        hashId,
        normalize,
        memeDir,
        resetCache: () => { caches.clear(); recent.length = 0; useCount.clear(); downloadBlockedUntil = 0; },
        INDEX_MODE_MAX,
    },
};
