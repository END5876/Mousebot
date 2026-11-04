// utils/dataDir.js
// 新的持久化資料檔（AI 記憶狀態、AI 訊息紀錄、範圍設定、長期記憶…）統一用這裡解析路徑。
// 可用環境變數 MOUSEBOT_DATA_DIR 覆寫資料目錄：測試會把它指到 os.tmpdir()，
// 避免 require 模組時讀寫到正式的 data/。
// 每次呼叫都重新讀環境變數，所以測試只要在 require 目標模組之前設定即可。

const path = require('path');

const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', 'data');

function getDataDir() {
    const override = process.env.MOUSEBOT_DATA_DIR?.trim();
    return override ? path.resolve(override) : DEFAULT_DATA_DIR;
}

/** 資料目錄底下的路徑，例如 dataPath('memories', 'users.json') */
function dataPath(...parts) {
    return path.join(getDataDir(), ...parts);
}

module.exports = { getDataDir, dataPath, DEFAULT_DATA_DIR };
