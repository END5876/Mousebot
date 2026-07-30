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
  if (state.players.silence) return;

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
function setMusicPlayer(guildId, player, onEnd, silent = false) {
  const state = getState(guildId);

  if (state.players.music && state.players.music !== player) {
    try { state.players.music.stop(); } catch {}
  }
  state.players.music = player;

  player.on(AudioPlayerStatus.Idle, () => {
    if (state.players.music === player) {
      delete state.players.music;
      if (state.activeLayer === 'music') {
        if (typeof _fallbackToSilence === 'function') _fallbackToSilence(guildId);
      }
      onEnd?.();
    }
  });

  // TTS 播放中 → 音樂先暫停等待
  if (state.activeLayer === 'tts') {
    if (!silent) console.log(`⏸️ [AudioManager] TTS 播放中，音樂等待 (${guildId})`);
    state.musicPaused = true;
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
//
//  ★ 修改重點 ★
//  原本每一段 TTS 都會建立新 player 並重新 subscribe，
//  播完又立刻 subscribe 回音樂，造成「一段一暫停」的音樂閃爍。
//
//  新設計：整個 TTS 佇列共用「同一個 player」，
//  只有在佇列真正開始 / 真正清空時才切換 subscribe，
//  段落之間完全不動音頻層，音樂自然不會忽開忽停。
// ════════════════════════════════════════════════════

function _ensureTTSPlayer(guildId) {
  const state = getState(guildId);
  if (state.players.tts) return state.players.tts;

  const player = createAudioPlayer();
  state.players.tts = player;

  player.on('error', (err) => {
    console.error(`❌ [AudioManager] TTS 播放錯誤 (${guildId}):`, err.message);
  });

  return player;
}

/**
 * 進入 TTS 層（整個 TTS 佇列開始播放時呼叫一次）。
 * 具冪等性：若已經在 TTS 層，直接回傳，不會重複觸發音樂暫停。
 */
function enterTTSLayer(guildId) {
  const state = getState(guildId);
  const connection = getVoiceConnection(guildId);
  if (!connection) return false;

  if (state.activeLayer === 'tts') return true; // 已在 TTS 層，避免重複切換

  if (state.activeLayer === 'music' && state.players.music) {
    console.log(`⏸️ [AudioManager] 音樂暫停，TTS 插播 (${guildId})`);
    state.musicPaused = true;
  }

  const player = _ensureTTSPlayer(guildId);
  _subscribe(guildId, player);
  state.activeLayer = 'tts';
  console.log(`🎙️ [AudioManager] 進入 TTS 層 (${guildId})`);
  return true;
}

/**
 * 播放單一 TTS 片段。
 * 重複使用同一個 player，完全不碰 subscribe，
 * 因此段落之間不會影響其他音頻層。
 * @param {string}   guildId
 * @param {string}   filename
 * @param {Function} onSegmentEnd  此片段播完的回調
 */
function playTTSSegment(guildId, filename, onSegmentEnd) {
  const state = getState(guildId);
  const connection = getVoiceConnection(guildId);
  if (!connection) return false;

  const player = _ensureTTSPlayer(guildId);
  const resource = createAudioResource(filename, { inputType: StreamType.Arbitrary });

  // 用 one-shot listener，避免同一個 player 反覆 play() 造成監聽器堆疊
  const onIdle = () => {
    player.removeListener(AudioPlayerStatus.Idle, onIdle);
    onSegmentEnd?.();
  };
  player.on(AudioPlayerStatus.Idle, onIdle);

  player.play(resource);
  return true;
}

/**
 * 離開 TTS 層（整個 TTS 佇列真正清空時才呼叫）。
 * 銷毀 TTS player，並恢復音樂或退回靜音層。
 */
function exitTTSLayer(guildId) {
  const state = getState(guildId);
  if (state.players.tts) {
    try { state.players.tts.stop(); } catch {}
    delete state.players.tts;
  }
  if (state.activeLayer === 'tts') {
    _restoreAfterTTS(guildId);
  }
}

// ════════════════════════════════════════════════════
//  內部：層級恢復
// ════════════════════════════════════════════════════
function _restoreAfterTTS(guildId) {
  const state = getState(guildId);
  if (state.players.music && state.musicPaused) {
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
  enterTTSLayer,
  playTTSSegment,
  exitTTSLayer,
  cleanupGuild,
  getActiveLayer,
  hasMusicPlaying,
};