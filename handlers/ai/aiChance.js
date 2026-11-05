const crypto = require('crypto');
const logger = require('../../utils/logger');
const { readJson, writeJsonAtomic } = require('../../utils/jsonStore');
const { dataPath } = require('../../utils/dataDir');

// ════════════════════════════════════════════════════════
//  路徑設定
// ════════════════════════════════════════════════════════
// 資料目錄可用 MOUSEBOT_DATA_DIR 覆寫（測試不讀寫正式的 data/）
const CHANCE_PATH   = dataPath('replyChance.json');
const DISABLED_PATH = dataPath('replyChanceDisabled.json');

// ════════════════════════════════════════════════════════
//  預設值與記憶體快取
// ════════════════════════════════════════════════════════
const DEFAULT_CHANCE = 0.15;
const MIN_CHANCE     = 0;
const MAX_CHANCE     = 1;

/** @type {Map<string, number>}  guildId   → chance (0~1) */
let chanceMap = new Map();

/** @type {Set<string>}  channelId → 已停用隨機回覆的頻道 */
let disabledChannels = new Set();

// ════════════════════════════════════════════════════════
//  載入
// ════════════════════════════════════════════════════════
function loadReplyChance() {
    const data = readJson(CHANCE_PATH, {});
    chanceMap  = new Map(Object.entries(data && typeof data === 'object' ? data : {}));
    logger.debug('ReplyChance', `已載入 ${chanceMap.size} 筆伺服器設定`);
}

function loadDisabledChannels() {
    const data = readJson(DISABLED_PATH, []);
    disabledChannels = new Set(Array.isArray(data) ? data : []);
    logger.debug('ReplyChance', `已載入 ${disabledChannels.size} 個停用頻道`);
}

// ════════════════════════════════════════════════════════
//  儲存
// ════════════════════════════════════════════════════════
function saveReplyChance() {
    try {
        writeJsonAtomic(CHANCE_PATH, Object.fromEntries(chanceMap));
        logger.debug('ReplyChance', '已儲存伺服器機率設定');
    } catch (err) {
        logger.error('ReplyChance', `儲存失敗：${err.message}`);
    }
}

function saveDisabledChannels() {
    try {
        writeJsonAtomic(DISABLED_PATH, [...disabledChannels]);
        logger.debug('ReplyChance', '已儲存頻道停用設定');
    } catch (err) {
        logger.error('ReplyChance', `頻道停用設定儲存失敗：${err.message}`);
    }
}

// ════════════════════════════════════════════════════════
//  公開 API — 伺服器機率
// ════════════════════════════════════════════════════════

/**
 * 取得指定伺服器的隨機回覆機率
 * @param {string|null} guildId
 * @returns {number} 0 ~ 1
 */
function getReplyChance(guildId) {
    if (!guildId) return DEFAULT_CHANCE;
    return chanceMap.has(guildId) ? chanceMap.get(guildId) : DEFAULT_CHANCE;
}

// ════════════════════════════════════════════════════════
//  隨機回覆擲骰（和同群其他 bot 協調）
// ════════════════════════════════════════════════════════
// 同一個群有多隻 bot 時，各自擲骰可能同一句話好幾隻都回。
// 改用 messageId 算骰子值 r：每隻 bot 看到的是同一則訊息、同一個 r。
// AI_RANDOM_SLOT=i/n（第 i 隻、共 n 隻，i 從 0 起算）表示這隻佔用從 i/n 開始、長度為機率 p 的區段（超過 1 就繞回 0）。
//   - 只有一隻：不論區段在哪，命中率都剛好是 p，和原本一樣
//   - n 隻：每隻的 p ≤ 1/n 就保證不會同時回；超過時只有超出的部分會重疊
// 預設 MouseBot 0/2、lite 1/2；第三隻以上（例如再開一個 lite 人格）要明確設定，例如 0/3、1/3、2/3。
const DEFAULT_SLOT = '0/2';

/** 解析 i/n，回傳區段起點 [0, 1)；格式不對時用預設值 */
function parseSlot(value) {
    const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(value || '');
    if (m) {
        const i = Number(m[1]), n = Number(m[2]);
        if (n >= 1 && i < n) return i / n;
    }
    return null;
}

function getSlotOffset() {
    const env = process.env.AI_RANDOM_SLOT;
    const offset = parseSlot(env);
    if (offset === null && env?.trim()) logger.warn('AI', `AI_RANDOM_SLOT 格式應為 i/n（例如 1/2），收到 "${env}"，改用預設 ${DEFAULT_SLOT}`);
    return offset ?? parseSlot(DEFAULT_SLOT);
}

/** messageId → [0, 1) 的固定值（沒有 messageId 時退回 Math.random） */
function messageRoll(messageId) {
    if (!messageId) return Math.random();
    return crypto.createHash('sha256').update(String(messageId)).digest().readUInt32BE(0) / 0x100000000;
}

/**
 * 這則訊息要不要隨機回覆
 * @param {string} messageId
 * @param {number} chance 0 ~ 1
 * @param {number} [offset] 區段起點 [0, 1)，預設讀 AI_RANDOM_SLOT
 */
function shouldRandomReply(messageId, chance, offset = getSlotOffset()) {
    if (chance <= 0) return false;
    if (chance >= 1) return true;
    const shifted = (messageRoll(messageId) - offset + 1) % 1;
    return shifted < chance;
}

/**
 * 設定指定伺服器的隨機回覆機率並持久化
 * @param {string} guildId
 * @param {number} chance  0 ~ 1
 * @returns {{ success: boolean, chance: number, error?: string }}
 */
function setReplyChance(guildId, chance) {
    if (typeof chance !== 'number' || isNaN(chance))
        return { success: false, error: '機率必須是數字' };
    if (chance < MIN_CHANCE || chance > MAX_CHANCE)
        return { success: false, error: `機率必須介於 ${MIN_CHANCE} ~ ${MAX_CHANCE} 之間` };

    chanceMap.set(guildId, chance);
    saveReplyChance();
    return { success: true, chance };
}

/**
 * 重置指定伺服器為預設機率並持久化
 * @param {string} guildId
 * @returns {number} DEFAULT_CHANCE
 */
function resetReplyChance(guildId) {
    chanceMap.delete(guildId);
    saveReplyChance();
    return DEFAULT_CHANCE;
}

// ════════════════════════════════════════════════════════
//  公開 API — 頻道開關
// ════════════════════════════════════════════════════════

/**
 * 查詢指定頻道是否停用隨機回覆
 * @param {string} channelId
 * @returns {boolean}
 */
function isChannelDisabled(channelId) {
    return disabledChannels.has(channelId);
}

/**
 * 切換指定頻道的隨機回覆開關
 * @param {string} channelId
 * @returns {{ disabled: boolean }} disabled=true 代表目前為關閉狀態
 */
function toggleChannel(channelId) {
    if (disabledChannels.has(channelId)) {
        disabledChannels.delete(channelId);
        saveDisabledChannels();
        return { disabled: false };
    } else {
        disabledChannels.add(channelId);
        saveDisabledChannels();
        return { disabled: true };
    }
}

/**
 * 直接指定頻道開關（toggleChannel 的明確版本，管理面板用）
 * @param {string} channelId
 * @param {boolean} disabled
 * @returns {{ disabled: boolean }}
 */
function setChannelDisabled(channelId, disabled) {
    if (disabledChannels.has(channelId) === disabled) return { disabled };
    if (disabled) disabledChannels.add(channelId);
    else disabledChannels.delete(channelId);
    saveDisabledChannels();
    return { disabled };
}

// ════════════════════════════════════════════════════════
//  公開 API — 列表（管理面板用）
// ════════════════════════════════════════════════════════

/** 有自訂機率的伺服器 { guildId: chance }；不在其中的伺服器使用 DEFAULT_CHANCE */
function listReplyChances() {
    return Object.fromEntries(chanceMap);
}

/** 已停用隨機回覆的頻道 ID */
function listDisabledChannels() {
    return [...disabledChannels];
}

// 啟動時立即載入
loadReplyChance();
loadDisabledChannels();

module.exports = {
    DEFAULT_CHANCE,
    getReplyChance,
    shouldRandomReply,
    messageRoll,
    parseSlot,
    setReplyChance,
    resetReplyChance,
    isChannelDisabled,
    toggleChannel,
    setChannelDisabled,
    listReplyChances,
    listDisabledChannels,
};