module.exports = {
    GENERATION_CONFIG: {
        maxOutputTokens: 1000,
        temperature: 0.93,
        topP: 0.98,
        topK: 80,
    },
    LOVER_MODE_USER_IDS: process.env.LOVER_MODE_USER_IDS
        ? process.env.LOVER_MODE_USER_IDS.split(',').map(id => id.trim())
        : [],

    DEVELOPER_MODE_USER_IDS: process.env.DEVELOPER_MODE_USER_IDS
        ? process.env.DEVELOPER_MODE_USER_IDS.split(',').map(id => id.trim())
        : [],
};