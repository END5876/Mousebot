const { LOVER_MODE_USER_IDS, DEVELOPER_MODE_USER_IDS } = require('../../config/aiSettings')

/**
 * 根據用戶 ID 選擇適當的基礎模式
 * @param {string} userId - 用戶 Discord ID
 * @returns {string} - 模式名稱
 */
function selectMode(userId) {
    if (LOVER_MODE_USER_IDS.includes(userId)) return 'lover';
    if (DEVELOPER_MODE_USER_IDS.includes(userId)) return 'developer';

    return 'loss';   
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
        developer: '開發者模式',
        gugu: '咕咕模式'
    };
    return names[mode] || '未知模式';
}

/**
 * 決定性語境演算法：分析群組氛圍並產出最終模式與強制指令
 * @param {string} triggerUserId - 觸發 AI 的用戶 ID
 * @param {string[]} mentionedUserIds - 訊息中被 @ 的用戶 ID 列表
 * @param {Array<{userId: string, name: string, text: string}>} recentMessages - 近期訊息 Buffer
 * @returns {Object} { finalMode, injectedRule }
 */
function determineGroupStrategy(triggerUserId, mentionedUserIds = [], recentMessages = []) {
    // 階段 1：主導模式判定
    let baseMode = selectMode(triggerUserId);

    // 預先組裝各身份的 Mention 字串（直接從 ID 列表）
    const loverMentions = LOVER_MODE_USER_IDS.map(id => `<@${id}>`).join('、');
    const developerMentions = DEVELOPER_MODE_USER_IDS.map(id => `<@${id}>`).join('、');
    const triggerMention = `<@${triggerUserId}>`;

    // 階段 2：語境成分分析（直接用 ID 比對）
    const recentUserIds = new Set(recentMessages.map(msg => msg.userId));

    const loverActive = LOVER_MODE_USER_IDS.some(id => recentUserIds.has(id));
    const developerActive = DEVELOPER_MODE_USER_IDS.some(id => recentUserIds.has(id));
    const lossActive = [...recentUserIds].some(
        id => !LOVER_MODE_USER_IDS.includes(id) && !DEVELOPER_MODE_USER_IDS.includes(id)
    );

    // 階段 3：衝突解決矩陣
    let injectedRule = "";

    switch (baseMode) {
        case 'loss':
            if (loverActive) {
                injectedRule = `\n【系統強制指令：偏心模式】\n注意！你的戀人（${loverMentions}）正在群組中活躍。你可以對當前發言者（${triggerMention}）極盡嘲諷與毒舌，但如果話題牽涉到戀人，你必須展現出「極度雙標」與「無條件偏坦戀人」的態度。`;
            } else {
                injectedRule = `\n【系統強制指令：群組損友】\n請根據群組上下文，無情吐槽當前發言者（${triggerMention}）。`;
            }
            break;

        case 'lover':
            if (lossActive || developerActive) {
                injectedRule = `\n【系統強制指令：宣示主權】\n你現在是在「公開群組」回應你的戀人（${loverMentions}）。請對戀人保持絕對的溫柔與愛意；但若你需要回應或提及群組內的其他閒雜人等，請切換成「極度敷衍、微冷淡、眼中只有戀人」的態度。`;
            } else {
                injectedRule = `\n【系統強制指令：純愛模式】\n全心全意溫柔回應你的戀人（${loverMentions}）。`;
            }
            break;

        case 'developer':
            injectedRule = `\n【系統強制指令：技術專注】\n忽略群組上下文中的閒聊與玩笑，以最專業、簡潔的態度回答技術問題。（開發者：${developerMentions}）`;
            break;

        default:
            injectedRule = "";
            break;
    }

    return {
        finalMode: baseMode,
        injectedRule: injectedRule
    };
}

module.exports = { selectMode, getModeName, determineGroupStrategy };