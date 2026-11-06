'use strict';
// profile.js（MouseBot 正式版的預設值）：presence、隨機回覆區段、備份檔案清單、Bot 代號
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-profile-'));
process.env.MOUSEBOT_DATA_DIR = TMP;
process.env.LOG_LEVEL = 'error';
delete process.env.AI_RANDOM_SLOT;

const profile = require('../profile');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('profile：Bot 代號與管理 API 回報的 app 相同', () => {
  assert.equal(profile.app, 'mousebot');
  assert.ok(Object.isFrozen(profile));
});

test('profile：沒有 presence.json 時用預設的「逼逼 機油好難喝」', () => {
  assert.deepEqual(profile.presenceDefault, { status: 'online', type: 'listening', text: '逼逼 機油好難喝' });
  const presence = require('../handlers/presenceHandler');
  assert.deepEqual(presence.getPresenceConfig(), { status: 'online', type: 'listening', text: '逼逼 機油好難喝' });
});

test('profile：隨機回覆區段預設從 0 開始（0/2）', () => {
  assert.equal(profile.defaultRandomSlot, '0/2');
  const aiChance = require('../handlers/ai/aiChance');
  assert.equal(aiChance.parseSlot(profile.defaultRandomSlot), 0);
});

test('profile：備份的檔案清單、共用規則與檔名開頭', () => {
  assert.equal(profile.backup.app, 'Mousebot');
  assert.equal(profile.backup.filePrefix, 'mousebot');
  assert.deepEqual([...profile.backup.settingsFiles], [
    'responses.json', 'userModes.json', 'replyChance.json', 'replyChanceDisabled.json', 'autojoin.json',
    'steamchannel.json', 'epicchannel.json', 'timeAnnouncerSettings.json', 'voiceMonitorEnabled.json',
    'presence.json', 'ttsSettings.json', 'aiTTS.json', 'aiScope.json',
  ]);
  assert.deepEqual([...profile.backup.statsFiles], ['tokenUsage.json', 'musicPlayCount.json', 'steamnotified.json', 'epicnotified.json']);
  assert.deepEqual([...profile.backup.sharedPrompts], ['_general', '_voice', '_group']);
});

test('profile：AI 範圍預設不鎖定，隨機回覆略過 !gugu、!m、!stt', () => {
  assert.equal(profile.aiScopeLock, null);
  assert.deepEqual([...profile.randomReplySkipPrefixes], ['gugu', 'm', 'stt']);
});
