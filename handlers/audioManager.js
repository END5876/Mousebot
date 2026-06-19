// handlers/audioManager.js
// 統一音頻排程器 — 解決多 Handler 搶佔 connection.subscribe() 的衝突

const {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  getVoiceConnection,
} = require('@discordjs/voice');
const { Readable } = require('stream');

// ── 優先級常數 ────────────────────────────────────────
const PRIORITY = { SILENCE: 0, MUSIC: 1, TTS: 2 };

// ── 每個 Guild 的狀態 ─────────────────────────────────
// {
//   activeLayer: 'silence' | 'music' | 'tts' | null,
//   players: { silence, music, tts },   // 各層 AudioPlayer
//   onTTSEnd: Function | null,          // TTS 結束後的回調
//   musicPaused: Boolean,               // TTS 插播時暫停音樂
// }
const guildStates = new Map();

function getState(guildId) {
  if (!guildStates.has(guildId)) {
    guildStates.set(guildId, {
      activeLayer: null,
      players: {},
      onTTSEnd: null,
      musicPaused: false,
    });
  }
  return guildStates.get(guildId);
}

// ════════════════════════════════════════════════════
//  內部：切換 subscribe
// ════════════════════════════════════════════════════
function _subscribe(guildId, player) {
  const connection = getVoiceConnection(guildId);
  if (!connection) return false;
  connection.subscribe(player);
  return true;
}

// ════════════════════════════════════════════════════
//  靜音層（最低優先，常駐背景）
// ════════════════════════════════════════════════════
function _createSilenceStream() {
  const silence = Buffer.alloc(3840, 0);
  return new Readable({
    read() { this.push(silence); }
  });
}

function startSilenceLayer(guildId) {
  const state = getState(guildId);
  if (state.players.silence) return; // 已存在

  const player = createAudioPlayer();
  state.players.silence = player;

  const makeRes = () => {
    const r = createAudioResource(_createSilenceStream(), {
      inputType: StreamType.Raw,
      inlineVolume: true,
    });
    r.volume.setVolume(0.01);
    return r;
  };

  player.play(makeRes());
  player.on(AudioPlayerStatus.Idle, () => {
    if (state.players.silence) player.play(makeRes());
  });
  player.on('error', () => stopSilenceLayer(guildId));

  // 只有在沒有更高優先層時才 subscribe
  if (!state.activeLayer || state.activeLayer === 'silence') {
    _subscribe(guildId, player);
    state.activeLayer = 'silence';
  }
  console.log(`🔇 [AudioManager] 靜音層啟動 (${guildId})`);
}

function stopSilenceLayer(guildId) {
  const state = getState(guildId);
  if (state.players.silence) {
    try { state.players.silence.stop(); } catch {}
    delete state.players.silence;
  }
  if (state.activeLayer === 'silence') {
    state.activeLayer = null;
  }
  console.log(`⏹️ [AudioManager] 靜音層停止 (${guildId})`);
}

// ════════════════════════════════════════════════════
//  音樂層
// ════════════════════════════════════════════════════
/**
 * 設定音樂播放器（由 bilibiliHandler 建立好 player 後交給這裡接管）
 * @param {string} guildId
 * @param {AudioPlayer} player  - 已 play(resource) 的播放器
 * @param {Function} [onEnd]    - 播放結束回調
 * @param {boolean} [silent]    - 是否靜默執行 (不印 Log)
 */
function setMusicPlayer(guildId, player, onEnd, silent = false) {
  const state = getState(guildId);

  // 清掉舊的音樂播放器
  if (state.players.music && state.players.music !== player) {
    try { state.players.music.stop(); } catch {}
  }
  state.players.music = player;

  player.on(AudioPlayerStatus.Idle, () => {
    if (state.players.music === player) {
      delete state.players.music;
      if (state.activeLayer === 'music') {
        // 退回靜音層（如果有的話）
        // 註：請確保 _fallbackToSilence 函式存在於你的檔案中
        if (typeof _fallbackToSilence === 'function') _fallbackToSilence(guildId);
      }
      onEnd?.();
    }
  });

  // TTS 播放中 → 音樂先暫停等待
  if (state.activeLayer === 'tts') {
    if (!silent) console.log(`⏸️ [AudioManager] TTS 播放中，音樂等待 (${guildId})`);
    state.musicPaused = true;
    // 不 subscribe，等 TTS 結束後再接手
    return;
  }

  _subscribe(guildId, player);
  state.activeLayer = 'music';
  state.musicPaused = false;
  
  if (!silent) {
    console.log(`🎵 [AudioManager] 音樂層啟動 (${guildId})`);
  }
}

function stopMusicLayer(guildId) {
  const state = getState(guildId);
  if (state.players.music) {
    try { state.players.music.stop(); } catch {}
    delete state.players.music;
  }
  state.musicPaused = false;
  if (state.activeLayer === 'music') {
    _fallbackToSilence(guildId);
  }
  console.log(`⏹️ [AudioManager] 音樂層停止 (${guildId})`);
}

// ════════════════════════════════════════════════════
//  TTS 層（最高優先）
// ════════════════════════════════════════════════════
/**
 * 播放一個 TTS 音訊檔案
 * @param {string} guildId
 * @param {string} filename  - 暫存音訊路徑
 * @param {Function} onEnd   - 播放完畢回調（由 ttsHandler 的 processQueue 提供）
 * @returns {boolean}
 */
function playTTSLayer(guildId, filename, onEnd) {
  const state = getState(guildId);
  const connection = getVoiceConnection(guildId);
  if (!connection) return false;

  // 若音樂正在播放，先暫停（AudioPlayer 沒有 pause API，改用 stop 後記錄）
  if (state.activeLayer === 'music' && state.players.music) {
    console.log(`⏸️ [AudioManager] 音樂暫停，TTS 插播 (${guildId})`);
    state.musicPaused = true;
    // 不 stop 音樂 player，只是不讓它 subscribe
  }

  const player = createAudioPlayer();
  const resource = createAudioResource(filename, { inputType: StreamType.Arbitrary });

  player.play(resource);
  _subscribe(guildId, player);
  state.activeLayer = 'tts';
  state.players.tts = player;

  player.on(AudioPlayerStatus.Idle, () => {
    delete state.players.tts;
    // 恢復音樂或靜音
    _restoreAfterTTS(guildId);
    onEnd?.();
  });

  player.on('error', (err) => {
    console.error(`❌ [AudioManager] TTS 播放錯誤 (${guildId}):`, err.message);
    delete state.players.tts;
    _restoreAfterTTS(guildId);
    onEnd?.();
  });

  return true;
}

// ════════════════════════════════════════════════════
//  內部：層級恢復
// ════════════════════════════════════════════════════
function _restoreAfterTTS(guildId) {
  const state = getState(guildId);
  if (state.players.music && state.musicPaused) {
    // 音樂還活著，重新 subscribe
    _subscribe(guildId, state.players.music);
    state.activeLayer = 'music';
    state.musicPaused = false;
    console.log(`▶️ [AudioManager] 恢復音樂播放 (${guildId})`);
  } else {
    _fallbackToSilence(guildId);
  }
}

function _fallbackToSilence(guildId) {
  const state = getState(guildId);
  if (state.players.silence) {
    _subscribe(guildId, state.players.silence);
    state.activeLayer = 'silence';
    console.log(`🔇 [AudioManager] 退回靜音層 (${guildId})`);
  } else {
    state.activeLayer = null;
  }
}

// ════════════════════════════════════════════════════
//  清理（離開語音頻道時）
// ════════════════════════════════════════════════════
function cleanupGuild(guildId) {
  const state = getState(guildId);
  for (const player of Object.values(state.players)) {
    try { player.stop(); } catch {}
  }
  guildStates.delete(guildId);
  console.log(`🧹 [AudioManager] 清理完成 (${guildId})`);
}

// ════════════════════════════════════════════════════
//  查詢
// ════════════════════════════════════════════════════
function getActiveLayer(guildId) {
  return guildStates.get(guildId)?.activeLayer ?? null;
}

function hasMusicPlaying(guildId) {
  const s = guildStates.get(guildId);
  return !!(s?.players.music);
}

module.exports = {
  PRIORITY,
  startSilenceLayer,
  stopSilenceLayer,
  setMusicPlayer,
  stopMusicLayer,
  playTTSLayer,
  cleanupGuild,
  getActiveLayer,
  hasMusicPlaying,
};