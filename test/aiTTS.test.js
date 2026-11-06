'use strict';

// AI 回覆朗讀開關（handlers/ai/aiTTS.js）的預設值，以及沒設定 SOVITS_HOST 時 sovitsClient 不送請求。
// 資料目錄用 MOUSEBOT_DATA_DIR 指到暫存資料夾，不碰正式的 data/。只在正式版 MB（精簡版沒有 TTS）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-aitts-'));
process.env.MOUSEBOT_DATA_DIR = TMP;
process.env.LOG_LEVEL = 'error';
// sovitsClient 在 require 時就讀 SOVITS_HOST，要先清掉
delete process.env.SOVITS_HOST;
delete process.env.AI_TTS_DEFAULT;
fs.writeFileSync(path.join(TMP, 'aiTTS.json'), JSON.stringify({ '100000000000000001': true, '100000000000000002': false }));

const aiTTS = require('../handlers/ai/aiTTS');
const sovits = require('../handlers/voice/ttsHandler/sovitsClient');

test.after(() => {
  delete process.env.AI_TTS_DEFAULT;
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('isAITTSEnabled：沒設定 AI_TTS_DEFAULT 時沒存過的伺服器預設開啟', () => {
  delete process.env.AI_TTS_DEFAULT;
  assert.equal(aiTTS.isAITTSEnabled('100000000000000009'), true);
  assert.equal(aiTTS.isAITTSEnabled('100000000000000001'), true);
  assert.equal(aiTTS.isAITTSEnabled('100000000000000002'), false);
});

test('isAITTSEnabled：AI_TTS_DEFAULT=0 時沒存過的伺服器關閉，存過的照存檔', () => {
  process.env.AI_TTS_DEFAULT = ' 0 ';
  try {
    assert.equal(aiTTS.isAITTSEnabled('100000000000000009'), false);
    assert.equal(aiTTS.isAITTSEnabled('100000000000000001'), true);
    assert.equal(aiTTS.isAITTSEnabled('100000000000000002'), false);
  } finally {
    delete process.env.AI_TTS_DEFAULT;
  }
});

test('setAITTSEnabled：寫進資料目錄的 aiTTS.json', () => {
  aiTTS.setAITTSEnabled('100000000000000003', false);
  assert.equal(aiTTS.isAITTSEnabled('100000000000000003'), false);
  const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'aiTTS.json'), 'utf8'));
  assert.equal(saved['100000000000000003'], false);
  assert.equal(saved['100000000000000001'], true);
});

test('speakWithTTS：使用者不在語音頻道時直接略過', async () => {
  // 沒有 member.voice.channel，不會呼叫 playTTS（也不需要真的連線）
  await aiTTS.speakWithTTS({ member: null }, '你好', '100000000000000001');
});

test('沒有 SOVITS_HOST：isSoVITSConfigured、checkSoVITSHealth 都回 false，切換模型直接失敗', async () => {
  assert.equal(sovits.SOVITS_HOST, '');
  assert.equal(sovits.isSoVITSConfigured(), false);
  assert.equal(await sovits.checkSoVITSHealth(), false);
  assert.equal(await sovits.resolveSoVITSHost(), null);
  await assert.rejects(sovits.switchSoVITSWeights('a.ckpt', 'b.pth'), /未設定 SOVITS_HOST/);
});
