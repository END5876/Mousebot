const path = require('path');
const logger = require('../../utils/logger');
const { readJson, writeJsonAtomic } = require('../../utils/jsonStore');

// ════════════════════════════════════════════════════════
//  路徑設定
// ════════════════════════════════════════════════════════
const CHANCE_PATH   = path.resolve(__dirname, '../../data/replyChance.json');
const DISABLED_PATH = path.resolve(__dirname, '../../data/replyChanceDisabled.json');

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
    setReplyChance,
    resetReplyChance,
    isChannelDisabled,
    toggleChannel,
    setChannelDisabled,
    listReplyChances,
    listDisabledChannels,
};