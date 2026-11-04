'use strict';
// 工具執行時「預期內」的失敗（使用者不在語音頻道、找不到歌、不是行程成員…）。
// 訊息會原封不動交給人格轉述，所以要寫成使用者看得懂的句子；非 ToolError 的例外視為程式錯誤，只回報「執行失敗」。

class ToolError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ToolError';
    }
}

const fail = (message) => { throw new ToolError(message); };

module.exports = { ToolError, fail };
