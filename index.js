require('dotenv').config();
// 必須最早安裝：之後載入的任何模組在載入期間丟出的錯誤也要被接住
const processGuards = require('./utils/processGuards');
processGuards.install();
// 管理面板的「還原設定備份」：暫存的檔案要在任何模組讀 data/ 之前套用（見 admin/backup.js）
require('./admin/backup').applyPendingRestore();
const { Client, GatewayIntentBits, Collection, MessageFlags } = require('discord.js');
const logger = require('./utils/logger');
const bootSummary = require('./utils/bootSummary');
const { OWNER_USER_IDS } = require('./utils/config');
const { syncCommands, clientSyncOptions } = require('./utils/commandSync');
const { startHealthServer } = require('./utils/health');
const { startHeartbeat } = require('./utils/heartbeat');
const { startAgentServer } = require('./admin/agent');

// ── 核心功能（不受 FEATURES 控制）─────────────────────────
const { applyPresence } = require('./handlers/presenceHandler');
// 其他功能模組由 utils/features.js 的登錄表決定要不要載入（環境變數 FEATURES）
const features = require('./utils/features');

// ── 創建客戶端 ─────────────────────────────────────────────
const client = new Client({
  // 預設只允許 @使用者；擋掉 @everyone / @here / 身分組提及。
  allowedMentions: { parse: ['users'] },
  // 只要求已啟用模組需要的 intents（全開時是 Guilds、GuildMessages、MessageContent、GuildVoiceStates、GuildMembers）
  intents: features.intents().map(k => GatewayIntentBits[k]),
});

// 致命錯誤與 SIGTERM / SIGINT 時刻意不呼叫 client.destroy()：
// 它會以 close code 1000 關閉 gateway，Discord 隨即讓 session 失效並把 Bot 移出語音頻道。
// 直接結束程序讓連線中斷，Bot 會留在頻道裡直到 Discord 判定逾時，重啟後重新加入不會出現離開/加入的閃爍。

if (OWNER_USER_IDS.size === 0) {
  bootSummary.report('擁有者權限', 'warn', '未設定 OWNER_USER_ID：/ai mode、/response add|remove、/autojoin 變更頻道將無人可用');
}

// ── Slash Command 集合 ─────────────────────────────────────
client.commands = new Collection();

// ── 錯誤處理 ──────────────────────────────────────────────
// 要在模組 setup 之前掛上：EventEmitter 發出 'error' 卻沒有監聽器時會直接丟例外，讓程序崩潰。
// shardError 以前是 autoJoinHandler 代掛的，autojoin 停用時就沒人監聽，所以搬到核心。
client.on('error', error => {
  logger.error('Discord', '客戶端錯誤：', error);
});
client.on('shardError', error => {
  logger.error('Discord', 'Shard 錯誤：', error);
});

// ── 註冊各模組處理器（依 utils/features.js 的清單順序）────
// 音樂的指令與本地引擎也在登入前就註冊：過去要等 clientReady 後才註冊 /play、/music，
// 這段期間有人下指令會得到「找不到指令」。線上引擎（需檢查 yt-dlp / bgutil）在 ready 後非同步注入，
// 注入前呼叫線上功能時各呼叫點會回覆「引擎初始化中」。
features.setupModules(client);

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
    logger.error('Interaction', `執行指令 /${interaction.commandName} 時發生錯誤：`, error);
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
  const options = clientSyncOptions(client);
  const { devGuildId } = options;

  try {
    logger.debug('Boot', '正在同步 Slash Commands...');
    const { skipped, scope, count } = await syncCommands({
      ...options,
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
    logger.error('Boot', 'Slash Commands 註冊失敗：', err);
  }
}

// ── Bot 啟動 ───────────────────────────────────────────────
client.once('clientReady', async () => {
  logger.success('Discord', `已登入為 ${client.user.tag}（${client.guilds.cache.size} 個伺服器）`);

  // 狀態與活動文字可以在管理面板修改（data/presence.json）
  applyPresence(client);

  // 線上音樂引擎（含 yt-dlp / bgutil 檢查）與指令同步彼此獨立，並行處理；音樂停用時跳過
  const music = features.get('music');
  await Promise.all([
    music ? features.load('handlers/musicplayer/onlineMusicHandler').setupOnlineMusicEngine() : null,
    registerSlashCommands(),
  ]);

  // ── 所有模組都已回報狀態，統一印出開機摘要 ────────────
  // 網頁「正在播放」同步（要在開機摘要之前，才會列進摘要表）
  if (music) music.startWebSync(client);
  // 外部監控的心跳（設定 HEARTBEAT_URL 才啟用）
  startHeartbeat(client);

  bootSummary.print();

  // ── 接續重啟前的音樂播放（需在線上引擎注入之後）──────
  if (music) {
    const resumed = await music.resumeSavedSessions(client);
    if (resumed > 0) logger.success('MusicSession', `已恢復 ${resumed} 個伺服器的播放`);
  }
});

startHealthServer(client);
// 管理 API：給 admin-panel 服務呼叫（設定 ADMIN_AGENT_TOKEN 才會啟動）
startAgentServer(client, require('./admin/api'));

// ── 登入 ──────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN).catch(error => {
  logger.error('Discord', `登入失敗：${error.message}`);
  process.exit(1);
});