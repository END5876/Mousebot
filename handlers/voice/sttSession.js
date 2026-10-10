// handlers/voice/sttSession.js
// Guild / User 狀態管理、音訊訂閱 / 退訂、Idle 清理

const { EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');

const {
  DETECT_MAX_BYTES,
  MAX_DETECT_CHUNKS,
  MAX_RECORD_BYTES,
  STT_USER_IDLE_MS,
  STT_USER_CLEANUP_INTERVAL_MS,
  calcRMS,
} = require('./sttConfig');

// ── Guild 狀態 Map ───────────────────────────────────────
const guildStates = new Map();

// ══════════════════════════════════════════════════════════
// 靜音偵測快取 RMS
// ══════════════════════════════════════════════════════════
function getCachedRecentRMS(userState) {
  const currentLen = userState.recordChunks.length;

  if (currentLen === 0) {
    userState._lastSilenceChunksLen = 0;
    userState._lastSilenceRMS       = 0;
    return 0;
  }

  if (currentLen === userState._lastSilenceChunksLen) {
    return userState._lastSilenceRMS;
  }

  const recentBuf = Buffer.concat(userState.recordChunks.slice(-2));
  const rms       = calcRMS(recentBuf);

  userState._lastSilenceChunksLen = currentLen;
  userState._lastSilenceRMS       = rms;

  return rms;
}

function resetAllRecordBuffers(state) {
  for (const us of state.users.values()) {
    us.recordChunks          = [];
    us.recordBytes           = 0;
    us._lastSilenceChunksLen = -1;
    us._lastSilenceRMS       = 0;
  }
}

/**
 * 將新 chunk 加入使用者的偵測滑動視窗。
 * 只維護 chunk 陣列與位元組數；真正的 Buffer.concat 延後到 getDetectBuffer()
 * （每 DETECT_INTERVAL_MS 才呼叫一次）。先前版本在「每個 20ms chunk」都重新
 * concat 整個視窗（約 80KB），頻率是現在的數十倍，純粹浪費 CPU 與 GC。
 * @param {object} userState
 * @param {Buffer} chunk
 */
function pushDetectChunk(userState, chunk) {
  userState.detectChunks.push(chunk);
  userState.detectBytes += chunk.length;

  while (
    (userState.detectBytes > DETECT_MAX_BYTES || userState.detectChunks.length > MAX_DETECT_CHUNKS) &&
    userState.detectChunks.length > 0
  ) {
    userState.detectBytes -= userState.detectChunks.shift().length;
  }

  // 尚未送給 OWW 的增量音訊（與滑動視窗共用同一批 Buffer，不額外複製）。
  // 累積超過一個視窗代表太久沒送出，舊的部分丟掉並標記串流中斷，下次改送整個視窗。
  userState.pendingChunks.push(chunk);
  userState.pendingBytes += chunk.length;
  while (userState.pendingBytes > DETECT_MAX_BYTES && userState.pendingChunks.length > 0) {
    userState.pendingBytes -= userState.pendingChunks.shift().length;
    userState.streamBroken = true;
  }
}

/**
 * 取出這次要送給 OWW 的音訊，並清空待送區。
 * - 串流連續：只送上次之後新增的音訊（OWW 端的串流狀態會接著累積）
 * - 串流中斷：送整個滑動視窗並要求 OWW 端先 reset，讓它從乾淨狀態重建上下文
 * @returns {{ buffer: Buffer, reset: boolean }}
 */
function takeDetectPayload(userState) {
  const reset  = userState.streamBroken;
  const buffer = reset
    ? getDetectBuffer(userState)
    : Buffer.concat(userState.pendingChunks, userState.pendingBytes);

  userState.pendingChunks = [];
  userState.pendingBytes  = 0;
  userState.streamBroken  = false;
  return { buffer, reset };
}

/**
 * 丟棄待送音訊並標記串流中斷（略過偵測、冷卻中、請求失敗等，OWW 沒收到這段音訊時呼叫）。
 * @param {object} userState
 */
function markStreamBroken(userState) {
  userState.pendingChunks = [];
  userState.pendingBytes  = 0;
  userState.streamBroken  = true;
}

/** 取得目前偵測視窗的合併 Buffer（僅在要送去偵測時才組合一次） */
function getDetectBuffer(userState) {
  const n = userState.detectChunks.length;
  if (n === 0) return Buffer.alloc(0);
  if (n === 1) return userState.detectChunks[0];
  return Buffer.concat(userState.detectChunks, userState.detectBytes);
}

/**
 * 清空偵測滑動視窗（喚醒成功後呼叫）。
 * @param {object} userState
 */
function clearDetectBuffer(userState) {
  userState.detectChunks = [];
  userState.detectBytes  = 0;
  markStreamBroken(userState);
}

// ══════════════════════════════════════════════════════════
// 退訂使用者音訊（完整釋放）
// ══════════════════════════════════════════════════════════
function unsubscribeUser(guildId, userId) {
  const state = guildStates.get(guildId);
  if (!state) return;

  const userState = state.users.get(userId);
  if (!userState) return;

  if (userState.detectTimer) {
    clearInterval(userState.detectTimer);
    userState.detectTimer = null;
  }

  userState.isDetecting        = false;
  userState.isDetectingRequest = false;
  userState.detectChunks       = [];
  userState.recordChunks       = [];
  userState.detectBytes        = 0;
  userState.recordBytes        = 0;
  markStreamBroken(userState);
  userState._lastSilenceChunksLen = -1;
  userState._lastSilenceRMS       = 0;

  const pcmStream  = userState.stream;
  const opusStream = userState.opusStream;

  userState.stream     = null;
  userState.opusStream = null;

  state.users.delete(userId);

  try { pcmStream?.removeAllListeners();  } catch {}
  try { pcmStream?.destroy();             } catch {}
  try { opusStream?.removeAllListeners(); } catch {}
  try { opusStream?.destroy();            } catch {}
}

// ══════════════════════════════════════════════════════════
// Idle 清理定時器
// ══════════════════════════════════════════════════════════
function startUserIdleCleanup(guildId, state) {
  if (state._userCleanupTimer) return;

  state._userCleanupTimer = setInterval(() => {
    if (!state.active) return;

    const now      = Date.now();
    const toRemove = [];

    for (const [uid, us] of state.users.entries()) {
      if (
        !state.isExclusive &&
        !us.isDetecting &&
        !us.isDetectingRequest &&
        now - us.lastActive > STT_USER_IDLE_MS
      ) {
        toRemove.push(uid);
      }
    }

    for (const uid of toRemove) {
      console.log(`[STT] 清理閒置使用者音訊訂閱：${uid}`);
      unsubscribeUser(guildId, uid);
    }
  }, STT_USER_CLEANUP_INTERVAL_MS);
}

// ══════════════════════════════════════════════════════════
// 訂閱使用者音訊
// ══════════════════════════════════════════════════════════
function subscribeUser(guildId, userId, member) {
  const state = guildStates.get(guildId);
  if (!state || state.users.has(userId)) return;

  const { connection } = state;
  if (!connection?.receiver) return;

  const userState = {
    member,
    detectChunks:  [],
    detectBytes:   0,
    pendingChunks: [],   // 尚未送給 OWW 的增量音訊
    pendingBytes:  0,
    streamBroken:  true, // 新訂閱的使用者第一次偵測要送整個視窗並 reset
    recordChunks:  [],
    recordBytes:   0,
    stream:        null,
    opusStream:    null,
    cooldownUntil: 0,
    isDetecting:   false,
    isDetectingRequest: false,
    detectTimer:   null,
    lastActive:    Date.now(),
    _lastSilenceChunksLen: -1,
    _lastSilenceRMS:        0,
  };

  state.users.set(userId, userState);

  let opusStream, pcmStream;

  try {
    opusStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    userState.opusStream = opusStream;

    pcmStream = opusStream.pipe(
      new prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 960 })
    );

    userState.stream = pcmStream;
  } catch (err) {
    console.error(`[STT] 建立音訊訂閱失敗 [${userId}]: ${err.message}`);
    unsubscribeUser(guildId, userId);
    return;
  }

  pcmStream.on('data', (chunk) => {
    userState.lastActive = Date.now();
    if (!state.active) return;

    // 獨佔模式：只錄指定使用者
    if (state.isExclusive) {
      if (userId === state.exclusiveUserId && state.isRecording) {
        userState.recordChunks.push(chunk);
        userState.recordBytes += chunk.length;

        while (userState.recordBytes > MAX_RECORD_BYTES && userState.recordChunks.length > 0) {
          const dropped = userState.recordChunks.shift();
          userState.recordBytes -= dropped.length;
        }
        userState._lastSilenceChunksLen = -1;
      }
      return;
    }

    // 喚醒偵測模式：使用增量維護的滑動視窗
    // [修正 JS-2] 改用 pushDetectChunk，避免每次 triggerDetection 重新 concat
    pushDetectChunk(userState, chunk);
  });

  pcmStream.on('error', (err) => {
    console.error(`[STT] PCM 錯誤 [${userId}]: ${err.message}`);
    unsubscribeUser(guildId, userId);
  });

  const onEndLike = () => unsubscribeUser(guildId, userId);
  opusStream.once('end',   onEndLike);
  opusStream.once('close', onEndLike);
  opusStream.once('error', () => onEndLike());

  console.log(`[STT] 監聽：${member?.displayName || userId}`);
}

// ══════════════════════════════════════════════════════════
// 建立 / 取得 Guild State
// ══════════════════════════════════════════════════════════
function createGuildState(connection, guild, textChannel, onWakeup, extra = {}) {
  return {
    active:           true,
    connection,
    guild,
    textChannel,
    onWakeup,
    users:            new Map(),
    isExclusive:      false,
    exclusiveUserId:  null,
    isRecording:      false,
    recordTimer:      null,
    _onSpeakingStart: null,
    _onSpeakingEnd:   null,
    _memTimer:        null,
    _userCleanupTimer: null,
    ...extra,
  };
}

function exitExclusiveMode(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;

  state.isExclusive     = false;
  state.exclusiveUserId = null;
  state.isRecording     = false;

  if (state.recordTimer) {
    clearTimeout(state.recordTimer);
    state.recordTimer = null;
  }
}

module.exports = {
  guildStates,
  getCachedRecentRMS,
  resetAllRecordBuffers,
  pushDetectChunk,
  clearDetectBuffer,
  getDetectBuffer,
  takeDetectPayload,
  markStreamBroken,
  unsubscribeUser,
  subscribeUser,
  startUserIdleCleanup,
  createGuildState,
  exitExclusiveMode,
};
