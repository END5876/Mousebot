const fs   = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

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
//  工具：確保目錄存在
// ════════════════════════════════════════════════════════
function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ════════════════════════════════════════════════════════
//  載入
// ════════════════════════════════════════════════════════
function loadReplyChance() {
    try {
        if (fs.existsSync(CHANCE_PATH)) {
            const data = JSON.parse(fs.readFileSync(CHANCE_PATH, 'utf-8'));
            chanceMap  = new Map(Object.entries(data));
            logger.debug('ReplyChance', `已載入 ${chanceMap.size} 筆伺服器設定`);
        } else {
            logger.debug('ReplyChance', '找不到設定檔，使用預設值');
        }
    } catch (err) {
        logger.warn('ReplyChance', `載入失敗，使用預設值：${err.message}`);
    }
}

function loadDisabledChannels() {
    try {
        if (fs.existsSync(DISABLED_PATH)) {
            const data = JSON.parse(fs.readFileSync(DISABLED_PATH, 'utf-8'));
            disabledChannels = new Set(Array.isArray(data) ? data : []);
            logger.debug('ReplyChance', `已載入 ${disabledChannels.size} 個停用頻道`);
        } else {
            logger.debug('ReplyChance', '找不到頻道停用設定檔，預設全部啟用');
        }
    } catch (err) {
        logger.warn('ReplyChance', `頻道停用設定載入失敗：${err.message}`);
    }
}

// ════════════════════════════════════════════════════════
//  儲存
// ════════════════════════════════════════════════════════
function saveReplyChance() {
    try {
        ensureDir(CHANCE_PATH);
        fs.writeFileSync(CHANCE_PATH, JSON.stringify(Object.fromEntries(chanceMap), null, 2), 'utf-8');
        console.log('[ReplyChance] 已儲存伺服器機率設定');
    } catch (err) {
        console.error('[ReplyChance] 儲存失敗：', err.message);
    }
}

function saveDisabledChannels() {
    try {
        ensureDir(DISABLED_PATH);
        fs.writeFileSync(DISABLED_PATH, JSON.stringify([...disabledChannels], null, 2), 'utf-8');
        console.log('[ReplyChance] 已儲存頻道停用設定');
    } catch (err) {
        console.error('[ReplyChance] 頻道停用設定儲存失敗：', err.message);
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
};