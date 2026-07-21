// handlers/voiceActivityMonitor.js
// 職責：監控語音頻道「人數 / 說話活動」，閒置過久時觸發自動停止播放
//
// 規則：
//   A) 頻道內持續 30 分鐘沒有其他真人 → 觸發停止
//   B) 頻道內有真人，但持續 60 分鐘沒人開麥說話 → 觸發停止
//
// 模式說明：
//   本模組目前只使用「常駐模式」：Bot 設定了 TARGET_VOICE_CHANNEL_ID、永遠待在頻道內，
//   觸發後只呼叫 onStop（通常只停止播放，不離開頻道），監控本身「不會停止」，
//   會持續巡檢，並用「已觸發旗標」避免同一輪閒置狀態每 60 秒重複觸發/洗版通知。
//
//   一般模式（觸發後 stopMonitoring 並讓 onStop 離開頻道）已停用，
//   相關程式碼保留在 _trigger() 內以註解方式留存，之後若要恢復可以參考。

const ALONE_TIMEOUT_MS   = 30 * 60 * 1000; // 30 分鐘：頻道內只剩機器人
const SILENCE_TIMEOUT_MS = 60 * 60 * 1000; // 60 分鐘：有人在但沒人說話
const CHECK_INTERVAL_MS  = 60 * 1000;      // 每 60 秒巡檢一次

// guildId -> { intervalId, aloneSince, lastSpeakTime, aloneTriggered, silenceTriggered,
//              connection, speakingHandler, channelId, client, onStop, persistent }
const monitors = new Map();

// guildId -> boolean（未設定時預設為 true，即預設開啟，延續現有行為）
const enabledGuilds = new Map();

// ★ 全域單例旗標，確保 voiceStateUpdate 監聽器整個 process 只註冊一次，
//   避免每個 guild 各自呼叫 client.on(...) 導致監聽器疊加、觸發
//   MaxListenersExceededWarning（Node.js 預設上限為 10 個監聽器）
let _globalVoiceStateListenerRegistered = false;

function isEnabled(guildId) {
  return enabledGuilds.has(guildId) ? enabledGuilds.get(guildId) : true;
}

function setEnabled(guildId, enabled) {
  enabledGuilds.set(guildId, !!enabled);
  console.log(`⚙️ [VoiceMonitor] guild ${guildId} 閒置監控功能已設定為: ${enabled ? '開啟' : '關閉'}`);
}

/**
 * 該 guild 目前是否有監控正在運作中
 */
function isMonitoring(guildId) {
  return monitors.has(guildId);
}

/**
 * 該 guild 目前的監控是否為「常駐模式」（觸發後不會離開頻道）
 */
function isPersistent(guildId) {
  return !!monitors.get(guildId)?.persistent;
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

// 標記「頻道仍活躍」：更新最後說話時間，並解除沉默觸發旗標，
// 讓「60 分鐘無人說話」的判定在下一輪重新從頭計時。
function _markActive(state, ts = Date.now()) {
  state.lastSpeakTime = ts;
  state.silenceTriggered = false;
}

/**
 * ★ 全域單例的 voiceStateUpdate 監聽器。
 * 只在整個 process 生命週期內註冊一次，內部透過遍歷 monitors Map
 * 動態比對頻道 ID，取代「每個 guild 各自綁定一個監聽器」的作法。
 * 使用者解除靜音（unmute）視為活躍訊號，作為 speaking 事件的防禦性補強。
 */
function _ensureGlobalVoiceStateListener(client) {
  if (_globalVoiceStateListenerRegistered) return;
  _globalVoiceStateListenerRegistered = true;

  client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.member?.user?.bot) return;
    if (!(oldState.selfMute && !newState.selfMute)) return;

    for (const state of monitors.values()) {
      if (newState.channelId === state.channelId) {
        _markActive(state);
      }
    }
  });

  console.log('✅ [VoiceMonitor] 全域 voiceStateUpdate 監聽器已註冊（單例，僅一次）');
}

/**
 * 開始監控指定 guild 的語音頻道活動
 * 若該 guild 的閒置監控功能已被管理員關閉，則不會啟動任何計時器。
 *
 * @param {boolean} persistent 是否為常駐模式（觸發後只呼叫 onStop，監控本身持續運作、不會停止）
 *                             ※ 目前只使用常駐模式，預設為 true
 */
function startMonitoring({ guildId, connection, channel, client, onStop, persistent = true }) {
  if (!isEnabled(guildId)) {
    console.log(`⏸️ [VoiceMonitor] guild ${guildId} 的閒置監控功能已關閉，不啟動監控`);
    return;
  }

  // 若已有舊的監控，先清掉避免重複計時器
  stopMonitoring(guildId);

  // ★ 改為確保全域監聽器已註冊，取代原本每個 guild 各自 client.on(...)
  _ensureGlobalVoiceStateListener(client);

  const now   = Date.now();
  const botId = client.user.id;

  const state = {
    aloneSince       : _countHumanMembers(channel, botId) === 0 ? now : null,
    lastSpeakTime    : now,
    aloneTriggered   : false,
    silenceTriggered : false,
    channelId        : channel.id,
    client,
    onStop,
    persistent,
    intervalId      : null,
    speakingHandler : null,
    connection,
  };

  // ── 監聽「有人開始說話」事件，更新最後說話時間 ──────────
  const speakingHandler = (userId) => {
    if (userId === botId) return; // 機器人自己不算
    _markActive(state);
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
      if (state.aloneSince === null) {
        state.aloneSince = nowTs;
        state.aloneTriggered = false; // 新的一輪獨處，重新允許觸發
      }

      if (!state.aloneTriggered && nowTs - state.aloneSince >= ALONE_TIMEOUT_MS) {
        state.aloneTriggered = true;
        _trigger(guildId, '頻道內已無其他成員超過 30 分鐘');
      }
    } else {
      // 有人在，獨處計時重置；改檢查「沉默計時」
      state.aloneSince = null;
      state.aloneTriggered = false;

      if (!state.silenceTriggered && nowTs - state.lastSpeakTime >= SILENCE_TIMEOUT_MS) {
        state.silenceTriggered = true;
        _trigger(guildId, '頻道內超過 1 小時無人說話');
      }
    }
  }, CHECK_INTERVAL_MS);

  monitors.set(guildId, state);
  console.log(`👀 [VoiceMonitor] 開始監控 guild ${guildId} 的語音活動${persistent ? '（常駐模式，觸發後不離開頻道）' : ''}`);
}

function _trigger(guildId, reason) {
  const state = monitors.get(guildId);
  if (!state) return;

  console.log(`⏹️ [VoiceMonitor] 觸發自動停止 (${guildId})：${reason}`);
  const cb = state.onStop;

  // ── 常駐模式（目前唯一使用的模式）────────────────────────
  // 只呼叫 onStop（通常只停止播放），監控本身繼續運作。
  // aloneTriggered / silenceTriggered 旗標已在上面設為 true，
  // 避免同一輪閒置狀態每 60 秒重複觸發，直到條件自然解除（有人回來 / 有人說話）才會重置。
  if (typeof cb === 'function') cb(guildId, reason);

  // ── 一般模式（已停用，保留註解供之後參考）──────────────────
  // 一般模式會在觸發時先 stopMonitoring()，再呼叫 onStop（通常 onStop 內部會
  // destroy 連線、離開頻道）。目前整個專案只使用常駐模式，故不再執行這段：
  //
  // if (!state.persistent) {
  //   stopMonitoring(guildId);
  //   if (typeof cb === 'function') cb(guildId, reason);
  //   return;
  // }
}

/**
 * 停止監控（手動 /stop、正常斷線、管理員關閉功能、或一般模式觸發後的清理都要呼叫）
 */
function stopMonitoring(guildId) {
  const state = monitors.get(guildId);
  if (!state) return;

  if (state.intervalId) clearInterval(state.intervalId);
  if (state.connection && state.speakingHandler) {
    try { state.connection.receiver.speaking.off('start', state.speakingHandler); } catch {}
  }
  // ★ 不再需要解除 voiceStateUpdate 綁定，
  //   因為全域監聽器透過 monitors Map 動態判斷，
  //   guild 被刪除後自然不會再被處理到（monitors.delete 在下方執行）
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
  if (state) _markActive(state);
}

module.exports = {
  startMonitoring,
  stopMonitoring,
  touchActivity,
  isEnabled,
  setEnabled,
  isMonitoring,
  isPersistent,
};
