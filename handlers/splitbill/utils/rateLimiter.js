'use strict';

/**
 * 簡單的滑動視窗（sliding window）節流器。
 *
 * 目前唯一的用途是保護「帳單掃描」這種會呼叫外部付費 API（Gemini）的功能——
 * 如果沒有任何限制，使用者手滑連點、或惡意寫腳本連續觸發，Gemini API 的呼叫
 * 次數（＝費用）會沒有上限地累加。這裡用最簡單的記憶體內實作即可，不需要
 * 額外的資料庫或 Redis：機器人重啟後限制會重置，但這對「防止短時間內灌爆」
 * 這個需求來說已經足夠。
 */
class SlidingWindowRateLimiter {
  /**
   * @param {number} maxRequests 視窗內最多允許的次數
   * @param {number} windowMs 視窗長度（毫秒）
   */
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.hits = new Map(); // key -> number[]（時間戳記陣列，由舊到新）
  }

  /**
   * 檢查某個 key（例如 `${guildId}:${userId}`）現在是否還能再呼叫一次；
   * 如果允許，會順便記錄這一次呼叫。
   *
   * @param {string} key
   * @returns {{ allowed: boolean, retryAfterMs: number }}
   *   allowed 為 false 時，retryAfterMs 是「大約還要等多久」（毫秒），可以直接拿去換算成秒數提示使用者。
   */
  check(key) {
    const now = Date.now();
    const recent = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);

    if (recent.length >= this.maxRequests) {
      const retryAfterMs = Math.max(this.windowMs - (now - recent[0]), 0);
      // 這裡不 push 新的時間戳記——被擋下的這次不該算數，避免使用者狂點反而讓視窗一直往後延長。
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }
}

module.exports = { SlidingWindowRateLimiter };
