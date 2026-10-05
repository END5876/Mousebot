// utils/config.js
// 集中管理「擁有者」身分。過去擁有者 ID 以字面值硬編碼在
// aiHandler.js / responseHandler.js / autoJoinHandler.js 三個檔案裡，
// 換人或換帳號都得改程式碼。現在統一由環境變數 OWNER_USER_ID 提供
// （可用逗號分隔多個 ID），所有「僅限擁有者」的功能都透過 isOwner() 判斷。
//
// 注意：未設定 OWNER_USER_ID 時沒有任何人是擁有者，
// 所有僅限擁有者的功能會被拒絕（fail-closed），index.js 開機摘要會提示。

const OWNER_USER_IDS = new Set(
  (process.env.OWNER_USER_ID || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
);

function isOwner(userId) {
  return userId != null && OWNER_USER_IDS.has(String(userId));
}

module.exports = { OWNER_USER_IDS, isOwner };
