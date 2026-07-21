const path = require('path');
const fs = require('fs');
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const {
  getVoiceConnections,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
} = require('@discordjs/voice');
const logger = require('../../utils/logger');
const { nowPlaying } = require('../musicplayer/unifiedQueue/state');

const SOUND_DIR = path.join(__dirname, '../../data/timeAnnouncer');

// ── 每伺服器開關設定的 JSON 永久化 ──────────────────────────
// 預設為「關閉」，只記錄被明確開啟過的伺服器 ID，
// 這樣新加入的伺服器不會自動開始整點報時，需手動 /timeannounce 開啟。
const DATA_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const SETTINGS_FILE = path.join(DATA_DIR, 'timeAnnouncerSettings.json');

let enabledGuildIds = new Set();

// ── 讀取設定檔 ────────────────────────────────────────────
function loadSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (Array.isArray(parsed.enabledGuilds)) {
      enabledGuildIds = new Set(parsed.enabledGuilds);
    }
    logger.debug('HourlyReport', `已載入報時開關設定，${enabledGuildIds.size} 個伺服器已開啟`);
  } catch (e) {
    logger.warn('HourlyReport', `讀取報時開關設定失敗: ${e.message}`);
  }
}
loadSettings();

// ── 儲存設定檔（非同步寫入，避免阻塞） ────────────────────
function saveSettings() {
  fs.writeFile(
    SETTINGS_FILE,
    JSON.stringify({ enabledGuilds: [...enabledGuildIds] }, null, 2),
    (e) => {
      if (e) console.error('⚠️ [HourlyReport] 儲存報時開關設定失敗:', e.message);
    }
  );
}

/**
 * 查詢指定伺服器目前是否開啟報時
 * 預設為 false（關閉），只有在集合中出現的伺服器才視為開啟
 */
function isAnnouncerEnabled(guildId) {
  return enabledGuildIds.has(guildId);
}

/**
 * 設定指定伺服器的報時開關
 * @param {string} guildId
 * @param {boolean} enabled
 */
function setAnnouncerEnabled(guildId, enabled) {
  if (enabled) {
    enabledGuildIds.add(guildId);
  } else {
    enabledGuildIds.delete(guildId);
  }
  saveSettings();
}

// 24 小時 → 對應音檔檔名（依你提供的檔案清單完整對應 0~23 點）
const HOUR_SOUND_MAP = {
  0: '凌晨十二點了喵.wav',
  1: '凌晨一點了喵.wav',
  2: '凌晨兩點了喵.wav',
  3: '凌晨三點了喵.wav',
  4: '凌晨四點了喵.wav',
  5: '凌晨五點了喵.wav',
  6: '早上六點了喵.wav',
  7: '早上七點了喵.wav',
  8: '早上八點了喵.wav',
  9: '早上九點了喵.wav',
  10: '早上十點了喵.wav',
  11: '早上十一點了喵.wav',
  12: '中午十二點了喵.wav',
  13: '下午一點了喵.wav',
  14: '下午兩點了喵.wav',
  15: '下午三點了喵.wav',
  16: '下午四點了喵.wav',
  17: '下午五點了喵.wav',
  18: '晚上六點了喵.wav',
  19: '晚上七點了喵.wav',
  20: '晚上八點了喵.wav',
  21: '晚上九點了喵.wav',
  22: '晚上十點了喵.wav',
  23: '晚上十一點了喵.wav',
};

const TIMEZONE = 'Asia/Taipei'; // 依實際部署地點調整
const POLL_INTERVAL_MS = 5000;  // 從 1 秒拉長為 5 秒，觸發窗口有 60 秒寬，不會漏報

// Formatter 只在模組載入時建立一次，重複使用，避免每次呼叫都重新建立
const _formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
});

// 記錄「上次已觸發」的時間鍵值（年-月-日-時），避免同一小時內重複觸發
let lastTriggeredKey = null;

/**
 * 取得指定時區目前的日期/時間各欄位（年、月、日、時、分）
 * 直接使用模組層級快取的 _formatter，只呼叫 formatToParts()
 */
function getNowParts() {
  const parts = _formatter.formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: parseInt(get('hour'), 10),
    minute: parseInt(get('minute'), 10),
  };
}

/**
 * 對目前所有語音連線播放指定小時的音檔
 * 若該伺服器正在播放音樂，先暫停 → 播報時 → 結束後恢復播放
 */
function playHourlySound(hour) {
  const fileName = HOUR_SOUND_MAP[hour];
  if (!fileName) {
    logger.warn('HourlyReport', `找不到 ${hour} 點對應的音檔設定`);
    return;
  }

  const filePath = path.join(SOUND_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    logger.warn('HourlyReport', `音檔不存在：${filePath}`);
    return;
  }

  const connections = getVoiceConnections(); // Map<guildId, VoiceConnection>
  if (connections.size === 0) {
    logger.debug('HourlyReport', '目前沒有任何語音連線，略過本次報時');
    return;
  }

  connections.forEach((connection, guildId) => {
    // 若該伺服器尚未開啟報時系統，直接略過（預設關閉）
    if (!isAnnouncerEnabled(guildId)) {
      logger.debug('HourlyReport', `伺服器 ${guildId} 尚未開啟報時系統，略過`);
      return;
    }

    try {
      // 1. 取得當前頻道正在播放的音樂，若正在播放則先暫停
      const currentNp = nowPlaying.get(guildId);
      const musicPlayer = currentNp ? currentNp.player : null;

      if (musicPlayer && musicPlayer.state.status === AudioPlayerStatus.Playing) {
        musicPlayer.pause();
      }

      // 2. 建立報時播放器
      const player = createAudioPlayer();
      const resource = createAudioResource(filePath, {
        inputType: StreamType.Arbitrary,
      });

      // 這會暫時覆蓋音樂的訂閱層
      connection.subscribe(player);
      player.play(resource);

      // 3. 建立恢復音樂的輔助函式
      const restoreMusic = () => {
        const checkNp = nowPlaying.get(guildId);
        // 確保原本的音樂播放器仍存在，且期間沒有被使用者切歌或停止
        if (musicPlayer && checkNp && checkNp.player === musicPlayer) {
          connection.subscribe(musicPlayer);
          musicPlayer.unpause();
        }
      };

      // 4. 報時結束後恢復原本的播放狀態
      player.once(AudioPlayerStatus.Idle, () => {
        player.stop();
        restoreMusic();
      });

      player.once('error', (err) => {
        logger.error('HourlyReport', `伺服器 ${guildId} 播放器錯誤：${err.message}`);
        restoreMusic(); // 發生錯誤也一併嘗試恢復音樂
      });

      logger.success('HourlyReport', `伺服器 ${guildId} 播放：${fileName}`);
    } catch (err) {
      logger.error('HourlyReport', `伺服器 ${guildId} 播放失敗：${err.message}`);
    }
  });
}

/**
 * 每 5 秒執行：比對真實時間，判斷是否為整點且尚未觸發過
 */
function checkAndTrigger() {
  const { year, month, day, hour, minute } = getNowParts();
  const dateKey = `${year}-${month}-${day}-${hour}`; // 唯一鍵：年-月-日-時

  // 只在「分鐘為 0」且「這個小時還沒報過」時才觸發，避免重複播放
  if (minute === 0 && lastTriggeredKey !== dateKey) {
    lastTriggeredKey = dateKey;
    logger.debug('HourlyReport', `偵測到整點：${dateKey} 時，觸發報時`);
    playHourlySound(hour);
  }
}

// ════════════════════════════════════════════════════════
//  /timeannounce 指令：管理本伺服器的整點報時開關（單一指令版）
//  不帶參數 → 查看狀態；帶 action 參數 → 開啟/關閉（僅管理員）
// ════════════════════════════════════════════════════════
const timeAnnounceCommand = {
  data: new SlashCommandBuilder()
    .setName('timeannounce')
    .setDescription('管理本伺服器的整點報時系統')
    .addStringOption(option =>
      option
        .setName('action')
        .setDescription('選擇操作，留空則查看目前狀態')
        .addChoices(
          { name: '開啟', value: 'on' },
          { name: '關閉', value: 'off' },
          { name: '查看狀態', value: 'status' },
        )
    ),

  async execute(interaction) {
    if (!interaction.guildId) {
      return interaction.reply({
        content: '❌ 此指令僅能在伺服器中使用',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 未帶參數時，預設為查看狀態
    const action = interaction.options.getString('action') ?? 'status';

    // status 開放所有人查看，on / off 僅限管理員
    if (action !== 'status' && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: '❌ 只有具備「管理伺服器」權限的成員可以使用此指令',
        flags: MessageFlags.Ephemeral,
      });
    }

    const guildId = interaction.guildId;

    if (action === 'on') {
      setAnnouncerEnabled(guildId, true);
      return interaction.reply({
        content: '✅ 本伺服器的整點報時系統已 **開啟**',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (action === 'off') {
      setAnnouncerEnabled(guildId, false);
      return interaction.reply({
        content: '🛑 本伺服器的整點報時系統已 **關閉**',
        flags: MessageFlags.Ephemeral,
      });
    }

    // action === 'status'
    const statusText = isAnnouncerEnabled(guildId) ? '✅ 開啟中' : '🛑 已關閉（預設狀態）';
    return interaction.reply({
      content: `📊 本伺服器目前的整點報時狀態：${statusText}`,
      flags: MessageFlags.Ephemeral,
    });
  },
};

/**
 * 對外初始化函式，於 index.js 中呼叫
 * @param {import('discord.js').Client} client
 */
function setupTimeAnnouncer(client) {
  client.commands.set(timeAnnounceCommand.data.name, timeAnnounceCommand);

  setInterval(checkAndTrigger, POLL_INTERVAL_MS);
  logger.success('HourlyReport', '整點報時排程已啟動（5 秒輪詢真實時間模式，預設關閉）');
}

module.exports = {
  setupTimeAnnouncer,
  playHourlySound,  // 匯出方便測試 / 手動觸發
  getNowParts,
  isAnnouncerEnabled,
  setAnnouncerEnabled,
};