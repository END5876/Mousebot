// handlers/unifiedQueue/playback.js
// 統一佇列 — 播放核心：控制面板、播放器生命週期、佇列播放、語音連線管理

const { getVoiceConnection, createAudioPlayer, AudioPlayerStatus } = require('@discordjs/voice');
const { setMusicPlayer, stopMusicLayer, isTTSActive } = require('../../audioManager');
const {
  _engines,
  queues,
  nowPlaying,
  loopSettings,
  controlMsgs,
  connections,
  randomPlaySettings,
  resetLoopAllCycle,
  getLoopAllCycleSeen,
} = require('./state');
const session = require('./session');
const logger = require('../../../utils/logger');
const { md } = require('../../../utils/markdown');
const { requestChannels, _getNotifyChannel, getRequestChannel } = require('./requestChannels');
const {
  updateControlPanel, _endControlPanel, _buildEmbed, _buildButtons, buildQueueView, refreshControlPanel,
} = require('./controlPanel');
const { _pickRandomLocalTrack, _dequeueManualRequest, resetShuffleBag } = require('./shuffleBag');
const {
  _connectTo, _createPersistentIdleHandler, ensureConnection, adoptExistingConnection, rebindConnection,
} = require('./connection');

// ════════════════════════════════════════════════════════
//  持久化快照（session.js 在寫檔時呼叫）
// ════════════════════════════════════════════════════════
function _buildSessionSnapshot() {
  const snapshot = {};
  for (const [guildId, np] of nowPlaying) {
    const connection = connections.get(guildId) || getVoiceConnection(guildId);
    const voiceChannelId = connection?.joinConfig?.channelId;
    if (!voiceChannelId) continue;

    snapshot[guildId] = {
      voiceChannelId,
      textChannelId: requestChannels.get(guildId)?.id ?? null,
      current: session.serializeItem(np.item),
      queue: (queues.get(guildId) || []).map(session.serializeItem).filter(Boolean),
      loopMode: loopSettings.get(guildId) || 'off',
      randomPlay: randomPlaySettings.get(guildId) || false,
      savedAt: Date.now(),
    };
  }
  return snapshot;
}
session.setSnapshotProvider(_buildSessionSnapshot);

// ════════════════════════════════════════════════════════
//  預先下載：佇列最前面幾首的線上歌曲，在目前這首播放時先下載＋正規化成快取檔。
//  趕在輪到它之前完成，playStream 就會命中快取直接播本地檔；沒趕上照常串流。
//  點歌入列、換歌（佇列往前移）、網頁調整佇列順序後呼叫。
// ════════════════════════════════════════════════════════
const PREFETCH_AHEAD = 2;

function prefetchUpcoming(guildId) {
  const engine = _engines.bilibili;
  if (typeof engine?.prefetch !== 'function' || !nowPlaying.has(guildId)) return;

  const upcoming = (queues.get(guildId) || []).slice(0, PREFETCH_AHEAD);
  for (const item of upcoming) {
    if (item?.type !== 'bilibili') continue;
    engine.prefetch(item, {
      // 輪到下載時再確認：還在播放、這首也還在佇列前面（沒被移除、清空、停止）
      isWanted: () => nowPlaying.has(guildId)
        && (queues.get(guildId) || []).slice(0, PREFETCH_AHEAD).some(q => q.url === item.url),
    });
  }
}

// ════════════════════════════════════════════════════════
//  核心播放
// ════════════════════════════════════════════════════════
// 連續幾首都放不出來就停止（例如共用音樂庫掛掉、每首都下載失敗），
// 不然隨機連播會無限換歌、每秒洗一則錯誤訊息。有一首真的開始播放就歸零。
const MAX_CONSECUTIVE_PLAY_ERRORS = 5;
const playErrorCounts = new Map();

async function _playItem(guildId, item, channel, { silent = false, countPlay = true } = {}) {
  const connection = connections.get(guildId) || getVoiceConnection(guildId);
  if (!connection) {
    logger.error('UnifiedQueue', '無語音連線');
    return;
  }

  const notifyChannel = _getNotifyChannel(guildId, channel);

  // maxMissedFrames：預設連續 5 幀（0.1 秒）讀不到音訊就 stop()，當成播完換下一首。
  // 直播的音訊是即時進來的，網路抖動就會斷 0.2～0.4 秒 → 播幾秒就被跳過（VPS 實測 4～11 秒）。
  // 放寬到 250 幀（5 秒）：短暫斷音只會靜音一下再接上；串流真的結束時走「resource 已結束」的判斷，不受影響。
  const player = createAudioPlayer({ behaviors: { maxMissedFrames: 250 } });
  // 每個 player 只換一次歌：串流錯誤時 'error' 之後緊接著 Idle，兩邊都換會一次吃掉兩首
  let advanced = false;
  // 這首出錯了：交給 'error' 監聽器換歌，也不再單曲循環／列表循環重播這首壞掉的歌
  let failed = false;

  // ── 換下一首（播放結束或出錯後）────────────────────
  const _advance = async () => {
    const current = nowPlaying.get(guildId);
    if (!current || current.player !== player || advanced) return;
    advanced = true;

    const loopMode = loopSettings.get(guildId) || 'off';
    const isRandomPlay = randomPlaySettings.get(guildId) || false;
    const sendTo = _getNotifyChannel(guildId, channel);

    // 單曲循環：自然播完就重播同一首。
    // 使用者按了「跳過」（skipCurrent）時改播下一首，單曲循環保持開著、套用到新歌；
    // 只有沒有下一首可播（不是隨機連播、佇列也空了）時才重播目前這首
    const skipped = !!current.skipped;
    const nothingNext = !isRandomPlay && (queues.get(guildId) || []).length === 0;
    if (loopMode === 'one' && !failed && (!skipped || nothingNext)) {
      await _playItem(guildId, item, channel, { silent: true, countPlay: false });
      return;
    }

    // 隨機連播模式
    if (isRandomPlay) {
      // 🆕 優先檢查佇列：使用者手動點的歌不該被隨機邏輯吞掉
      const manualNext = _dequeueManualRequest(guildId);
      if (manualNext) {
        logger.info('UnifiedQueue', `🎵 隨機連播中插播使用者點歌: ${manualNext.title}`);

        // 手動點歌視為正常請求，計入播放次數；面板就地換成這首（隨機連播的說明在面板裡）
        await _playItem(guildId, manualNext, channel, { silent: false, countPlay: true });
        await updateControlPanel(guildId, channel, { preferEdit: true });
        return;
      }

      // 佇列沒有手動點歌，才走原本的隨機挑選邏輯
      const next = _pickRandomLocalTrack(guildId);
      if (!next) {
        logger.success('UnifiedQueue', '隨機連播：找不到本地音樂，停止');
        stopAll(guildId);
        sendTo.send('ℹ️ 音樂庫裡沒有歌了，隨機連播已停止。').catch(() => {});
        return;
      }

      // 隨機連播播出的曲目不計入播放次數排序
      await _playItem(guildId, next, channel, { silent: false, countPlay: false });
      await updateControlPanel(guildId, channel, { preferEdit: true });
      return;
    }

    const queue = queues.get(guildId) || [];
    const isLoopAll = loopMode === 'all';

    if (isLoopAll && !failed) queue.push(item);

    if (queue.length > 0) {
      const next = queue.shift();
      queues.set(guildId, queue);

      if (!isLoopAll) logger.info('UnifiedQueue', `⏭️ 播放下一首: ${next.title}`);

      let countPlay = true;
      if (isLoopAll && next.type === 'local' && next.filename) {
        const seen = getLoopAllCycleSeen(guildId);
        if (seen.has(next.filename)) {
          countPlay = false;
        } else {
          seen.add(next.filename);
        }
      }

      await _playItem(guildId, next, channel, { silent: isLoopAll, countPlay });
      await updateControlPanel(guildId, channel, { preferEdit: true });
    } else {
      logger.success('UnifiedQueue', '播放完畢，佇列為空');
      stopAll(guildId, { reason: failed ? 'stopped' : 'finished' });
      if (!failed) sendTo.send('✅ 所有歌曲播放完畢').catch(() => {});
    }
  };

  // ── Idle：播放結束後的邏輯 ───────────────────────────
  player.on(AudioPlayerStatus.Idle, () => {
    if (failed) return; // 出錯造成的 Idle：'error' 監聽器已排好換歌
    _advance();
  });

  player.on(AudioPlayerStatus.Playing, () => {
    if (nowPlaying.get(guildId)?.player === player) playErrorCounts.delete(guildId);
  });

  // ── 錯誤處理 ─────────────────────────────────────────
  player.on('error', (err) => {
    // 已被換掉／停止的舊 player（引擎重試完才回報的錯誤）不能再動目前的佇列
    if (nowPlaying.get(guildId)?.player !== player) return;
    if (err.message?.includes('aborted') || err.message?.includes('premature close')) return;
    logger.error('UnifiedQueue', `播放器錯誤 (${guildId}):`, err.message);
    const sendTo = _getNotifyChannel(guildId, channel);
    failed = true;

    const errorCount = (playErrorCounts.get(guildId) || 0) + 1;
    playErrorCounts.set(guildId, errorCount);
    if (errorCount >= MAX_CONSECUTIVE_PLAY_ERRORS) {
      logger.error('UnifiedQueue', `連續 ${errorCount} 首播放失敗，停止播放 (${guildId})`);
      stopAll(guildId);
      sendTo.send(`⚠️ 連續 ${errorCount} 首都播不出來，已停止播放。請確認網址或網路，再用 /play 點一次。`).catch(() => {});
      return;
    }

    sendTo.send(`⚠️ **${md(item.title)}** 播不出來，已跳到下一首。`).catch(() => {});

    // 串流錯誤時 @discordjs/voice 會在 emit('error') 之後把 player 切到 Idle；引擎自己 emit 的錯誤
    // （下載失敗、重試用盡）則可能已經是 Idle。兩種都只在這裡換一次歌，
    // 1 秒後 _advance 會再確認這期間沒有被停止或換歌
    setTimeout(_advance, 1000);
  });

  nowPlaying.set(guildId, { player, item });
  session.schedule();

  try {
    if (item.type === 'bilibili') {
      const engine = _engines.bilibili;
      if (!engine) throw new Error('bilibili engine 未注入');
      await engine.playStream(guildId, item, player, { silent });
    } else {
      const engine = _engines.local;
      if (!engine) throw new Error('local engine 未注入');
      await engine.playStream(guildId, item, player, { silent, countPlay });
    }
  } catch (err) {
    // 技術細節（yt-dlp、engine 的錯誤）只寫 log，頻道裡寫使用者能做什麼
    logger.error('UnifiedQueue', `引擎啟動失敗（${item.title}）：`, err.message);
    notifyChannel.send(item.type === 'bilibili'
      ? `⚠️ **${md(item.title)}** 播不出來，可能是私人影片、有地區限制或網址打錯。請換一個網址，或改用關鍵字搜尋。`
      : `⚠️ **${md(item.title)}** 現在播不了，可能檔案已被移除。請用 /play 換一首。`).catch(() => {});
    if (nowPlaying.get(guildId)?.player === player) nowPlaying.delete(guildId);
    return;
  }

  // 載入（下載）期間已被停止或換歌：stopAll 對還在 Idle 的 player 呼叫 stop() 沒有作用，
  // 不擋下來的話這首會照樣訂閱播出，而且沒有任何控制鍵停得掉
  const current = nowPlaying.get(guildId);
  if (current?.player !== player) {
    try { player.stop(true); } catch {}
    return;
  }
  // 載入期間按了跳過（見 skipCurrent）：現在才真的停下，交給 Idle 換下一首
  if (current.skipRequested) {
    player.stop(true);
    return;
  }

  setMusicPlayer(guildId, player, undefined, silent);

  if (!silent) {
    logger.info('UnifiedQueue', `🎵 開始播放: ${item.title} [${item.type}] (${guildId})`);
  }

  // 佇列往前移了一首，補上新的「下一首」
  prefetchUpcoming(guildId);
}

// ════════════════════════════════════════════════════════
//  停止
// ════════════════════════════════════════════════════════
// reason：'stopped'（停止鍵、閒置停播、連續失敗）| 'finished'（佇列播完）
//        | 'restart'（停掉後馬上重新開始播，例如 /music random：舊面板直接刪掉，不留「已停止」）
function stopAll(guildId, { reason = 'stopped' } = {}) {
  const np = nowPlaying.get(guildId);
  const panel = controlMsgs.get(guildId);

  // ⚠️ 順序很重要：必須先清空 nowPlaying（以及其他狀態），
  // 再呼叫 player.stop(true)。
  // 因為 stop(true) 會同步觸發 _playItem() 裡註冊的 'Idle' 監聽器，
  // 那個監聽器會用 nowPlaying.get(guildId) 是否還等於當前 player
  // 來判斷「是自然播完該接下一首」還是「已經被外部停止」。
  // 若先呼叫 stop() 才刪 nowPlaying，監聽器會誤判成播完，
  // 因而先接了下一首（隨機/佇列），導致停止鍵要等下一首播完才真的停。
  nowPlaying.delete(guildId);
  queues.delete(guildId);
  loopSettings.delete(guildId);
  controlMsgs.delete(guildId);
  randomPlaySettings.delete(guildId);
  resetShuffleBag(guildId);
  resetLoopAllCycle(guildId);
  playErrorCounts.delete(guildId);

  if (np) {
    try { np.player.stop(true); } catch {}
  }
  stopMusicLayer(guildId);

  if (_engines.bilibili && typeof _engines.bilibili.clearErrorCount === 'function') {
    _engines.bilibili.clearErrorCount(guildId);
  }
  if (_engines.bilibili && typeof _engines.bilibili.resetYtClient === 'function') {
    _engines.bilibili.resetYtClient(guildId);
  }
  session.schedule();

  _endControlPanel(guildId, panel, np?.item, reason);

  logger.info('UnifiedQueue', `⏹️ 停止播放 (${guildId})`);
}

// ════════════════════════════════════════════════════════
//  跳過目前這首（交給 Idle 依循環 / 隨機連播 / 佇列決定下一首）
// ════════════════════════════════════════════════════════
function skipCurrent(guildId) {
  const np = nowPlaying.get(guildId);
  if (!np) return false;
  // 使用者主動跳過：單曲循環時 _advance 要換下一首，而不是重播這首
  np.skipped = true;
  // 還在載入（下載中）的 player 仍是 Idle，stop() 沒有作用：先記下來，載入完成後 _playItem 再跳過
  if (!np.player.stop()) np.skipRequested = true;
  return true;
}

// 單曲循環時按「跳過」的回覆（面板按鈕、/music skip、網頁遙控共用），要在 skipCurrent 之前呼叫：
// 佇列有歌 → 跳到下一首，單曲循環保持開著；佇列空了 → 從頭重播目前這首
function loopOneSkipText(guildId) {
  const next = (queues.get(guildId) || [])[0];
  if (next) return `⏭️ 跳到「${md(next.title)}」，單曲循環還開著。`;
  const title = nowPlaying.get(guildId)?.item?.title ?? '';
  return `🔂 佇列裡沒有下一首，從頭重播「${md(title)}」。單曲循環還開著。`;
}

// ════════════════════════════════════════════════════════
//  暫停 / 繼續（使用者手動）
//  回傳 'ok' | 'none'（沒在播）| 'already'（已是該狀態）| 'busy'（TTS／報時插播中或還在載入）
// ════════════════════════════════════════════════════════
function pauseCurrent(guildId) {
  const np = nowPlaying.get(guildId);
  if (!np) return 'none';
  const status = np.player.state.status;
  if (status === AudioPlayerStatus.Paused) return 'already';
  if (isTTSActive(guildId) || status !== AudioPlayerStatus.Playing) return 'busy';
  return np.player.pause() ? 'ok' : 'busy';
}

function resumeCurrent(guildId) {
  const np = nowPlaying.get(guildId);
  if (!np) return 'none';
  const status = np.player.state.status;
  if (status === AudioPlayerStatus.Playing) return 'already';
  if (isTTSActive(guildId) || status !== AudioPlayerStatus.Paused) return 'busy';
  return np.player.unpause() ? 'ok' : 'busy';
}

// ════════════════════════════════════════════════════════
//  公開：加入佇列 / 立即播放
// ════════════════════════════════════════════════════════
async function enqueue(guildId, item, channel) {
  requestChannels.set(guildId, channel);

  if (nowPlaying.has(guildId)) {
    const queue = queues.get(guildId) || [];
    queue.push(item);
    queues.set(guildId, queue);
    session.schedule();
    prefetchUpcoming(guildId);

    // 🆕 若目前是隨機連播模式，補充提示：這首歌會在下一次切歌時優先插播
    const isRandomPlay = randomPlaySettings.get(guildId) || false;
    logger.info('UnifiedQueue', `➕ 加入佇列: ${item.title} (位置 ${queue.length})${isRandomPlay ? '（隨機連播中，將優先插播）' : ''}`);
    return { queued: true, position: queue.length, willInterruptRandom: isRandomPlay };
  } else {
    queues.set(guildId, []);
    await _playItem(guildId, item, channel);
    return { queued: false };
  }
}

// ════════════════════════════════════════════════════════
//  公開：立即隨機播放一首本地音樂（/music randomplay 用）
// ════════════════════════════════════════════════════════
async function playRandomLocal(guildId, channel, { enableContinuous = false } = {}) {
  requestChannels.set(guildId, channel);

  resetShuffleBag(guildId);

  const track = _pickRandomLocalTrack(guildId);
  if (!track) return null;

  queues.set(guildId, []);

  if (enableContinuous) {
    randomPlaySettings.set(guildId, true);
    loopSettings.set(guildId, 'off');
  }

  await _playItem(guildId, track, channel, { countPlay: !enableContinuous });
  return track;
}

// ════════════════════════════════════════════════════════
//  重啟後恢復播放
// ════════════════════════════════════════════════════════
/**
 * 讀取上次關閉前的播放快照並接續播放。須在線上 / 本地引擎都注入後呼叫。
 * 略過條件：語音頻道已不存在、頻道裡沒有真人、Bot 已在同伺服器的其他頻道（例如 autojoin）。
 * @param {import('discord.js').Client} client
 */
async function resumeSavedSessions(client) {
  let saved;
  try {
    saved = session.takeSavedSessions();
  } catch (err) {
    logger.warn('MusicSession', `讀取播放快照失敗：${err.message}`);
    return 0;
  }

  let resumed = 0;
  for (const s of saved) {
    try {
      const guild = client.guilds.cache.get(s.guildId);
      const voiceChannel = guild && await guild.channels.fetch(s.voiceChannelId).catch(() => null);
      if (!voiceChannel?.isVoiceBased()) continue;
      if (!voiceChannel.members.some(m => !m.user.bot)) continue;
      if (nowPlaying.has(s.guildId)) continue;

      const existing = getVoiceConnection(s.guildId);
      if (existing && existing.joinConfig.channelId !== voiceChannel.id) continue;

      // 原本的點歌頻道找不到時，改用語音頻道內建的文字聊天（後續通知都會送到這裡）
      const savedTextChannel = s.textChannelId
        ? await guild.channels.fetch(s.textChannelId).catch(() => null)
        : null;
      const textChannel = savedTextChannel?.isTextBased() ? savedTextChannel : voiceChannel;

      const connection = await _connectTo({ guild, voiceChannel, textChannel, client });
      if (!connection) continue;

      queues.set(s.guildId, s.queue);
      loopSettings.set(s.guildId, s.loopMode);
      if (s.randomPlay) randomPlaySettings.set(s.guildId, true);

      await _playItem(s.guildId, s.current, textChannel, { countPlay: false });
      if (!nowPlaying.has(s.guildId)) continue;

      resumed++;
      logger.info('MusicSession', `已恢復 ${guild.name} 的播放：${s.current.title}（佇列 ${s.queue.length} 首）`);
      await textChannel.send(`🔄 Bot 重新啟動，已接續播放 **${md(s.current.title)}**（佇列 ${s.queue.length} 首）`).catch(() => {});
      await updateControlPanel(s.guildId, textChannel);
    } catch (err) {
      logger.warn('MusicSession', `恢復 ${s.guildId} 的播放失敗：${err.message}`);
    }
  }
  return resumed;
}

// ════════════════════════════════════════════════════════
//  查詢
// ════════════════════════════════════════════════════════
function isPlaying(guildId) { return nowPlaying.has(guildId); }
function getNowPlaying(guildId) { return nowPlaying.get(guildId)?.item ?? null; }

module.exports = {
  loopOneSkipText,
  buildQueueView,
  _buildEmbed,
  _buildButtons,
  refreshControlPanel,
  updateControlPanel,
  stopAll,
  _createPersistentIdleHandler,
  enqueue,
  prefetchUpcoming,
  ensureConnection,
  isPlaying,
  getNowPlaying,
  playRandomLocal,
  resetShuffleBag,
  resumeSavedSessions,
  getRequestChannel,
  adoptExistingConnection,
  rebindConnection,
  skipCurrent,
  pauseCurrent,
  resumeCurrent,
};