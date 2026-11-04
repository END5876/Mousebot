'use strict';

// 單一人格「執行了工具的訊息不萃取」：工具階段一確認執行了工具就呼叫 onToolsExecuted，
// 之後人格回覆被擋（空回覆）或送出失敗也不會漏掉排除標記。工具階段、Gemini 與用量統計換成假的；
// 資料目錄指到暫存資料夾，不碰正式的 data/。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-toolsexec-'));
const PROMPTS = path.join(TMP, 'prompts');
fs.mkdirSync(path.join(PROMPTS, 'modes'), { recursive: true });
fs.writeFileSync(path.join(PROMPTS, 'modes', 'loss.md'), '---\nname: 預設\n---\nLOSS');

Object.assign(process.env, {
  MOUSEBOT_DATA_DIR: TMP,
  LOG_LEVEL: 'error',
  GROQ_API_KEY: process.env.GROQ_API_KEY || 'test',
  GEMINI_SEARCH_GUILD_IDS: '',
});

let nextText = '好喔';
let executed = true;
function stub(relPath, exports) {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('../handlers/ai/geminiClient', {
  generate: async () => ({ text: nextText }),
  MODEL_NAME: 'test-model',
});
stub('../handlers/ai/tokenTracker', { recordUsage: () => {} });
stub('../handlers/ai/tools', {
  runToolStage: async () => ({ text: 'TOOL REPORT', executed, skipTTS: false }),
  contextFrom: () => ({}),
});

const { Collection } = require('discord.js');
const { getGeminiResponse } = require('../handlers/ai/aiCore');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  setTimeout(() => process.exit(), 500).unref();
});

const fakeChannel = () => ({
  id: '200000000000000001', guildId: '100000000000000001', isThread: () => false,
  guild: { members: { cache: new Collection() } },
  messages: { fetch: async () => new Collection() },
});

test('執行了工具：人格回覆成功或被擋，onToolsExecuted 都在回覆之前呼叫；沒執行就不呼叫', async () => {
  let marked = 0;
  const onToolsExecuted = () => { marked++; };
  const r = await getGeminiResponse('900000000000000001', '放晴天', [], fakeChannel(), 'm1', '500000000000000001', null, 'loss', {}, { onToolsExecuted });
  assert.equal(r.toolsExecuted, true);
  assert.equal(marked, 1);

  nextText = '';   // 人格回覆被擋（空回覆）→ 丟錯，但排除標記已經做了
  await assert.rejects(getGeminiResponse('900000000000000001', '放晴天', [], fakeChannel(), 'm2', '500000000000000001', null, 'loss', {}, { onToolsExecuted }));
  assert.equal(marked, 2);

  nextText = '好喔';
  executed = false;
  await getGeminiResponse('900000000000000001', '你好', [], fakeChannel(), 'm3', '500000000000000001', null, 'loss', {}, { onToolsExecuted });
  assert.equal(marked, 2);
});
