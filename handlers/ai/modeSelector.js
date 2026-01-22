const { LOVER_MODE_USER_ID } = require('../../config/aiSettings');

/**
 * 根據用戶 ID 和訊息內容選擇適當的模式
 * @param {string} userId - 用戶 Discord ID
 * @param {string} message - 用戶訊息內容
 * @returns {string} - 模式名稱 ('loss' | 'mambaMentor' | 'mygo' | 'inmu' | 'lover')
 */
function selectMode(userId, message) {
    // 特定用戶永遠使用戀人模式
    if (userId === LOVER_MODE_USER_ID) {
        return 'lover';
    }

    // 其他用戶從四種模式中隨機選擇
    const modes = ['loss', 'mambaMentor', 'mygo', 'inmu'];
    const randomIndex = Math.floor(Math.random() * modes.length);
    return modes[randomIndex];
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
        lover: '戀人模式'
    };
    return names[mode] || '未知模式';
}

module.exports = { selectMode, getModeName };