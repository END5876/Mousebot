'use strict';

// TTS 分句（handlers/voice/ttsHandler/textSplitter）；只有 MouseBot 有，不同步到 mousebot-lite
const test = require('node:test');
const assert = require('node:assert/strict');

const { splitSentences } = require('../handlers/voice/ttsHandler/textSplitter');

// ── TTS 分句 ──────────────────────────────────────────────
test('splitSentences：依句號切割、長句再細分、純標點併回前句', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('你好。今天天氣很好！要出門嗎？'), ['你好。', '今天天氣很好！', '要出門嗎？']);
  assert.deepEqual(splitSentences('好耶！！！'), ['好耶！！！']);

  const long = '第一段文字比較長，第二段文字也很長，第三段文字一樣很長，第四段文字還是很長';
  const parts = splitSentences(long, 20);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(p => p.length <= 20));
  assert.equal(parts.join(''), long);
});
