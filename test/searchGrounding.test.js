'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// 模組載入時讀取環境變數
process.env.GEMINI_SEARCH_GUILD_IDS = '111, 222';

const {
  isSearchEnabled, getGroundingInfo, formatSources, stripSourcesLine, SEARCH_TOOLS,
} = require('../handlers/ai/searchGrounding');

test('isSearchEnabled：只對名單內的伺服器啟用', () => {
  assert.equal(isSearchEnabled('111'), true);
  assert.equal(isSearchEnabled(222), true);
  assert.equal(isSearchEnabled('333'), false);
  assert.equal(isSearchEnabled(null), false);
  assert.deepEqual(SEARCH_TOOLS, [{ googleSearch: {} }]);
});

test('getGroundingInfo：取出搜尋關鍵字與去重後的來源', () => {
  const response = {
    candidates: [{
      groundingMetadata: {
        webSearchQueries: ['今天 天氣', ''],
        groundingChunks: [
          { web: { uri: 'https://a.example/1', title: 'a.example' } },
          { web: { uri: 'https://a.example/2', title: 'a.example' } },
          { web: { uri: 'https://b.example/x', title: '' } },
          { retrievedContext: {} },
        ],
      },
    }],
  };
  const { queries, sources } = getGroundingInfo(response);
  assert.deepEqual(queries, ['今天 天氣']);
  assert.deepEqual(sources, [
    { title: 'a.example', uri: 'https://a.example/1' },
    { title: 'b.example', uri: 'https://b.example/x' },
  ]);

  assert.deepEqual(getGroundingInfo({}), { queries: [], sources: [] });
  assert.deepEqual(getGroundingInfo(null), { queries: [], sources: [] });
});

test('formatSources：最多 3 個、連結不展開預覽；stripSourcesLine 可移除', () => {
  assert.equal(formatSources([]), '');
  const line = formatSources([
    { title: 'A [x]', uri: 'https://a' },
    { title: 'B', uri: 'https://b' },
    { title: 'C', uri: 'https://c' },
    { title: 'D', uri: 'https://d' },
  ]);
  assert.equal(line, '-# 📎 來源：[A x](<https://a>)・[B](<https://b>)・[C](<https://c>)');
  assert.equal(stripSourcesLine(`回答內容\n第二行\n${line}`), '回答內容\n第二行');
  assert.equal(stripSourcesLine('沒有來源'), '沒有來源');
});
