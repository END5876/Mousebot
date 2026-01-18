const { customResponses } = require('../config/settings');

function setupCustomResponses(client) {
    client.on('messageCreate', async message => {
        if (message.author.bot) return;

        const content = message.content;

        // 檢查完全匹配的訊息
        if (customResponses.exact[content]) {
            const response = customResponses.exact[content];
            
            // 如果回應是陣列，依序發送
            if (Array.isArray(response)) {
                for (const msg of response) {
                    await message.channel.send(msg);
                }
            } else {
                message.channel.send(response);
            }
            
            console.log(`🎯 觸發完全匹配回應: "${content}"`);
            return;
        }

        // 檢查包含特定文字的訊息
        for (const [keyword, response] of Object.entries(customResponses.contains)) {
            if (content.includes(keyword)) {
                message.channel.send(response);
                console.log(`🎯 觸發包含匹配回應: "${keyword}"`);
                return;
            }
        }
    });
}

module.exports = { setupCustomResponses };