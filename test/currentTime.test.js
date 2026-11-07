'use strict';

// handlers/ai/currentTime.js：附在本次訊息前面的「現在時間」
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_LEVEL = 'error';
const { formatNow, currentTimePart, DEFAULT_TIME_ZONE, _resolveTimeZone } = require('../handlers/ai/currentTime');

test('預設時區是 Asia/Taipei', () => {
  assert.equal(DEFAULT_TIME_ZONE, 'Asia/Taipei');
  assert.equal(_resolveTimeZone(''), 'Asia/Taipei');
});

test('格式：年月日、星期、24 小時制、時區', () => {
  // UTC 2026-11-08 06:05 = 台北 14:05（星期日）
  const d = new Date('2026-11-08T06:05:00Z');
  assert.equal(formatNow(d, 'Asia/Taipei'), '2026年11月8日（星期日）14:05，時區 Asia/Taipei');
  // 午夜顯示 00 不是 24
  assert.equal(formatNow(new Date('2026-11-08T16:00:00Z'), 'Asia/Taipei'), '2026年11月9日（星期一）00:00，時區 Asia/Taipei');
});

test('換時區會換日期與星期', () => {
  const d = new Date('2026-11-08T20:30:00Z');
  assert.equal(formatNow(d, 'Asia/Taipei'), '2026年11月9日（星期一）04:30，時區 Asia/Taipei');
  assert.equal(formatNow(d, 'America/Los_Angeles'), '2026年11月8日（星期日）12:30，時區 America/Los_Angeles');
});

test('無效的時區退回預設', () => {
  assert.equal(_resolveTimeZone('Mars/Olympus'), 'Asia/Taipei');
  assert.equal(_resolveTimeZone('Asia/Tokyo'), 'Asia/Tokyo');
});

test('currentTimePart 是帶【現在時間】標籤的文字 part', () => {
  const part = currentTimePart(new Date('2026-11-08T06:05:00Z'));
  assert.deepEqual(Object.keys(part), ['text']);
  assert.match(part.text, /^【現在時間：2026年11月8日（星期日）\d{2}:05，時區 .+】$/);
});
