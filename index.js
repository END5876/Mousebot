require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, Collection } = require('discord.js');
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
    GatewayIntentBits.GuildMembers,
  ]
});

// ── Slash Command 集合 ─────────────────────────────────────
client.commands = new Collection();

// ── 註冊所有處理器（各 handler 內部會自行注入 client.commands）──
setupVoiceCommands(client);
setupBasicCommands(client);
setupCustomResponses(client);
setupAICommands(client); 
setupGuguGenerator(client);
setupBilibiliCommands(client);
setupAutoJoinCommands(client);
setupTTSCommands(client);

// ── Slash Command 互動處理 ─────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) {
    console.warn(`⚠️ 找不到指令：/${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction, client);
  } catch (error) {
    console.error(`❌ 執行指令 /${interaction.commandName} 時發生錯誤：`, error);
    const reply = { content: '❌ 執行指令時發生錯誤，請稍後再試。', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

// ── 註冊 Slash Commands 到 Discord ────────────────────────
async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  // 從 client.commands 自動收集所有已注入的指令
  const commands = [...client.commands.values()].map(cmd => cmd.data.toJSON());

  try {
    console.log('🔄 正在註冊 Slash Commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log(`✅ Slash Commands 註冊完成（共 ${commands.length} 個）`);
  } catch (err) {
    console.error('❌ Slash Commands 註冊失敗:', err);
  }
}

// ── Bot 啟動 ───────────────────────────────────────────────
client.once('clientReady', async () => {
  console.log(`✅ Bot 已登入為 ${client.user.tag}`);
  console.log(`📊 已加入 ${client.guilds.cache.size} 個伺服器`);
  console.log(`🎯 已載入 ${Object.keys(customResponses.exact).length} 個完全匹配回應`);
  console.log(`🔍 已載入 ${Object.keys(customResponses.contains).length} 個包含匹配回應`);
  console.log(`🤖 AI 功能已啟用 (Gemini API)`);
  console.log(`⚡ 已載入 ${client.commands.size} 個 Slash Commands`);

  client.user.setPresence({
    activities: [{ name: '逼逼 機油好難喝', type: 2 }],
    status: 'online'
  });

  await registerSlashCommands();
});

// ── 錯誤處理 ──────────────────────────────────────────────
client.on('error', error => {
  console.error('❌ Discord 客戶端錯誤：', error);
});

process.on('unhandledRejection', error => {
  console.error('❌ 未處理的 Promise 拒絕：', error);
});

process.on('uncaughtException', error => {
  console.error('❌ 未捕捉的例外：', error);
});

// ── 登入 ──────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN).catch(error => {
  console.error('❌ 登入失敗：', error);
  process.exit(1);
});