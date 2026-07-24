// handlers/voice/ttsHandler.js
// 此檔案已重構拆分為 ./tts/ 資料夾（config / cache / textSplit / generate /
// queue / commands 六個子模組），本檔僅作為相容性進入點保留原路徑，
// 對外行為與介面完全不變，其他檔案不需修改任何 require 路徑。
module.exports = require('./tts');
