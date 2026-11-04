// handlers/ai/aiScope.js
// AI 的「範圍」設定：決定某個伺服器／頻道用多人格（Mode A，預設）還是單一人格（Mode B）。
// 存在 data/aiScope.json，結構照 aiChance.js：設定很少變動，修改時用 writeJsonAtomic 整份寫回。
//
//   getScope(guildId, channelId, parentId) → { kind, persona, scopeKey, epoch, changedAt, source }
//
// 解析順序：頻道 > 父頻道（討論串才有）> 伺服器 > 預設 multi；沒有 guildId（DM）一律 multi。
//   - 沒有 kind 的設定（tombstone）：kind 往下一層繼承。
//     reset 時不整筆刪除，而是留下沒有 kind 的 tombstone（保留 epoch/changedAt），
//     否則退回伺服器設定後拿到較舊的 changedAt，single 期間的訊息會流回 Mode A 的歷史。
//   - 討論串沒有自己的設定時跟著父頻道，scopeKey 也和父頻道相同（共用同一段群組對話）。
//   - epoch 用全域遞增的序號：每次 kind/persona 真的改變就取下一號。
//     有效的 epoch/changedAt 取「決定 kind 的那一層」以及比它更細的各層（tombstone）的最大值，
//     所以任何會影響這個頻道的切換都會讓 epoch 變大，而無關的上層切換不影響。
//
// 注意：不要 require aiUtils（會連帶載入 ttsHandler 與 sharp）。
// 第一次用到時才讀檔（lazy），require 本模組不會碰到任何檔案。

const logger = require('../../utils/logger');
const { readJson, writeJsonAtomic } = require('../../utils/jsonStore');
const { dataPath } = require('../../utils/dataDir');
const { DEFAULT_MODE } = require('./aiSettings');

const FILE_NAME = 'aiScope.json';
const KINDS = ['multi', 'single'];

// 人格查詢：預設用 promptStore（延遲 require，測試可以換成假的）
let lookupMode = key => require('./promptStore').getMode(key);

let state = null;   // { version, seq, guilds: {}, channels: {} }
let filePath = null;

// ── 載入 / 儲存 ─────────────────────────────────────────

function cleanEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const e = {};
    if (KINDS.includes(raw.kind)) e.kind = raw.kind;
    if (e.kind === 'single' && typeof raw.persona === 'string' && raw.persona) e.persona = raw.persona;
    if (e.kind === 'single' && !e.persona) delete e.kind;   // 壞資料：single 卻沒有人格，當作繼承
    e.epoch = Number.isFinite(raw.epoch) && raw.epoch > 0 ? raw.epoch : 0;
    e.changedAt = Number.isFinite(raw.changedAt) && raw.changedAt > 0 ? raw.changedAt : 0;
    if (raw.changedBy) e.changedBy = String(raw.changedBy);
    if (raw.guildId) e.guildId = String(raw.guildId);
    return e;
}

function load() {
    if (state) return state;
    filePath = dataPath(FILE_NAME);
    const raw = readJson(filePath, {});
    const guilds = {};
    const channels = {};
    let maxEpoch = 0;
    for (const [src, dst] of [[raw?.guilds, guilds], [raw?.channels, channels]]) {
        if (!src || typeof src !== 'object') continue;
        for (const [id, v] of Object.entries(src)) {
            const e = cleanEntry(v);
            if (!e) continue;
            dst[id] = e;
            maxEpoch = Math.max(maxEpoch, e.epoch);
        }
    }
    const seq = Number.isFinite(raw?.seq) ? Math.max(raw.seq, maxEpoch) : maxEpoch;
    state = { version: 1, seq, guilds, channels };
    return state;
}

function save() {
    try {
        writeJsonAtomic(filePath, state);
    } catch (err) {
        logger.error('AiScope', `儲存 ${FILE_NAME} 失敗：${err.message}`);
    }
}

// ── 解析 ────────────────────────────────────────────────

const DM_SCOPE = Object.freeze({
    kind: 'multi', persona: null, scopeKey: null, epoch: 0, changedAt: 0, source: 'dm',
});

// 已警告過的不存在人格：每個代號只警告一次，避免每則訊息都寫一行 log；人格檔恢復後清掉，之後再被刪會重新警告
const warnedMissing = new Set();

/** 人格檔還在就用它，否則（管理面板刪掉了）退回預設人格 */
function resolvePersona(key) {
    if (key && lookupMode(key)) {
        warnedMissing.delete(key);
        return key;
    }
    if (key && !warnedMissing.has(key)) {
        warnedMissing.add(key);
        logger.warn('AiScope', `範圍指定的人格 ${key} 不存在，改用 ${DEFAULT_MODE}（之後不再重複提示）`);
    }
    return DEFAULT_MODE;
}

/**
 * 解析某個位置的 AI 範圍
 * @param {string|null} guildId
 * @param {string|null} channelId
 * @param {string|null} [parentId] 討論串的父頻道（一般頻道不要傳 category id）
 */
function getScope(guildId, channelId = null, parentId = null) {
    if (!guildId) return DM_SCOPE;
    const s = load();

    // 由細到粗：頻道 → 父頻道 → 伺服器
    const levels = [];
    if (channelId && s.channels[channelId]) levels.push({ src: 'channel', id: channelId, e: s.channels[channelId] });
    if (parentId && parentId !== channelId && s.channels[parentId]) levels.push({ src: 'parent', id: parentId, e: s.channels[parentId] });
    if (s.guilds[guildId]) levels.push({ src: 'guild', id: guildId, e: s.guilds[guildId] });

    let epoch = 0;
    let changedAt = 0;
    let decided = null;
    for (const lv of levels) {
        epoch = Math.max(epoch, lv.e.epoch);
        changedAt = Math.max(changedAt, lv.e.changedAt);
        if (lv.e.kind) { decided = lv; break; }
    }

    if (!decided || decided.e.kind === 'multi') {
        return Object.freeze({
            kind: 'multi', persona: null, scopeKey: null, epoch, changedAt,
            source: decided ? decided.src : 'default',
        });
    }
    return Object.freeze({
        kind: 'single',
        persona: resolvePersona(decided.e.persona),
        scopeKey: decided.src === 'guild' ? `g:${guildId}` : `c:${decided.id}`,
        epoch, changedAt, source: decided.src,
    });
}

/**
 * 從 discord.js 的頻道物件解析（討論串會帶入父頻道）
 * @param {object|null} channel
 * @param {string|null} [guildId] channel 為 null 時用這個
 */
function getScopeForChannel(channel, guildId = null) {
    if (!channel) return getScope(guildId, null);
    const isThread = typeof channel.isThread === 'function' ? channel.isThread() : false;
    return getScope(channel.guildId ?? guildId, channel.id, isThread ? channel.parentId : null);
}

// ── 修改 ────────────────────────────────────────────────

/**
 * 非擁有者只能選 front matter 的 singleScope 不是 off 的人格
 * @returns {boolean}
 */
function isPersonaAllowedInSingle(key, byOwner = false) {
    const mode = key ? lookupMode(key) : null;
    if (!mode) return false;
    if (byOwner) return true;
    return mode.singleScope !== 'off';
}

function validateCfg(cfg) {
    if (cfg === null) return { ok: true };
    if (!cfg || typeof cfg !== 'object') return { ok: false, error: '設定格式不正確' };
    if (cfg.kind !== undefined && !KINDS.includes(cfg.kind)) return { ok: false, error: 'kind 只能是 multi 或 single' };
    if (cfg.kind === undefined) return { ok: false, error: '沒有要修改的設定' };
    if (cfg.kind === 'single') {
        if (!cfg.persona) return { ok: false, error: '單一人格模式必須指定人格' };
        if (!lookupMode(cfg.persona)) return { ok: false, error: `找不到「${cfg.persona}」這個人格` };
    }
    return { ok: true };
}

/**
 * 套用設定到某一筆（伺服器或頻道）
 * cfg：{ kind, persona? }；null＝重置（留下 tombstone）
 */
function applyTo(map, id, cfg, byUserId, extra = {}) {
    const v = validateCfg(cfg);
    if (!v.ok) return v;

    const s = state;
    const prev = map[id] ?? null;
    const next = prev ? { ...prev } : { epoch: 0, changedAt: 0 };
    Object.assign(next, extra);
    let kindChanged = false;

    if (cfg === null) {
        if (!prev) return { ok: true, changed: false };
        kindChanged = !!prev.kind;
        delete next.kind;
        delete next.persona;
    } else {
        const persona = cfg.kind === 'single' ? cfg.persona : undefined;
        kindChanged = prev?.kind !== cfg.kind || prev?.persona !== persona;
        next.kind = cfg.kind;
        if (persona) next.persona = persona;
        else delete next.persona;
    }

    if (kindChanged) {
        s.seq += 1;
        next.epoch = s.seq;
        next.changedAt = Date.now();
        // 同一毫秒內連續切換時，changedAt 仍要嚴格遞增（歷史截止點靠它）
        if (prev && next.changedAt <= prev.changedAt) next.changedAt = prev.changedAt + 1;
    }
    if (byUserId) next.changedBy = String(byUserId);

    map[id] = next;
    save();
    // 有沒有實際改到東西：比對前後的 kind / persona
    const changed = prev?.kind !== next.kind || prev?.persona !== next.persona;
    return { ok: true, changed };
}

/**
 * 設定或重置伺服器的範圍
 * @param {string} guildId
 * @param {{kind:'multi'|'single', persona?:string}|null} cfg
 * @param {string} [byUserId]
 */
function setGuildScope(guildId, cfg, byUserId) {
    if (!guildId) return { ok: false, error: '缺少伺服器' };
    load();
    const res = applyTo(state.guilds, guildId, cfg, byUserId);
    if (res.ok) logger.info('AiScope', `伺服器 ${guildId} 的範圍${cfg === null ? '已重置' : `設為 ${JSON.stringify(cfg)}`}`);
    return res.ok ? { ...res, scope: getScope(guildId, null) } : res;
}

/**
 * 設定或重置頻道（含討論串）的範圍覆寫
 * @param {string} channelId
 * @param {string} guildId
 * @param {{kind:'multi'|'single', persona?:string}|null} cfg
 * @param {string} [byUserId]
 */
function setChannelScope(channelId, guildId, cfg, byUserId) {
    if (!channelId || !guildId) return { ok: false, error: '缺少頻道或伺服器' };
    load();
    const res = applyTo(state.channels, channelId, cfg, byUserId, { guildId: String(guildId) });
    if (res.ok) logger.info('AiScope', `頻道 ${channelId} 的範圍${cfg === null ? '已重置' : `設為 ${JSON.stringify(cfg)}`}`);
    return res.ok ? { ...res, scope: getScope(guildId, channelId) } : res;
}

/** 目前所有設定（含 tombstone），給管理面板與 /ai scope show 用 */
function listScopes() {
    const s = load();
    const copy = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, { ...v }]));
    return { guilds: copy(s.guilds), channels: copy(s.channels) };
}

/** 單一筆設定（沒有則 null） */
function getGuildEntry(guildId) {
    const e = load().guilds[guildId];
    return e ? { ...e } : null;
}

function getChannelEntry(channelId) {
    const e = load().channels[channelId];
    return e ? { ...e } : null;
}

/** 被範圍指定為單一人格的人格代號（管理面板：計入使用人數、刪除前檢查） */
function listScopePersonas() {
    const s = load();
    return [...Object.values(s.guilds), ...Object.values(s.channels)]
        .filter(e => e.kind === 'single' && e.persona)
        .map(e => e.persona);
}

/** 測試用：丟掉記憶體內的狀態（下次重新讀檔），可換掉人格查詢函式 */
function _reset({ modeLookup } = {}) {
    state = null;
    filePath = null;
    if (modeLookup) lookupMode = modeLookup;
}

module.exports = {
    KINDS,
    getScope,
    getScopeForChannel,
    setGuildScope,
    setChannelScope,
    listScopes,
    getGuildEntry,
    getChannelEntry,
    listScopePersonas,
    isPersonaAllowedInSingle,
    _reset,
};
