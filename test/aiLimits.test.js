'use strict';
// AI 呼叫逾時、圖片處理的同時數與網址數上限
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.GEMINI_API_KEY ||= 'test-key';

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(`http://127.0.0.1:${server.address().port}/`, init);
  try { return await fn(); } finally {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
}

test('generate：沒有指定 timeoutMs 時套用預設上限，指定時以指定的為準', async () => {
  const { generate, DEFAULT_TIMEOUT_MS } = require('../handlers/ai/geminiClient');
  const seen = [];
  await withServer((req, res) => {
    seen.push(req.headers['x-server-timeout']);
    res.setHeader('content-type', 'application/json');
    res.end('{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}');
  }, async () => {
    assert.equal((await generate({ contents: 'x' })).text, 'ok');
    await generate({ contents: 'x', timeoutMs: 15_000 });
  });
  assert.deepEqual(seen, [String(DEFAULT_TIMEOUT_MS / 1000), '15']);
});

for (const [name, handler] of [
  ['完全不回應', () => {}],
  ['標頭回了、內容卡住', (req, res) => { res.setHeader('content-type', 'application/json'); res.write('{"cand'); }],
]) {
  test(`generate：伺服器${name}時會在上限內中斷`, { timeout: 10_000 }, async () => {
    const { generate } = require('../handlers/ai/geminiClient');
    await withServer(handler, () => assert.rejects(generate({ contents: 'x', timeoutMs: 300 })));
  });
}

test('圖片：同時最多處理 3 張、同一網址只下載一次、每則訊息最多 10 個網址', async () => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const realGet = https.get;
  const requested = [];
  let active = 0;
  let peak = 0;
  https.get = (u) => {
    requested.push(String(u));
    peak = Math.max(peak, ++active);
    const req = new EventEmitter();
    setTimeout(() => { active--; req.emit('error', new Error('測試')); }, 10);
    return req;
  };
  try {
    const { processImageUrls, processAttachments } = require('../handlers/ai/aiUtils');
    const urls = Array.from({ length: 15 }, (_, i) => `https://example.com/${i}.png`);
    assert.deepEqual(await processImageUrls(`${urls.join(' ')} https://example.com/page`), []);
    assert.equal(requested.length, 10);
    assert.equal(peak, 3);

    // 名額全數歸還（失敗也要），重複的網址共用同一次下載
    requested.length = 0;
    peak = 0;
    const same = { url: 'https://example.com/same.png', contentType: 'image/png', size: 1 };
    await processAttachments(new Map(Array.from({ length: 4 }, (_, i) => [String(i), same])));
    assert.equal(requested.length, 1);
    await processImageUrls(urls.slice(0, 6).join(' '));
    assert.equal(peak, 3);
  } finally {
    https.get = realGet;
  }
});
