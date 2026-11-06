'use strict';
// profile.js — 這隻 Bot 自己的預設值（MouseBot 正式版）
//
// mousebot-lite 也有一份同名檔案，內容不同、不同步；共用的程式碼一律從這裡讀各 Bot 不同的預設值。
// 只放：app、backup、presenceDefault、defaultRandomSlot、aiScopeLock、randomReplySkipPrefixes。

module.exports = Object.freeze({
  // 管理面板顯示的 Bot 代號（admin/api/index.js）
  app: 'mousebot',

  // 設定備份（admin/api/system.js、admin/backup.js）
  // 不含任何金鑰（admin-session-secret、cookies），也不含暫存或可重建的檔案。
  // AI 對話狀態（aiMemoryState.json 清除時間、aiMessageLog.json 回覆紀錄）涉及使用者隱私，刻意不放進備份
  backup: Object.freeze({
    app: 'Mousebot',
    filePrefix: 'mousebot',
    settingsFiles: Object.freeze([
      'responses.json', 'userModes.json', 'replyChance.json', 'replyChanceDisabled.json', 'autojoin.json',
      'steamchannel.json', 'epicchannel.json', 'timeAnnouncerSettings.json', 'voiceMonitorEnabled.json',
      'presence.json', 'ttsSettings.json', 'aiTTS.json', 'aiScope.json',
    ]),
    statsFiles: Object.freeze(['tokenUsage.json', 'musicPlayCount.json', 'steamnotified.json', 'epicnotified.json']),
    // data/prompts/ 的共用規則（modes/*.md 一律備份）
    sharedPrompts: Object.freeze(['_general', '_voice', '_group']),
  }),

  // 沒有 data/presence.json 時的 Bot 狀態（handlers/presenceHandler.js）
  presenceDefault: Object.freeze({ status: 'online', type: 'listening', text: '逼逼 機油好難喝' }),

  // 沒設 AI_RANDOM_SLOT 時的隨機回覆區段（handlers/ai/aiChance.js）；同群有 lite 時 lite 預設 1/2
  defaultRandomSlot: '0/2',

  // 沒設 AI_SCOPE_LOCK 時的 AI 範圍鎖定；null = 不鎖定（多人格／單一人格可切換）
  aiScopeLock: null,

  // 這些前綴開頭的訊息不觸發隨機回覆
  randomReplySkipPrefixes: Object.freeze(['gugu', 'm', 'stt']),
});
