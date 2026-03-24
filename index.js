require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { customResponses } = require('./config/settings');

// 導入所有處理器
const { setupVoiceCommands } = require('./handlers/voiceHandler');
const { setupBasicCommands } = require('./handlers/commandHandler');
const { setupCustomResponses } = require('./handlers/responseHandler');
const { setupAICommands } = require('./handlers/ai/aiHandler');
const { setupGuguGenerator } = require('./handlers/ai/gugugagaGenerator');
const { setupBilibiliCommands } = require('./handlers/bilibiliHandler');
const { setupAutoJoinCommands } = require('./handlers/autoJoinHandler');
const { setupTTSCommands } = require('./handlers/ttsHandler');

// 創建客戶端
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
    ]
});

// Bot 啟動
client.once('clientReady', () => {
    console.log(`✅ Bot 已登入為 ${client.user.tag}`);
    console.log(`📊 已加入 ${client.guilds.cache.size} 個伺服器`);
    console.log(`🎯 已載入 ${Object.keys(customResponses.exact).length} 個完全匹配回應`);
    console.log(`🔍 已載入 ${Object.keys(customResponses.contains).length} 個包含匹配回應`);
    console.log(`🤖 AI 功能已啟用 (Gemini API)`);
    
    // 設定 Bot 狀態
    client.user.setPresence({
        activities: [{ name: '逼逼 機油好難喝', type: 2 }],
        status: 'online'
    });
});

// 註冊所有指令處理器
setupVoiceCommands(client);
setupBasicCommands(client);
setupCustomResponses(client);
setupAICommands(client);
setupGuguGenerator(client);
setupBilibiliCommands(client);
setupAutoJoinCommands(client);
setupTTSCommands(client);

// 錯誤處理
client.on('error', error => {
    console.error('❌ Discord 客戶端錯誤：', error);
});

process.on('unhandledRejection', error => {
    console.error('❌ 未處理的 Promise 拒絕：', error);
});

// 捕捉未處理的同步例外，防止 Bot 崩潰
process.on('uncaughtException', error => {
    console.error('❌ 未捕捉的例外：', error);
    // 不呼叫 process.exit()，讓 Bot 繼續運行
});

// 登入
client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.error('❌ 登入失敗：', error);
    process.exit(1);
});