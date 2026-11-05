'use strict';

// handlers/ai/aiChance.js 的隨機回覆擲骰：單機照常、多隻 bot 不會同時回
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.MOUSEBOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aichance-'));
const { shouldRandomReply, messageRoll, parseSlot } = require('../handlers/ai/aiChance');

const ids = Array.from({ length: 5000 }, (_, i) => String(1300000000000000000n + BigInt(i) * 7919n));
const rate = (chance, offset) => ids.filter(id => shouldRandomReply(id, chance, offset)).length / ids.length;

test('messageRoll：同一個 messageId 永遠得到同一個值，落在 [0, 1)', () => {
  for (const id of ids.slice(0, 50)) {
    const r = messageRoll(id);
    assert.equal(r, messageRoll(id));
    assert.ok(r >= 0 && r < 1);
  }
});

test('parseSlot：i/n 轉成區段起點，格式不對回傳 null', () => {
  assert.equal(parseSlot('0/1'), 0);
  assert.equal(parseSlot('1/2'), 0.5);
  assert.equal(parseSlot(' 2 / 3 '), 2 / 3);
  for (const bad of ['', undefined, 'high', '2/2', '1/0', '-1/2', '1.5/3']) assert.equal(parseSlot(bad), null, String(bad));
});

test('單機：不論區段在哪，命中率都接近設定的機率；0 與 1 是邊界', () => {
  for (const offset of [0, 0.5, 1 / 3, 0.9]) {
    assert.ok(Math.abs(rate(0.2, offset) - 0.2) < 0.03, `offset ${offset}`);
    assert.equal(rate(0, offset), 0);
    assert.equal(rate(1, offset), 1);
  }
});

test('多隻：每隻機率 ≤ 1/n 時同一則訊息最多一隻回', () => {
  for (const n of [2, 3, 5]) {
    const offsets = Array.from({ length: n }, (_, i) => parseSlot(`${i}/${n}`));
    for (const chance of [0.1, 1 / n]) {
      for (const id of ids) {
        const hits = offsets.filter(o => shouldRandomReply(id, chance, o)).length;
        assert.ok(hits <= 1, `n=${n} chance=${chance} id=${id} hits=${hits}`);
      }
    }
  }
});

test('預設 0/2 與 1/2（MouseBot 與 lite）一起用各 15% 不會重疊', () => {
  for (const id of ids) {
    assert.ok(!(shouldRandomReply(id, 0.15, parseSlot('0/2')) && shouldRandomReply(id, 0.15, parseSlot('1/2'))));
  }
});
