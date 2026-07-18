'use strict';

/**
 * 跨面板操作狀態快取（例如記帳到一半時暫存的金額/幣別/代墊人資料）。
 *
 * 相較於原本單純的 `Map`（只用 userId 當 key），這裡改用 `guildId:userId`
 * 複合 key，避免同一個使用者同時在兩個不同伺服器操作時互相覆蓋狀態；
 * 同時每筆狀態都帶有存活時間（TTL），並定期清除過期項目，避免使用者
 * 中途棄坑導致的資料一直留在記憶體裡造成緩慢的 memory leak。
 */
class StateCache {
  /**
   * @param {number} ttlMs 狀態存活時間（毫秒），預設 15 分鐘
   * @param {number} sweepIntervalMs 定期掃描過期項目的間隔（毫秒），預設 5 分鐘
   */
  constructor(ttlMs = 15 * 60 * 1000, sweepIntervalMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.store = new Map(); // key -> { value, expiresAt }

    // 定期清除過期項目；unref() 避免這個 timer 阻擋 Node 程式正常結束
    this._sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    if (typeof this._sweepTimer.unref === 'function') this._sweepTimer.unref();
  }

  _key(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  /**
   * 讀取狀態；若已過期則視為不存在（並順手清掉），存在的話會順便延長存活時間，
   * 讓仍在操作中的使用者不會突然被判定逾時。
   */
  get(guildId, userId) {
    const key = this._key(guildId, userId);
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    entry.expiresAt = Date.now() + this.ttlMs; // sliding TTL
    return entry.value;
  }

  set(guildId, userId, value) {
    const key = this._key(guildId, userId);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }

  delete(guildId, userId) {
    this.store.delete(this._key(guildId, userId));
  }

  /** 清除所有已過期的項目 */
  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }

  /** 供除錯/測試使用 */
  size() {
    return this.store.size;
  }
}

module.exports = { StateCache };