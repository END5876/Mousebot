const { LOVER_MODE_USER_IDS, DEVELOPER_MODE_USER_IDS } = require('../../config/aiSettings')

/**
 * 根據用戶 ID 和訊息內容選擇適當的模式
 * @param {string} userId - 用戶 Discord ID
 * @param {string} message - 用戶訊息內容
 * @returns {string} - 模式名稱 ('loss' | 'mambaMentor' | 'mygo' | 'inmu' | 'lover')
 */
function selectMode(userId, content) {
    if (LOVER_MODE_USER_IDS.includes(userId)) return 'lover';
    if (DEVELOPER_MODE_USER_IDS.includes(userId)) return 'developer';

    // 其他用戶使用加權隨機
    const rand = Math.random(); // 0.0000 ~ 0.9999
    
    if (rand < 0.05) {
        return 'inmu';         // 5% 淫夢模式
    } else if (rand < 0.10) {
        return 'mambaMentor';  // 5% 牢大模式
    } else {
        return 'loss';         // 90% 損友模式（預設）
    }
}
/**
 * 獲取模式的顯示名稱（用於日誌）
 */
function getModeName(mode) {
    const names = {
        loss: '損友模式',
        mambaMentor: '牢大模式',
        mygo: 'MyGO模式',
        inmu: '淫夢模式',
        lover: '戀人模式',
        developer: '開發者模式'
    };
    return names[mode] || '未知模式';
}

module.exports = { selectMode, getModeName };
