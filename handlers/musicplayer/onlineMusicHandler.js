// handlers/musicplayer/onlineMusicHandler.js
// 此檔案已重構拆分為 ./online/ 資料夾（config / info / search / playback
// 四個子模組），本檔僅作為相容性進入點保留原路徑，對外行為與介面完全
// 不變，其他檔案不需修改任何 require 路徑。
module.exports = require('./online/index.js');
