require('dotenv').config();
// 必須最早安裝：之後載入的任何模組在載入期間丟出的錯誤也要被接住
const processGuards = require('./utils/processGuards');
processGuards.install();
const { Client, GatewayIntentBits, Collection, MessageFlags } = require('discord.js');
const logger = require('./utils/logger');
const bootSummary = require('./utils/bootSummary');
const { OWNER_USER_IDS } = require('./utils/config');
const { syncCommands } = require('./utils/commandSync');
const { startHealthServer } = require('./utils/health');
const { startAdminServer } = require('./admin/server');

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
const { setupUnifiedCommands, resumeSavedSessions, startWebSync } = require('./handlers/musicplayer/unifiedQueue');
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

// 致命錯誤與 SIGTERM / SIGINT 時刻意不呼叫 client.destroy()：
// 它會以 close code 1000 關閉 gateway，Discord 隨即讓 session 失效並把 Bot 移出語音頻道。
// 直接結束程序讓連線中斷，Bot 會留在頻道裡直到 Discord 判定逾時，重啟後重新加入不會出現離開/加入的閃爍。

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

// ── 音樂：指令與本地引擎在登入前就註冊 ────────────────────
// 過去要等 clientReady 後才註冊 /play、/music，這段期間有人下指令會得到「找不到指令」。
// 本地引擎不依賴網路可立即注入；線上引擎（需檢查 yt-dlp / bgutil）在 ready 後非同步注入，
// 注入前呼叫線上功能時各呼叫點會回覆「引擎初始化中」。
setupLocalMusicEngine(client);
setupUnifiedCommands(client);

// ── Slash Command 互動處理 ─────────────────────────────────
client.on('interactionCreate', async interaction => {

  // ── Autocomplete（必須在最上面）────────────────────────
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (command?.autocomplete) {
      try {
        await command.autocomplete(interaction);
      } catch (err) {
        logger.error('Interaction', `Autocomplete 錯誤：${err.message}`);
      }
    }
    return;
  }

  // ── Slash Command ───────────────────────────────────────
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) {
    logger.warn('Interaction', `找不到指令：/${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction, client);
  } catch (error) {
    logger.error('Interaction', `執行指令 /${interaction.commandName} 時發生錯誤：${error.stack || error.message}`);
    const reply = {
      content: '❌ 執行指令時發生錯誤，請稍後再試。',
      flags: MessageFlags.Ephemeral,
    };
    // 回覆錯誤訊息本身也可能失敗（互動已逾時、頻道已刪除），不要讓它變成 unhandled rejection
    const send = interaction.replied || interaction.deferred
      ? interaction.followUp(reply)
      : interaction.reply(reply);
    await send.catch(err => logger.error('Interaction', `回覆錯誤訊息失敗：${err.message}`));
  }
});

// ── 註冊 Slash Commands 到 Discord ────────────────────────
// 指令內容沒變就不重新 PUT；設定 DEV_GUILD_ID 時改註冊到測試伺服器（立即生效）。
async function registerSlashCommands() {
  const commands = [...client.commands.values()].map(cmd => cmd.data.toJSON());
  const devGuildId = process.env.DEV_GUILD_ID?.trim() || null;

  try {
    logger.debug('Boot', '正在同步 Slash Commands...');
    const { skipped, scope, count } = await syncCommands({
      commands,
      token: process.env.DISCORD_TOKEN,
      clientId: process.env.CLIENT_ID,
      devGuildId,
      force: process.env.FORCE_COMMAND_SYNC === '1',
    });
    const where = scope === 'global' ? '全域' : `測試伺服器 ${devGuildId}`;
    bootSummary.report(
      'Slash Commands 註冊',
      'ok',
      skipped ? `${count} 個指令無變動，略過註冊（${where}）` : `已同步 ${count} 個指令到 Discord（${where}）`
    );
  } catch (err) {
    bootSummary.report('Slash Commands 註冊', 'off', `註冊失敗: ${err.message}`);
    logger.error('Boot', `Slash Commands 註冊失敗：${err.stack || err.message}`);
  }
}

// ── Bot 啟動 ───────────────────────────────────────────────
client.once('clientReady', async () => {
  logger.success('Discord', `已登入為 ${client.user.tag}（${client.guilds.cache.size} 個伺服器）`);

  client.user.setPresence({
    activities: [{ name: '逼逼 機油好難喝', type: 2 }],
    status: 'online'
  });

  // 線上音樂引擎（含 yt-dlp / bgutil 檢查）與指令同步彼此獨立，並行處理
  await Promise.all([
    setupOnlineMusicEngine(),
    registerSlashCommands(),
  ]);

  // ── 所有模組都已回報狀態，統一印出開機摘要 ────────────
  // 網頁「正在播放」同步（要在開機摘要之前，才會列進摘要表）
  startWebSync(client);

  bootSummary.print();

  // ── 接續重啟前的音樂播放（需在線上引擎注入之後）──────
  const resumed = await resumeSavedSessions(client);
  if (resumed > 0) logger.success('MusicSession', `已恢復 ${resumed} 個伺服器的播放`);
});

startHealthServer(client);
// 管理面板（設定 ADMIN_PASSWORD 才會啟動）
startAdminServer(client);

// ── 錯誤處理 ──────────────────────────────────────────────
client.on('error', error => {
  logger.error('Discord', `客戶端錯誤：${error.stack || error.message}`);
});

// ── 登入 ──────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN).catch(error => {
  logger.error('Discord', `登入失敗：${error.message}`);
  process.exit(1);
});