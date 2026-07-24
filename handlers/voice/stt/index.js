// handlers/voice/stt/index.js — Speaking-Triggered Architecture (RAM-safe)
// 對外進入點：彙整拆分後的子模組（wakeup / transcribe / record / detect /
// auto / manual / listen），維持與拆分前完全相同的 module.exports 介面。

const { cleanupStaleTempFiles } = require('../sttConfig');
const { unsubscribeUser } = require('../sttSession');

const { startSTTListening, stopSTTListening } = require('./listen');
const { ensureManualSession, manualRecordOnce } = require('./manual');

// [修正 CROSS-4] 程序啟動時清理殘留的 temp .wav 檔案
// 防止 SIGKILL 等異常退出後磁碟空間逐漸耗盡
cleanupStaleTempFiles();

module.exports = {
  startSTTListening,
  stopSTTListening,
  ensureManualSession,
  manualRecordOnce,
  unsubscribeUser,
};
