// 統一佇列 — 隨機連播的洗牌袋與插播。

const { _engines, queues, nowPlaying } = require('./state');
const logger = require('../../../utils/logger');

// ════════════════════════════════════════════════════════
//  隨機連播 — 洗牌袋（Shuffle Bag）
// ════════════════════════════════════════════════════════
const shuffleBags = new Map();

function _shuffleArray(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function _generateShuffleBag(files, avoidFilename) {
  const shuffled = _shuffleArray(files);

  if (avoidFilename && shuffled.length > 1 && shuffled[0].filename === avoidFilename) {
    const swapIndex = 1 + Math.floor(Math.random() * (shuffled.length - 1));
    [shuffled[0], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[0]];
  }

  return shuffled;
}

function resetShuffleBag(guildId) {
  shuffleBags.delete(guildId);
}

function _pickRandomLocalTrack(guildId) {
  const engine = _engines.local;
  if (!engine) return null;

  const files = engine.getMusicFiles();
  if (files.length === 0) {
    shuffleBags.delete(guildId);
    return null;
  }

  let state = shuffleBags.get(guildId);

  // 只清掉「已經不存在的檔案」（例如被刪除），不因為「新增檔案」
  // （例如線上歌曲插播後被快取進 data/music/cache）而讓當輪重洗。
  // 新加入的檔案要等這輪 bag 播完、開新一輪時才會被 getMusicFiles() 掃進來。
  if (state) {
    const currentFilenames = new Set(files.map(f => f.filename));
    state.bag = state.bag.filter(f => currentFilenames.has(f.filename));
  }

  if (!state || state.bag.length === 0) {
    const avoidFilename = state?.lastPlayed ?? nowPlaying.get(guildId)?.item?.filename;
    state = {
      bag: _generateShuffleBag(files, avoidFilename),
      lastPlayed: avoidFilename,
    };
    logger.info('UnifiedQueue', `🔀 隨機連播開始新一輪洗牌 (${guildId})，共 ${files.length} 首`);
  }

  const picked = state.bag.shift();
  state.lastPlayed = picked.filename;
  shuffleBags.set(guildId, state);

  return {
    ...picked,
    title: picked.name,
    type: 'local',
  };
}

// ════════════════════════════════════════════════════════
//  【新增】隨機連播中，優先播放使用者手動加入佇列的歌曲
//
//  修正問題：先前 enqueue() 允許在隨機連播模式下把歌塞進 queue，
//  但 Idle / error 分支從不讀取 queue，導致手動點的歌永久卡死、
//  被靜默吞掉，使用者完全不會發現。
//
//  規則：
//  1. 每次要決定「隨機連播的下一首」時，先看 queue 是否有歌。
//  2. 有 → 視為「插播」，優先播放，計入正常播放次數（countPlay: true），
//     並用專屬 embed 提示使用者（避免跟真正的隨機挑選混淆）。
//  3. 沒有 → 才照原本邏輯呼叫 _pickRandomLocalTrack() 隨機挑歌。
// ════════════════════════════════════════════════════════
function _dequeueManualRequest(guildId) {
  const queue = queues.get(guildId) || [];
  if (queue.length === 0) return null;
  const next = queue.shift();
  queues.set(guildId, queue);

  // 插播的若是「本地歌曲」，代表它本來就已經在當輪的洗牌袋裡，
  // 提前把它從 bag 中移除，避免同一輪內被重複挑到、重播第二次。
  // （線上歌曲不在 bag 裡，不受影響；bag 剩餘順序完全不變。）
  if (next?.type === 'local' && next.filename) {
    const state = shuffleBags.get(guildId);
    if (state) {
      const before = state.bag.length;
      state.bag = state.bag.filter(f => f.filename !== next.filename);
      if (state.bag.length !== before) {
        state.lastPlayed = next.filename;
        logger.info('UnifiedQueue', `🔀 插播本地歌「${next.title}」已從本輪洗牌袋移除，避免重播`);
      }
    }
  }

  return next;
}

module.exports = {
  _pickRandomLocalTrack,
  _dequeueManualRequest,
  resetShuffleBag,
};
