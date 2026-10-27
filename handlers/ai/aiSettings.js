module.exports = {
    GENERATION_CONFIG: {
        maxOutputTokens: 1000,
        // Gemini 3 官方建議維持預設 1.0，調低可能出現重複迴圈或品質下降
        temperature: 1.0,
    },
    LOVER_MODE_USER_IDS: process.env.LOVER_MODE_USER_IDS
        ? process.env.LOVER_MODE_USER_IDS.split(',').map(id => id.trim())
        : [],

    DEVELOPER_MODE_USER_IDS: process.env.DEVELOPER_MODE_USER_IDS
        ? process.env.DEVELOPER_MODE_USER_IDS.split(',').map(id => id.trim())
        : [],
};