'use strict';

const { getVoiceConnection } = require('@discordjs/voice');
const fs   = require('fs');
const path = require('path');

// audioManager 統一管理 TTS 層
// ★ 修改：改用 enterTTSLayer / playTTSSegment / exitTTSLayer
//   取代原本每段都重新 subscribe 的 playTTSLayer，
//   避免多段 TTS 播放時反覆搶佔 connection，導致音樂忽開忽停。
const { enterTTSLayer, playTTSSegment, exitTTSLayer } = require('../../audioManager');
const { splitSentences } = require('./textSplitter');
const { generateTTS } = require('./generate');
const { safeUnlink } = require('./cache');
const { detectLanguage } = require('./edgeTTS');

// ── TTS 排隊 Map ─────────────────────────────────────────
// 佇列項目結構升級：加入 readyPromise / file / status 欄位，
// 讓播放器能在「合成完成」後立即銜接，實現播放與合成真正並行。
const ttsQueues    = new Map();  // guildId → QueueItem[]
const ttsIsPlaying = new Map();  // guildId → boolean

// ════════════════════════════════════════════════════════
//  Pipeline 佇列處理
//
//  核心設計：
//  1. playTTS 將文字分段後，每段立即建立一個「佇列項目」並開始非同步合成
//  2. 佇列項目包含 readyPromise（合成完成的 Promise）
//  3. processQueue 等待隊首項目的 readyPromise，合成完成後立即播放
//  4. 播放下一段時，下一段的合成通常已在並行進行中（或已完成）
//
//  ★ 修改重點 ★
//  原本每一段都呼叫 playTTSLayer() 建立新 player 並重新 subscribe，
//  導致 5 段文字就會有 5 次「切到 TTS → 切回音樂」的動作，
//  音樂被瞬間切斷又恢復，聽起來就是「一下暫停一下開始」。
//
//  新流程：
//  - 整個佇列開始播放時，只呼叫一次 enterTTSLayer()（具冪等性）
//  - 每段呼叫 playTTSSegment()，共用同一個 player，不動 subscribe
//  - 只有佇列「真正清空」時才呼叫 exitTTSLayer()，恢復音樂/靜音
// ════════════════════════════════════════════════════════

/**
 * @typedef {Object} QueueItem
 * @property {string}  text
 * @property {string}  engine
 * @property {Promise<{file:string, engine:string, voice?:string, model?:string}>} readyPromise
 * @property {{file:string, engine:string, voice?:string, model?:string} | null} result
 * @property {boolean} failed
 */

async function processQueue(guildId) {
  const queue = ttsQueues.get(guildId);
  if (!queue || queue.length === 0) {
    ttsQueues.delete(guildId);
    ttsIsPlaying.delete(guildId);
    exitTTSLayer(guildId); // ★ 佇列已空，離開 TTS 層，恢復音樂/靜音
    return;
  }

  const connection = getVoiceConnection(guildId);
  if (!connection) {
    // 清理所有待播放項目（合成結果可能尚未完成，等 Promise settle 後刪除）
    const items = [...queue];
    ttsQueues.delete(guildId);
    ttsIsPlaying.delete(guildId);
    exitTTSLayer(guildId); // ★ 連線已斷，一併釋放 TTS 層
    for (const item of items) {
      item.readyPromise.then(r => { if (r?.file) safeUnlink(r.file); }).catch(() => {});
    }
    return;
  }

  ttsIsPlaying.set(guildId, true);

  // ★ 整段 TTS 佇列只在這裡「嘗試」進入 TTS 層一次；
  //   enterTTSLayer 具冪等性，若已在 TTS 層則直接返回，不會重複觸發音樂暫停。
  enterTTSLayer(guildId);

  const item = queue[0];

  // 等待隊首項目的合成完成（若已完成則立即繼續）
  let result;
  try {
    result = await item.readyPromise;
  } catch (err) {
    console.error(`❌ [TTS] 合成失敗，跳過此段: ${err.message}`);
    queue.shift();
    ttsIsPlaying.delete(guildId);
    if (queue.length === 0) exitTTSLayer(guildId); // ★ 真正清空才離開
    processQueue(guildId);
    return;
  }

  if (!result?.file) {
    queue.shift();
    ttsIsPlaying.delete(guildId);
    if (queue.length === 0) exitTTSLayer(guildId);
    processQueue(guildId);
    return;
  }

  // ★ 改用 playTTSSegment：共用同一個 TTS player，不會重新 subscribe，
  //   因此段落之間切換完全不影響音樂/靜音層。
  const ok = playTTSSegment(guildId, result.file, () => {
    safeUnlink(result.file);
    queue.shift();
    ttsIsPlaying.delete(guildId);
    if (queue.length === 0) exitTTSLayer(guildId); // ★ 只有整段序列播完才恢復音樂
    processQueue(guildId);
  });

  if (!ok) {
    safeUnlink(result.file);
    queue.shift();
    ttsIsPlaying.delete(guildId);
    if (queue.length === 0) exitTTSLayer(guildId);
    processQueue(guildId);
  }
}

// ════════════════════════════════════════════════════════
//  公開 API：playTTS
// ════════════════════════════════════════════════════════

/**
 * 主要入口。
 * 將文字分段，每段立即啟動非同步合成並加入佇列，
 * 第一段合成完成後立即開始播放，後續段落並行合成。
 */
async function playTTS(guildId, text) {
  const connection = getVoiceConnection(guildId);
  if (!connection) return { success: false, reason: 'no_connection' };

  const tempDir = path.join(__dirname, '../temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  // 分段
  const segments = splitSentences(text);
  if (segments.length === 0) return { success: false, reason: 'empty_text' };

  if (!ttsQueues.has(guildId)) ttsQueues.set(guildId, []);
  const queue     = ttsQueues.get(guildId);
  const wasEmpty  = queue.length === 0 && !ttsIsPlaying.has(guildId);

  // 記錄第一段的引擎資訊（用於回傳）
  let firstEngine = 'unknown';
  let firstModel  = null;
  let firstVoice  = null;

  // ✨ 新增一個變數來追蹤「上一個合成任務」，避免併發塞爆 SoVITS
  let lastGenerationPromise = Promise.resolve();

  // 將 Promise 串聯起來，確保 SoVITS 是一句接著一句合成
  for (let i = 0; i < segments.length; i++) {
    const seg      = segments[i];
    const baseFile = path.join(tempDir, `tts_${guildId}_${Date.now()}_${i}.tmp`);

    // ✨ 等待上一句「開始合成完畢」後，才啟動這一句的合成
    const readyPromise = lastGenerationPromise.then(() => {
      return generateTTS(seg, baseFile, guildId);
    }).then(result => {
      if (i === 0) {
        firstEngine = result.engine;
        firstModel  = result.model ?? null;
        firstVoice  = result.voice ?? null;
      }
      return result;
    });

    // ✨ 更新追蹤變數，加上 catch 避免某一句失敗導致後續全部卡死
    lastGenerationPromise = readyPromise.catch(() => {});

    queue.push({ text: seg, readyPromise });
  }

  // 如果佇列原本是空的，立即啟動播放（會等第一段的 readyPromise）
  if (wasEmpty) processQueue(guildId);

  // 等第一段合成完成，取得引擎資訊後回傳（讓呼叫端能立即得知結果）
  // 注意：此 await 只等第一段，不阻塞後續段落的並行合成
  try {
    const firstResult = await queue[queue.length - segments.length]?.readyPromise;
    if (firstResult) {
      firstEngine = firstResult.engine;
      firstModel  = firstResult.model ?? null;
      firstVoice  = firstResult.voice ?? null;
    }
  } catch {
    // 第一段合成失敗，processQueue 會自動跳過
  }

  return {
    success:      true,
    queued:       !wasEmpty || segments.length > 1,
    position:     queue.length,
    engine:       firstEngine,
    model:        firstModel,
    detectedLang: detectLanguage(text),
    voice:        firstVoice,
    segments:     segments.length,
  };
}

function stopTTS(guildId) {
  if (ttsQueues.has(guildId)) {
    const items = ttsQueues.get(guildId);
    // 清理時需等 readyPromise settle 後才能刪除檔案
    for (const item of items) {
      item.readyPromise.then(r => { if (r?.file) safeUnlink(r.file); }).catch(() => {});
    }
    ttsQueues.delete(guildId);
  }
  ttsIsPlaying.delete(guildId);
  exitTTSLayer(guildId); // ★ 手動停止時也要釋放 TTS 層，恢復音樂/靜音
  return true;
}

module.exports = { playTTS, stopTTS };
