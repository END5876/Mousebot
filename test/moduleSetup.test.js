// test/moduleSetup.test.js
// 用真的模組跑 utils/features.js 的 setupModules（只在正式版 MB；精簡版沒有這些模組）。
// 模組 setup 會掛 setInterval（notice、timeAnnouncer、autojoin），所以每個情境都在子程序裡跑，
// 印出 JSON 後 process.exit(0)。子程序的 env 只帶系統必要的變數，不讀 .env（不經過 index.js，不載入 dotenv）。
// 全開時的指令 hash 回歸測試在 test/behaviorSnapshot.test.js。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PASS_ENV = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG'];
const FULL_ENV = {
  GEMINI_API_KEY: 'x',
  GROQ_API_KEY: 'x',
  SPLITBILL_SERVICE_URL: 'http://splitbill.example',
  OWNER_USER_ID: '900000000000000001',
};
const ALL_INTENTS = ['Guilds', 'GuildMessages', 'MessageContent', 'GuildVoiceStates', 'GuildMembers'];

const SETUP_SCRIPT = `
const { EventEmitter } = require('events');
const { Collection } = require('discord.js');
const features = require('./utils/features');
const client = new EventEmitter();
client.setMaxListeners(0);
Object.assign(client, { commands: new Collection(), user: null, ws: {}, guilds: { cache: new Collection() } });
const rows = [];
const enabled = features.setupModules(client, (name, state, detail) => rows.push({ name, state, detail }));
process.stdout.write(JSON.stringify({
  enabled,
  commands: [...client.commands.keys()].sort(),
  intents: features.intents(),
  rows,
}));
process.exit(0);
`;

const INTENTS_SCRIPT = `
process.stdout.write(JSON.stringify(require('./utils/features').intents()));
process.exit(0);
`;

function run(script, vars) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-modsetup-'));
  try {
    const env = {};
    for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
    Object.assign(env, { MOUSEBOT_DATA_DIR: path.join(tmp, 'data'), LOG_LEVEL: 'error' });
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    fs.mkdirSync(env.MOUSEBOT_DATA_DIR, { recursive: true });
    const res = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(res.status, 0, `子程序失敗：\n${res.stderr}${res.error ? `\n${res.error}` : ''}`);
    return JSON.parse(res.stdout);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const setup = vars => run(SETUP_SCRIPT, { ...FULL_ENV, ...vars });

test('FEATURES=music,autojoin：只註冊 autojoin、music、play，intents 只要語音相關', () => {
  const r = setup({ FEATURES: 'music,autojoin' });
  assert.deepEqual(r.enabled, ['autojoin', 'music']);
  assert.deepEqual(r.commands, ['autojoin', 'music', 'play']);
  assert.deepEqual(r.intents, ['Guilds', 'GuildVoiceStates', 'GuildMembers']);
  // 被排除的模組回報 off（FEATURES 未包含）；stt 是被排除，不是缺依賴
  const off = r.rows.filter(row => row.state === 'off');
  assert.deepEqual(
    off.map(row => row.name),
    ['語音頻道 (/voice)', '語音辨識 STT', '基本指令', '自訂回應 (/response)', 'AI 對話 (/ai)',
      '文字轉語音 (/tts)', '限免通知 (/notify)', '整點報時 (/timeannounce)',
      '分帳系統 (/splitbill, /splitbill-quick, /splitbill-attach)'],
  );
  for (const row of off) assert.equal(row.detail, 'FEATURES 未包含');
  assert.equal(r.rows.some(row => row.state === 'warn'), false);
});

test('沒有 GEMINI_API_KEY：不註冊 /ai，STT 因為缺 ai 一起停用', () => {
  const r = setup({ GEMINI_API_KEY: undefined });
  assert.equal(r.commands.includes('ai'), false);
  assert.equal(r.enabled.includes('ai'), false);
  assert.equal(r.enabled.includes('stt'), false);
  assert.ok(r.commands.includes('voice'));
  assert.deepEqual(r.rows.find(row => row.name === 'AI 對話 (/ai)'),
    { name: 'AI 對話 (/ai)', state: 'off', detail: '未設定 GEMINI_API_KEY，AI 功能停用' });
  assert.deepEqual(r.rows.find(row => row.name === '語音辨識 STT'),
    { name: '語音辨識 STT', state: 'off', detail: '需要先啟用 ai（未設定 GEMINI_API_KEY，AI 功能停用）' });
});

test('沒有 SPLITBILL_SERVICE_URL：三個分帳指令都不註冊', () => {
  const r = setup({ SPLITBILL_SERVICE_URL: undefined });
  for (const name of ['splitbill', 'splitbill-quick', 'splitbill-attach']) {
    assert.equal(r.commands.includes(name), false, name);
  }
  assert.ok(r.commands.includes('ai'));
  assert.deepEqual(r.rows, [{
    name: '分帳系統 (/splitbill, /splitbill-quick, /splitbill-attach)',
    state: 'off',
    detail: '未設定 SPLITBILL_SERVICE_URL，分帳指令未註冊',
  }]);
});

test('全開：所有模組都 setup，沒有 off／warn 列，intents 和以前寫死的 5 個相同', () => {
  const r = setup({});
  assert.deepEqual(r.enabled,
    ['voice', 'stt', 'basic', 'responses', 'ai', 'autojoin', 'tts', 'notice', 'timeannounce', 'splitbill', 'music']);
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.intents, ALL_INTENTS);
  assert.deepEqual(r.commands, [
    'ai', 'autojoin', 'music', 'nh', 'notify', 'ping', 'play', 'response', 'say', 'serverinfo',
    'splitbill', 'splitbill-attach', 'splitbill-quick', 'timeannounce', 'tts', 'voice',
  ]);
});

test('FEATURES=foo：回報一列 warn，所有模組都被排除', () => {
  const r = setup({ FEATURES: 'foo' });
  assert.deepEqual(r.enabled, []);
  assert.deepEqual(r.commands, []);
  assert.deepEqual(r.intents, ['Guilds']);
  const warn = r.rows.filter(row => row.state === 'warn');
  assert.equal(warn.length, 1);
  assert.equal(warn[0].name, 'FEATURES');
  assert.match(warn[0].detail, /^不認得的模組：foo（可用：voice, stt, basic, /);
  assert.equal(r.rows.filter(row => row.state === 'off').length, 11);
  assert.equal(r.rows.at(-1).state, 'warn');
});

test('intents 依 FEATURES 組合產生（N §7）', () => {
  const cases = [
    [undefined, ALL_INTENTS],
    ['music,autojoin', ['Guilds', 'GuildVoiceStates', 'GuildMembers']],
    ['splitbill', ['Guilds', 'GuildMessages', 'MessageContent', 'GuildMembers']],
    ['notice', ['Guilds']],
  ];
  for (const [FEATURES, expected] of cases) {
    assert.deepEqual(run(INTENTS_SCRIPT, { ...FULL_ENV, FEATURES }), expected, `FEATURES=${FEATURES}`);
  }
});

// 子指令與子指令群組的名稱（依註冊順序）
const VOICE_SCRIPT = `
const { EventEmitter } = require('events');
const { Collection } = require('discord.js');
const features = require('./utils/features');
const bootSummary = require('./utils/bootSummary');
const reports = [];
bootSummary.report = (name, state, detail) => reports.push({ name, state, detail });
const client = new EventEmitter();
client.setMaxListeners(0);
Object.assign(client, { commands: new Collection(), user: null, ws: {}, guilds: { cache: new Collection() } });
features.setupModules(client, () => {});
const voice = client.commands.get('voice');
const guild = { id: '100000000000000001', name: 'g', channels: { cache: new Collection() } };
process.stdout.write(JSON.stringify({
  options: voice.data.toJSON().options.map(o => o.name),
  buttonListeners: client.listenerCount('interactionCreate'),
  startWakeWord: require('./handlers/voiceHandler').startWakeWord(guild, null),
  sttLoaded: Object.keys(require.cache).some(k => k.endsWith(require('path').join('voice', 'sttHandler.js'))),
  voiceReport: reports.find(r => r.name === '語音頻道 (/voice)'),
}));
process.exit(0);
`;

test('沒有 GROQ_API_KEY：/voice 只有 join、leave、status、silence，喚醒詞回 unavailable', () => {
  const r = run(VOICE_SCRIPT, { ...FULL_ENV, GROQ_API_KEY: undefined, FEATURES: 'voice,ai' });
  assert.deepEqual(r.options, ['join', 'leave', 'status', 'silence']);
  assert.equal(r.startWakeWord, 'unavailable');
  assert.equal(r.sttLoaded, false);
  assert.deepEqual(r.voiceReport, { name: '語音頻道 (/voice)', state: 'ok', detail: 'join / leave / status / silence' });
});

test('有 GROQ_API_KEY：/voice 子指令順序和以前相同，多掛 heyjqn 按鈕監聽', () => {
  const off = run(VOICE_SCRIPT, { ...FULL_ENV, GROQ_API_KEY: undefined, FEATURES: 'voice,ai' });
  const on = run(VOICE_SCRIPT, { ...FULL_ENV, FEATURES: 'voice,ai,stt' });
  assert.deepEqual(on.options, ['join', 'leave', 'status', 'stt', 'silence', 'record-button']);
  assert.equal(on.buttonListeners, off.buttonListeners + 1);
  // 沒有連線時照舊回 no_connection
  assert.equal(on.startWakeWord, 'no_connection');
  assert.equal(on.sttLoaded, true);
  assert.deepEqual(on.voiceReport,
    { name: '語音頻道 (/voice)', state: 'ok', detail: 'join / leave / stt / silence / record-button' });
});

// /ai 的子指令、TTS 的開機摘要（EDGE=1/0 決定假裝有沒有安裝 edge-tts，結果不受本機環境影響）
const AI_TTS_SCRIPT = `
const { EventEmitter } = require('events');
const { Collection } = require('discord.js');
const edgeTTS = require('./handlers/voice/ttsHandler/edgeTTS');
edgeTTS.checkEdgeTTS = () => process.env.EDGE === '1';
const features = require('./utils/features');
const bootSummary = require('./utils/bootSummary');
const reports = [];
bootSummary.report = (name, state, detail) => reports.push({ name, state, detail });
const client = new EventEmitter();
client.setMaxListeners(0);
Object.assign(client, { commands: new Collection(), user: null, ws: {}, guilds: { cache: new Collection() } });
features.setupModules(client, () => {});
const ai = client.commands.get('ai');
const tts = features.get('tts');
process.stdout.write(JSON.stringify({
  aiOptions: ai ? ai.data.toJSON().options.map(o => o.name) : null,
  aiTts: features.isEnabled('aiTts'),
  ttsUsable: tts ? tts.isUsable() : null,
  ttsReport: reports.find(r => r.name === '文字轉語音 (/tts)') ?? null,
}));
process.exit(0);
`;

test('FEATURES 不含 tts：/ai 沒有 tts 子指令，其餘子指令順序不變', () => {
  const on = run(AI_TTS_SCRIPT, { ...FULL_ENV, FEATURES: 'ai,tts', EDGE: '1' });
  const off = run(AI_TTS_SCRIPT, { ...FULL_ENV, FEATURES: 'all,-tts', EDGE: '1' });
  assert.deepEqual(on.aiOptions, ['ask', 'clear', 'tts', 'mode', 'prompt', 'chance', 'scope', 'gugu']);
  assert.equal(on.aiTts, true);
  assert.deepEqual(off.aiOptions, ['ask', 'clear', 'mode', 'prompt', 'chance', 'scope', 'gugu']);
  assert.equal(off.aiTts, false);
  assert.equal(off.ttsUsable, null);
  assert.equal(off.ttsReport, null);
});

test('沒有 SOVITS_HOST：有 edge-tts 回報 ok、沒有就回報 off，都不送 SoVITS 請求', () => {
  const edge = run(AI_TTS_SCRIPT, { ...FULL_ENV, FEATURES: 'tts', EDGE: '1' });
  assert.deepEqual(edge.ttsReport, {
    name: '文字轉語音 (/tts)', state: 'ok', detail: 'Edge-TTS（未設定 SOVITS_HOST，不使用 GPT-SoVITS）｜無自訂模型',
  });
  assert.equal(edge.ttsUsable, true);
  // ai 沒開時 aiTts 也是關的
  assert.equal(edge.aiOptions, null);
  assert.equal(edge.aiTts, false);

  const none = run(AI_TTS_SCRIPT, { ...FULL_ENV, FEATURES: 'tts', EDGE: '0' });
  assert.deepEqual(none.ttsReport, {
    name: '文字轉語音 (/tts)', state: 'off', detail: '未設定 SOVITS_HOST 且未安裝 edge-tts，TTS 無法運作',
  });
  assert.equal(none.ttsUsable, false);
});

// ── docker/entrypoint.sh 用的 CLI（N §4.3）──────────────
function supervisorCli(vars) {
  const env = {};
  for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const res = spawnSync(process.execPath, ['utils/features.js', 'supervisor'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(res.status, 0, `子程序失敗：\n${res.stderr}${res.error ? `\n${res.error}` : ''}`);
  return res.stdout;
}

test('features CLI supervisor：依 FEATURES 和金鑰決定 OWW／bgutil 要不要自動啟動', () => {
  assert.equal(supervisorCli(FULL_ENV), 'OWW_AUTOSTART=true\nBGUTIL_AUTOSTART=true\n');
  assert.equal(supervisorCli({ ...FULL_ENV, GROQ_API_KEY: undefined }), 'OWW_AUTOSTART=false\nBGUTIL_AUTOSTART=true\n');
  assert.equal(supervisorCli({ ...FULL_ENV, FEATURES: 'ai' }), 'OWW_AUTOSTART=false\nBGUTIL_AUTOSTART=false\n');
});

test('docker/*.sh、docker/*.conf 都是 LF（CRLF 會讓容器起不來）', () => {
  const dir = path.join(ROOT, 'docker');
  const files = fs.readdirSync(dir).filter(f => /\.(sh|conf)$/.test(f));
  assert.ok(files.includes('entrypoint.sh') && files.includes('supervisord.conf'));
  for (const f of files) {
    assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('\r'), `${f} 含有 CR`);
  }
});

test('docker/supervisord.conf：只有 bgutil-pot 和 oww-server 的 autostart 是代入值', () => {
  const conf = fs.readFileSync(path.join(ROOT, 'docker', 'supervisord.conf'), 'utf8');
  const autostart = conf.split('\n').filter(l => l.startsWith('autostart='));
  assert.deepEqual(autostart, ['autostart=@BGUTIL_AUTOSTART@', 'autostart=@OWW_AUTOSTART@', 'autostart=true', 'autostart=true']);
});

test('docker/entrypoint.sh 通過 sh -n 語法檢查', t => {
  const res = spawnSync('sh', ['-n', path.join(ROOT, 'docker', 'entrypoint.sh')], { encoding: 'utf8', timeout: 30_000 });
  if (res.error) return t.skip('找不到 sh');
  assert.equal(res.status, 0, res.stderr);
});
