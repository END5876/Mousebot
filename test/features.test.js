// test/features.test.js
// utils/features.js 的單元測試（正式版和精簡版共用同一份）。
// 只用 test/fixtures/features/ 下的假模組，不依賴任何真實模組是否存在。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const features = require('../utils/features');

const ROOT = path.resolve(__dirname, '..');
const FIX = 'test/fixtures/features';

// 測試期間暫時改 process.env，結束後還原
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// 在登錄表尾端注入假條目，結束後移除
function withFakes(fakes, fn) {
  const mods = features._MODULES;
  const start = mods.length;
  mods.push(...fakes);
  features._reset();
  try {
    return fn();
  } finally {
    mods.splice(start, fakes.length);
    features._reset();
  }
}

const FAKES = [
  { name: 'fakeon', label: '假模組 on', entry: `${FIX}/probe`, setup: (m, c) => m.setupProbe(c), intents: ['GuildMembers', 'GuildMessages'] },
  { name: 'fakeabsent', label: '假模組 absent', entry: `${FIX}/does-not-exist`, intents: ['MessageContent'] },
  { name: 'fakeneeds', label: '假模組 needs', entry: `${FIX}/probe`, requires: ['fakeconf'], intents: ['GuildVoiceStates'] },
  {
    name: 'fakeconf', label: '假模組 unconfigured', entry: `${FIX}/probe`, intents: ['MessageContent'],
    missing: () => (process.env.FEATURES_TEST_KEY?.trim() ? null : '未設定 FEATURES_TEST_KEY'),
  },
  { name: 'fakehidden', hidden: true, entry: `${FIX}/probe`, requires: ['fakeon'] },
];

// ── parseFeatures ───────────────────────────────────────────

test('parseFeatures：未設定或空白 → 全開', () => {
  for (const raw of [undefined, '', '   ', ' , ']) {
    const r = features.parseFeatures(raw);
    assert.equal(r.all, true, `raw=${JSON.stringify(raw)}`);
    assert.equal(r.names.size, 0);
    assert.equal(r.excluded.size, 0);
    assert.deepEqual(r.unknown, []);
  }
});

test('parseFeatures：all,-splitbill', () => {
  const r = features.parseFeatures('all,-splitbill');
  assert.equal(r.all, true);
  assert.deepEqual([...r.excluded], ['splitbill']);
  assert.deepEqual(r.unknown, []);
});

test('parseFeatures：只寫排除項時視同 all', () => {
  const r = features.parseFeatures('-splitbill');
  assert.equal(r.all, true);
  assert.deepEqual([...r.excluded], ['splitbill']);
});

test('parseFeatures：不分大小寫，逗號或空白分隔', () => {
  const r = features.parseFeatures('AI, Music  ALL\t-SplitBill');
  assert.equal(r.all, true);
  assert.deepEqual([...r.names].sort(), ['ai', 'music']);
  assert.deepEqual([...r.excluded], ['splitbill']);

  const r2 = features.parseFeatures('Ai music');
  assert.equal(r2.all, false);
  assert.deepEqual([...r2.names].sort(), ['ai', 'music']);
});

test('parseFeatures：未知名稱進 unknown（去重、小寫），不影響 all', () => {
  const r = features.parseFeatures('ai,foo,-Bar,FOO');
  assert.equal(r.all, false);
  assert.deepEqual([...r.names], ['ai']);
  assert.deepEqual(r.unknown, ['foo', 'bar']);
  // 只寫未知名稱 → 不是全開（所有模組都會被排除）
  assert.equal(features.parseFeatures('foo').all, false);
});

test('parseFeatures：hidden 條目不能寫進 FEATURES', () => {
  const r = features.parseFeatures('ai,aiTools,-gugu,aitts');
  assert.deepEqual([...r.names], ['ai']);
  assert.equal(r.excluded.size, 0);
  assert.deepEqual(r.unknown, ['aitools', 'gugu', 'aitts']);
});

test('list()：不含 hidden，順序和 setup 順序相同', () => {
  assert.deepEqual(features.list(), [
    'voice', 'stt', 'basic', 'responses', 'ai', 'autojoin', 'tts', 'notice', 'timeannounce', 'splitbill', 'music',
  ]);
});

// ── status ─────────────────────────────────────────────────

test('status：5 種狀態', () => {
  withFakes(FAKES, () => withEnv({ FEATURES: undefined, FEATURES_TEST_KEY: undefined }, () => {
    assert.deepEqual(features.status('fakeon'), { name: 'fakeon', state: 'on', detail: null });
    assert.deepEqual(features.status('fakeabsent'), { name: 'fakeabsent', state: 'absent', detail: null });
    assert.deepEqual(features.status('fakeconf'), { name: 'fakeconf', state: 'unconfigured', detail: '未設定 FEATURES_TEST_KEY' });
    assert.deepEqual(features.status('fakeneeds'), {
      name: 'fakeneeds', state: 'needs', detail: '需要先啟用 fakeconf（未設定 FEATURES_TEST_KEY）',
    });

    process.env.FEATURES_TEST_KEY = 'x';
    assert.equal(features.status('fakeconf').state, 'on');
    assert.equal(features.status('fakeneeds').state, 'on');

    process.env.FEATURES = 'all,-fakeon';
    assert.deepEqual(features.status('fakeon'), { name: 'fakeon', state: 'excluded', detail: 'FEATURES 未包含' });

    process.env.FEATURES = 'fakeneeds';
    assert.equal(features.status('fakeneeds').state, 'needs');
    assert.equal(features.status('fakeneeds').detail, '需要先啟用 fakeconf（FEATURES 未包含）');
    assert.equal(features.isEnabled('fakeneeds'), false);
  }));
});

test('status：absent 優先於 excluded；不存在的名稱丟錯', () => {
  withFakes(FAKES, () => withEnv({ FEATURES: 'music' }, () => {
    assert.equal(features.status('fakeabsent').state, 'absent');
    assert.equal(features.isPresent('fakeabsent'), false);
    assert.equal(features.isPresent('fakeon'), true);
  }));
  assert.throws(() => features.status('no-such-module'), /沒有名為 no-such-module/);
});

test('hidden 條目：一律視為已列入，只看依賴', () => {
  withFakes(FAKES, () => {
    withEnv({ FEATURES: 'fakeon' }, () => {
      assert.equal(features.isListed('fakehidden'), true);
      assert.equal(features.status('fakehidden').state, 'on');
    });
    withEnv({ FEATURES: 'all,-fakehidden' }, () => {
      assert.equal(features.status('fakehidden').state, 'on');
    });
    withEnv({ FEATURES: 'all,-fakeon' }, () => {
      assert.deepEqual(features.status('fakehidden'), {
        name: 'fakehidden', state: 'needs', detail: '需要先啟用 fakeon（FEATURES 未包含）',
      });
    });
  });
});

// ── intents ────────────────────────────────────────────────

test('intents()：已啟用模組的聯集加上 Guilds，依固定順序排列', () => {
  withFakes(FAKES, () => {
    // 只列假模組 → 真實模組都被排除，結果和 repo 裡有哪些模組無關
    withEnv({ FEATURES: 'fakeon', FEATURES_TEST_KEY: undefined }, () => {
      assert.deepEqual(features.intents(), ['Guilds', 'GuildMessages', 'GuildMembers']);
    });
    withEnv({ FEATURES: 'fakeon,fakeneeds,fakeconf,fakeabsent', FEATURES_TEST_KEY: 'x' }, () => {
      assert.deepEqual(features.intents(), ['Guilds', 'GuildMessages', 'MessageContent', 'GuildVoiceStates', 'GuildMembers']);
    });
    withEnv({ FEATURES: 'fakeabsent' }, () => {
      assert.deepEqual(features.intents(), ['Guilds']);
    });
  });
});

// ── setupModules ───────────────────────────────────────────

test('setupModules：on 呼叫 setup，其他回報 off，absent 不回報，未知名稱回報 warn', () => {
  withFakes(FAKES, () => withEnv({ FEATURES: 'fakeon,fakeneeds,fakeconf,fakeabsent,fakehidden,foo', FEATURES_TEST_KEY: undefined }, () => {
    const rows = [];
    const client = { setupCalls: [] };
    const enabled = features.setupModules(client, (name, st, detail) => rows.push([name, st, detail]));

    assert.deepEqual(enabled, ['fakeon']);
    assert.deepEqual(client.setupCalls, ['probe']);
    const fakeRows = rows.filter(([name]) => name.startsWith('假模組'));
    assert.deepEqual(fakeRows, [
      ['假模組 needs', 'off', '需要先啟用 fakeconf（未設定 FEATURES_TEST_KEY）'],
      ['假模組 unconfigured', 'off', '未設定 FEATURES_TEST_KEY'],
    ]);
    const warn = rows.filter(([name]) => name === 'FEATURES');
    assert.equal(warn.length, 1);
    assert.equal(warn[0][1], 'warn');
    assert.match(warn[0][2], /^不認得的模組：fakehidden, foo（可用：voice, stt, .*fakeon.*）$/);
    // 真實模組在這個 FEATURES 下都不是 on，所以只會回報 off
    assert.ok(rows.every(([name, st]) => name === 'FEATURES' || st === 'off'));
  }));
});

// ── get()／load()（子程序：require.cache 要乾淨） ──────────────

function childEnv(vars) {
  const env = { ...process.env, LOG_LEVEL: 'error', ...vars };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

function runChild(script, vars) {
  const r = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env: childEnv(vars), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const CHILD_PRELUDE = `
const path = require('path');
const features = require('./utils/features');
features._MODULES.push(
  { name: 'fakeprobe', label: '假模組 probe', entry: '${FIX}/probe' },
  { name: 'fakethrows', label: '假模組 throws', entry: '${FIX}/throws' },
);
const probePath = path.join(features.ROOT, '${FIX}', 'probe.js');
const loaded = () => Object.keys(require.cache).includes(probePath);
`;

test('get()：停用時回 null 而且不會 require 該模組', () => {
  const out = runChild(`${CHILD_PRELUDE}
const got = features.get('fakeprobe');
process.stdout.write(JSON.stringify({ got, loaded: loaded(), loads: globalThis.__featuresProbeLoads ?? 0 }));
`, { FEATURES: 'fakethrows' });
  assert.deepEqual(out, { got: null, loaded: false, loads: 0 });
});

test('get()：啟用時 require 並回傳模組；load() 直接 require', () => {
  const out = runChild(`${CHILD_PRELUDE}
const got = features.get('fakeprobe');
const again = features.load('${FIX}/probe');
process.stdout.write(JSON.stringify({
  isFn: typeof got.setupProbe === 'function', same: got === again, loaded: loaded(), loads: globalThis.__featuresProbeLoads,
}));
`, { FEATURES: 'fakeprobe' });
  assert.deepEqual(out, { isFn: true, same: true, loaded: true, loads: 1 });
});

test('get()：require 時的錯誤照常往上丟', () => {
  const out = runChild(`${CHILD_PRELUDE}
let message = null;
try { features.get('fakethrows'); } catch (e) { message = e.message; }
process.stdout.write(JSON.stringify({ message }));
`, { FEATURES: undefined });
  assert.deepEqual(out, { message: 'fixture load failure' });
});

// ── CLI ────────────────────────────────────────────────────

test('CLI：supervisor 印出兩行布林值', () => {
  const run = env => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'utils', 'features.js'), 'supervisor'], {
      cwd: ROOT, env: childEnv(env), encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  // FEATURES=ai：stt、music 都不在清單裡，不論 repo 裡有沒有這兩個模組都是 false
  assert.equal(run({ FEATURES: 'ai', GEMINI_API_KEY: 'x', GROQ_API_KEY: 'x' }), 'OWW_AUTOSTART=false\nBGUTIL_AUTOSTART=false\n');
  assert.match(run({ FEATURES: '' }), /^OWW_AUTOSTART=(true|false)\nBGUTIL_AUTOSTART=(true|false)\n$/);
});
