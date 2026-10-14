// handlers/unifiedQueue/session.js
// 音樂播放狀態的持久化：讓 Bot 重啟（uncaughtException → supervisord 重啟、重新部署）
// 後可以接回原本的歌單，而不是讓使用者看到「歌單突然不見」。
//
// 儲存內容（data/musicSession.json，每個 guild 一筆）：
//   正在播放的曲目、佇列、循環模式、隨機連播開關、語音頻道 / 通知頻道 ID
// 不包含播放進度：恢復時目前這首會從頭播放。
//
// 寫入時機：
//   - playback.js 在播放 / 加入佇列 / 停止時呼叫 schedule()，合併 2 秒內的多次變更
//   - 程序關閉前（processGuards.onShutdown）立即寫出並凍結，之後斷線觸發的 stopAll
//     不會把快照清空
//
// 環境變數：
//   MUSIC_RESUME=0                 停用自動恢復
//   MUSIC_RESUME_MAX_AGE_MIN=15    快照超過幾分鐘就不恢復（避免隔天開機突然開始放歌）

const path = require('path');
const { readJson, writeJsonAtomic, createDebouncedWriter } = require('../../../utils/jsonStore');
const processGuards = require('../../../utils/processGuards');

const SESSION_PATH = path.join(__dirname, '..', '..', '..', 'data', 'musicSession.json');
const ENABLED = process.env.MUSIC_RESUME !== '0';
const MAX_AGE_MS = (Number.parseInt(process.env.MUSIC_RESUME_MAX_AGE_MIN ?? '', 10) || 15) * 60 * 1000;

let snapshotProvider = () => ({});
let frozen = false;

const writer = createDebouncedWriter(SESSION_PATH, () => snapshotProvider(), {
    debounceMs: 2000,
    label: 'MusicSession',
});

/** @param {() => Record<string, object>} fn 回傳 { [guildId]: session } */
function setSnapshotProvider(fn) {
    snapshotProvider = fn;
}

function schedule() {
    if (ENABLED && !frozen) writer.schedule();
}

function freezeAndFlush() {
    if (!ENABLED || frozen) return;
    writer.flush();
    frozen = true;
}

processGuards.onShutdown(freezeAndFlush);

/** 把一首曲目轉成可存檔的純資料（去掉函式、循環參照等） */
function serializeItem(item) {
    if (!item) return null;
    try {
        return JSON.parse(JSON.stringify(item));
    } catch {
        return null;
    }
}

/**
 * 讀出上次的快照並清空檔案（只恢復一次），過期或格式不對的項目會被濾掉。
 * @returns {Array<{ guildId: string, voiceChannelId: string, textChannelId: string|null,
 *                   current: object, queue: object[], loopMode: string, randomPlay: boolean }>}
 */
function takeSavedSessions() {
    if (!ENABLED) return [];
    const data = readJson(SESSION_PATH, {}) || {};
    writeJsonAtomic(SESSION_PATH, {});

    const now = Date.now();
    return Object.entries(data)
        .filter(([, s]) => s && s.current && s.voiceChannelId && now - (s.savedAt ?? 0) <= MAX_AGE_MS)
        .map(([guildId, s]) => ({
            guildId,
            voiceChannelId: s.voiceChannelId,
            textChannelId: s.textChannelId ?? null,
            current: s.current,
            queue: Array.isArray(s.queue) ? s.queue : [],
            loopMode: ['off', 'one', 'all'].includes(s.loopMode) ? s.loopMode : 'off',
            randomPlay: !!s.randomPlay,
        }));
}

module.exports = { setSnapshotProvider, schedule, serializeItem, takeSavedSessions, SESSION_PATH };
