require('dotenv').config();
// 必須最早安裝：之後載入的任何模組在載入期間丟出的錯誤也要被接住
const processGuards = require('./utils/processGuards');
processGuards.install();
const { Client, GatewayIntentBits, REST, Routes, Collection, MessageFlags } = require('discord.js');
const logger = require('./utils/logger');
const bootSummary = require('./utils/bootSummary');
const { OWNER_USER_IDS } = require('./utils/config');

// ── 導入所有處理器 ─────────────────────────────────────────
const { setupVoiceCommands }     = require('./handlers/voiceHandler');
const { setupBasicCommands }     = require('./handlers/commandHandler');
const { setupCustomResponses }   = require('./handlers/responseHandler');
const { setupAICommands }        = require('./handlers/ai/aiHandler');
// gugugagaGenerator.js 現在只匯出純函式，/gugu 已合併進 /ai gugu，由 setupAICommands 註冊
const { setupAutoJoinCommands }  = require('./handlers/autoJoinHandler');
const { setupTTSCommands }       = require('./handlers/voice/ttsHandler');
const { setupNoticeCommands }    = require('./handlers/notice/noticeHandler');
const { setupTimeAnnouncer }     = require('./handlers/notice/timeAnnouncer');

// ── 導入分帳系統 ────────────────────────
const { setupSplitbillCommands } = require('./handlers/splitbill/index');

// ── 重構後的音樂模組 ───────────────────────────────────────
const { setupUnifiedCommands }   = require('./handlers/musicplayer/unifiedQueue');
const { setupOnlineMusicEngine } = require('./handlers/musicplayer/onlineMusicHandler');
const { setupLocalMusicEngine }  = require('./handlers/musicplayer/localMusicHandler');

// ── 創建客戶端 ─────────────────────────────────────────────
const client = new Client({
  // 預設只允許 @使用者；擋掉 @everyone / @here / 身分組提及。
  allowedMentions: { parse: ['users'] },
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ]
});

// 致命錯誤（uncaughtException）與 SIGTERM / SIGINT 時，先讓 Discord 連線正常關閉再結束程序
processGuards.setFatalHook(() => client.destroy());

if (OWNER_USER_IDS.size === 0) {
  bootSummary.report('擁有者權限', 'warn', '未設定 OWNER_USER_ID：/ai mode、/response add|remove、/autojoin 變更頻道將無人可用');
}

// ── Slash Command 集合 ─────────────────────────────────────
client.commands = new Collection();

// ── 註冊各模組處理器（同步，順序無關）────────────────────
setupVoiceCommands(client);
setupBasicCommands(client);
setupCustomResponses(client);
setupAICommands(client);
setupAutoJoinCommands(client);
setupTTSCommands(client);
setupNoticeCommands(client);
setupTimeAnnouncer(client);

// ── 🆕 注入分帳介面與唯一的 /splitbill 指令 ───────────────
setupSplitbillCommands(client);

// ── Slash Command 互動處理 ─────────────────────────────────
client.on('interactionCreate', async interaction => {

  // ── Autocomplete（必須在最上面）────────────────────────
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (command?.autocomplete) {
      try {
        await command.autocomplete(interaction);
      } catch (err) {
        console.error('❌ Autocomplete 錯誤：', err);
      }
    }
    return;
  }

  // ── Slash Command ───────────────────────────────────────
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
    const reply = {
      content: '❌ 執行指令時發生錯誤，請稍後再試。',
      flags: MessageFlags.Ephemeral,
    };
    // 回覆錯誤訊息本身也可能失敗（互動已逾時、頻道已刪除），不要讓它變成 unhandled rejection
    const send = interaction.replied || interaction.deferred
      ? interaction.followUp(reply)
      : interaction.reply(reply);
    await send.catch(err => console.error('❌ 回覆錯誤訊息失敗：', err.message));
  }
});

// ── 註冊 Slash Commands 到 Discord ────────────────────────
async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const commands = [...client.commands.values()].map(cmd => cmd.data.toJSON());

  try {
    logger.debug('Boot', '正在註冊 Slash Commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    bootSummary.report('Slash Commands 註冊', 'ok', `已同步 ${commands.length} 個指令到 Discord`);
  } catch (err) {
    bootSummary.report('Slash Commands 註冊', 'off', `註冊失敗: ${err.message}`);
    console.error('❌ Slash Commands 註冊失敗:', err);
  }
}

// ── Bot 啟動 ───────────────────────────────────────────────
client.once('clientReady', async () => {
  logger.success('Discord', `已登入為 ${client.user.tag}（${client.guilds.cache.size} 個伺服器）`);

  // ── 音樂引擎初始化（需 async，在 ready 後執行）──────────
  // 順序重要：先注入引擎，再載入統一指令
  await setupOnlineMusicEngine(); // 1. 注入 online 引擎（含 yt-dlp 檢查）
  setupLocalMusicEngine(client);  // 2. 注入 local 引擎（/music local list 由 setupUnifiedCommands 註冊）
  setupUnifiedCommands(client);   // 3. 載入合併後的 /music 指令

  client.user.setPresence({
    activities: [{ name: '逼逼 機油好難喝', type: 2 }],
    status: 'online'
  });

  await registerSlashCommands();

  // ── 所有模組都已回報狀態，統一印出開機摘要 ────────────
  bootSummary.print();
});

// ── 錯誤處理 ──────────────────────────────────────────────
client.on('error', error => {
  console.error('❌ Discord 客戶端錯誤：', error);
});

// ── 登入 ──────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN).catch(error => {
  console.error('❌ 登入失敗：', error);
  process.exit(1);
});