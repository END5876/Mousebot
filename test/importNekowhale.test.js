'use strict';

// examples/memes/importNekowhale.js 的參數解析（不打網路：只 require，不執行主程式）
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs } = require('../examples/memes/importNekowhale');

/** 在指定的 AI_PERSONA 下跑 fn（undefined = 沒設定），結束後還原 */
function withPersona(value, fn) {
  const saved = process.env.AI_PERSONA;
  if (value === undefined) delete process.env.AI_PERSONA; else process.env.AI_PERSONA = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.AI_PERSONA; else process.env.AI_PERSONA = saved;
  }
}

test('沒有 --persona 也沒有 AI_PERSONA：直接報錯，不猜人格', () => {
  withPersona(undefined, () => {
    assert.throws(() => parseArgs([]), /請用 --persona <代號> 指定人格（或設定 AI_PERSONA）/);
    assert.throws(() => parseArgs(['--prefetch']), /請用 --persona/);
  });
  withPersona('   ', () => assert.throws(() => parseArgs([]), /請用 --persona/));
});

test('--persona 優先於 AI_PERSONA；其他參數照舊', () => {
  withPersona('fromenv', () => {
    assert.deepEqual(parseArgs([]), { persona: 'fromenv', packs: ['大肥鱼'], prefetch: false });
    assert.deepEqual(parseArgs(['--persona', 'testfish', '--with-gpt', '--prefetch']),
      { persona: 'testfish', packs: ['大肥鱼', '大肥鱼和GPT娘'], prefetch: true });
  });
});

test('人格代號不合法、不認得的參數：報錯', () => {
  withPersona(undefined, () => {
    assert.throws(() => parseArgs(['--persona', '../x']), /人格代號不合法/);
    assert.throws(() => parseArgs(['--persona', 'ok', '--nope']), /不認得的參數：--nope/);
  });
});
