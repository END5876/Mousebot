'use strict';

// Discord embed 的顏色規則（ui-review 跨產品 14）：跟網頁的識別色對得上，同一種意思用同一個顏色。
//   MUSIC      音樂的一般畫面與「正在播放」（綠色；鮮紅色讓人聯想到暫停、出錯，正常進行中不用）
//   SPLITBILL  分帳的一般畫面與設定頁（黃銅，同裊器分帳的主色）
//   SUCCESS    完成了某件事（記帳成功、連線成功）
//   DANGER     刪除、失敗、要小心的確認
//   NEUTRAL    暫停、進行中、已結束、關閉
//   WARN       需要注意但不是錯誤
module.exports = Object.freeze({
  MUSIC: 0x1DB954,
  SPLITBILL: 0xD6A646,
  SUCCESS: 0x2ECC71,
  DANGER: 0xE74C3C,
  NEUTRAL: 0x95A5A6,
  WARN: 0xF1C40F,
});
