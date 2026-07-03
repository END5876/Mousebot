// handlers/voiceActivityMonitor.js
// 職責：監控語音頻道「人數 / 說話活動」，閒置過久時觸發自動停止播放
//
// 規則：
//   A) 頻道內持續 30 分鐘沒有其他真人 → 觸發停止
//   B) 頻道內有真人，但持續 60 分鐘沒人開麥說話 → 觸發停止
//

const ALONE_TIMEOUT_MS   = 30 * 60 * 1000; // 30 分鐘：頻道內只剩機器人
const SILENCE_TIMEOUT_MS = 60 * 60 * 1000; // 60 分鐘：有人在但沒人說話
const CHECK_INTERVAL_MS  = 60 * 1000;      // 每 60 秒巡檢一次

// guildId -> { intervalId, aloneSince, lastSpeakTime, connection, speakingHandler, channelId, client, onStop }
const monitors = new Map();

// guildId -> boolean（未設定時預設為 true，即預設開啟，延續現有行為）
const enabledGuilds = new Map();

function isEnabled(guildId) {
  return enabledGuilds.has(guildId) ? enabledGuilds.get(guildId) : true;
}

function setEnabled(guildId, enabled) {
  enabledGuilds.set(guildId, !!enabled);
  console.log(`⚙️ [VoiceMonitor] guild ${guildId} 閒置監控功能已設定為: ${enabled ? '開啟' : '關閉'}`);
}

function _getVoiceChannel(client, guildId, channelId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;
  return guild.channels.cache.get(channelId) || null;
}

// 只計算真人（排除機器人，包含自己）
function _countHumanMembers(channel, botId) {
  if (!channel || !channel.members) return 0;
  let count = 0;
  channel.members.forEach(member => {
    if (member.id !== botId && !member.user.bot) count++;
  });
  return count;
}

/**
 * 開始監控指定 guild 的語音頻道活動
 * 若該 guild 的閒置監控功能已被管理員關閉，則不會啟動任何計時器。
 */
function startMonitoring({ guildId, connection, channel, client, onStop }) {
  if (!isEnabled(guildId)) {
    console.log(`⏸️ [VoiceMonitor] guild ${guildId} 的閒置監控功能已關閉，不啟動監控`);
    return;
  }

  // 若已有舊的監控，先清掉避免重複計時器
  stopMonitoring(guildId);

  const now   = Date.now();
  const botId = client.user.id;

  const state = {
    aloneSince    : _countHumanMembers(channel, botId) === 0 ? now : null,
    lastSpeakTime : now,
    channelId     : channel.id,
    client,
    onStop,
    intervalId      : null,
    speakingHandler : null,
    connection,
  };

  // ── 監聽「有人開始說話」事件，更新最後說話時間 ──────────
  const speakingHandler = (userId) => {
    if (userId === botId) return; // 機器人自己不算
    state.lastSpeakTime = Date.now();
  };
  connection.receiver.speaking.on('start', speakingHandler);
  state.speakingHandler = speakingHandler;

  // ── 定時巡檢 ─────────────────────────────────────────
  state.intervalId = setInterval(() => {
    const liveChannel = _getVoiceChannel(client, guildId, state.channelId);
    const humanCount  = _countHumanMembers(liveChannel, botId);
    const nowTs = Date.now();

    if (humanCount === 0) {
      // 條件 A：獨處計時
      if (state.aloneSince === null) state.aloneSince = nowTs;

      if (nowTs - state.aloneSince >= ALONE_TIMEOUT_MS) {
        _trigger(guildId, '頻道內已無其他成員超過 30 分鐘');
      }
    } else {
      // 有人在，獨處計時重置；改檢查「沉默計時」
      state.aloneSince = null;

      if (nowTs - state.lastSpeakTime >= SILENCE_TIMEOUT_MS) {
        _trigger(guildId, '頻道內超過 1 小時無人說話');
      }
    }
  }, CHECK_INTERVAL_MS);

  monitors.set(guildId, state);
  console.log(`👀 [VoiceMonitor] 開始監控 guild ${guildId} 的語音活動`);
}

function _trigger(guildId, reason) {
  const state = monitors.get(guildId);
  if (!state) return;

  console.log(`⏹️ [VoiceMonitor] 觸發自動停止 (${guildId})：${reason}`);
  const cb = state.onStop;
  stopMonitoring(guildId); // 先清理，避免 onStop 內部再次觸發時重複執行
  if (typeof cb === 'function') cb(guildId, reason);
}

/**
 * 停止監控（手動 /stop、正常斷線、管理員關閉功能、或觸發後的清理都要呼叫）
 */
function stopMonitoring(guildId) {
  const state = monitors.get(guildId);
  if (!state) return;

  if (state.intervalId) clearInterval(state.intervalId);
  if (state.connection && state.speakingHandler) {
    try { state.connection.receiver.speaking.off('start', state.speakingHandler); } catch {}
  }
  monitors.delete(guildId);
  console.log(`🛑 [VoiceMonitor] 停止監控 guild ${guildId}`);
}

/**
 * （可選）手動「觸碰」活躍時間：
 * 例如使用者按了控制面板按鈕、下了 /play 指令，
 * 即便沒開麥說話，也視為頻道仍活躍，重置沉默計時。
 * 若不需要這個寬鬆判定，unifiedQueue.js 中可以不呼叫這個函式。
 */
function touchActivity(guildId) {
  const state = monitors.get(guildId);
  if (state) state.lastSpeakTime = Date.now();
}

module.exports = {
  startMonitoring,
  stopMonitoring,
  touchActivity,
  isEnabled,
  setEnabled,
};
