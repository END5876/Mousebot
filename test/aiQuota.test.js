'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// aiQuota 在載入時讀取環境變數，必須先設定好再 require
process.env.AI_USER_RATE_LIMIT = '2';
process.env.AI_USER_RATE_WINDOW_SEC = '60';
process.env.AI_DAILY_TOKEN_BUDGET = '0';
process.env.AI_USER_DAILY_TOKEN_BUDGET = '0';
process.env.OWNER_USER_ID = 'owner';

const { consumeQuota, isQuotaError, quotaMessage, AiQuotaError } = require('../handlers/ai/aiQuota');

test('aiQuota：單一使用者超過頻率上限會被擋下，其他人不受影響', () => {
  consumeQuota('u1');
  consumeQuota('u1');
  assert.throws(() => consumeQuota('u1'), err => isQuotaError(err) && err.reason === 'rate');
  assert.doesNotThrow(() => consumeQuota('u2'));
});

test('aiQuota：擁有者與無 userId 的呼叫不受單人頻率限制', () => {
  for (let i = 0; i < 5; i++) {
    assert.doesNotThrow(() => consumeQuota('owner'));
    assert.doesNotThrow(() => consumeQuota(null));
  }
});

test('aiQuota：提示訊息', () => {
  assert.match(quotaMessage(new AiQuotaError('rate', 4200)), /5 秒後/);
  assert.match(quotaMessage(new AiQuotaError('userDaily')), /你今天/);
  assert.match(quotaMessage(new AiQuotaError('daily')), /總額度/);
  assert.equal(isQuotaError(new Error('x')), false);
});
