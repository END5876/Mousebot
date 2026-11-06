// utils/features.js
// 功能模組登錄表：哪些模組要載入、要哪些 intents、缺什麼設定，全部由這份清單決定。
// 正式版和精簡版（mousebot-lite）用的是逐位元相同的同一份檔案；
// 精簡版沒有的模組（例如 handlers/voiceHandler）因為檔案不存在，狀態自然是 absent，不需要另外設定。
//
// 環境變數 FEATURES（選填）：
//   沒設定或空白 → 全部開啟（和沒有這份登錄表之前的行為相同）
//   以逗號或空白分隔、不分大小寫，例如 FEATURES=ai,music 或 FEATURES=all,-splitbill
//
// 使用規則：
//   1. 任何模組都「不可以在最上層呼叫 features.get()」，只能在函式裡呼叫。
//      sttHandler、aiHandler、voiceHandler 互相依賴，在最上層取用會造成循環 require，拿到半成品的模組。
//   2. 例外：index.js 和 admin/api/index.js 是在 setup／register 時才呼叫，可以直接使用。
//
// 這個檔案本身沒有任何依賴（不 require discord.js、dotenv 或 profile），
// 開機摘要（./bootSummary）只在 setupModules() 被呼叫時才載入。

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// intents 用 GatewayIntentBits 的 key 字串表示，輸出時依這個順序排序
const INTENT_ORDER = ['Guilds', 'GuildMessages', 'MessageContent', 'GuildVoiceStates', 'GuildMembers'];

// 清單順序就是 setup 的順序。
// GuildMembers 的取捨：確定一定需要的只有 ai（管理面板的成員搜尋）和 splitbill（成員顯示名稱）；
// voice、stt、autojoin、music 是保守保留（STT 用 members.cache 取得說話者名稱，精簡版也一直都有要求），
// 實測確認不需要之後可以拿掉。
// hidden 條目是其他模組的子功能，不能寫進 FEATURES，也不會出現在開機摘要。
const MODULES = [
  {
    name: 'voice',
    label: '語音頻道 (/voice)',
    entry: 'handlers/voiceHandler',
    setup: (m, client) => m.setupVoiceCommands(client),
    intents: ['GuildVoiceStates', 'GuildMembers'],
  },
  {
    name: 'stt',
    label: '語音辨識 STT',
    entry: 'handlers/voice/sttHandler',
    // require 時就會回報 sttConfig 狀態並清理暫存檔，get() 一次就夠了
    setup: () => {},
    intents: ['GuildVoiceStates', 'GuildMembers'],
    requires: ['voice', 'ai'],
    missing: () => (process.env.GROQ_API_KEY?.trim()
      ? null
      : '未設定 GROQ_API_KEY，語音辨識停用（/voice stt、/voice record-button 未註冊）'),
  },
  {
    name: 'basic',
    label: '基本指令',
    entry: 'handlers/commandHandler',
    setup: (m, client) => m.setupBasicCommands(client),
    // 「有什麼了不起」監聽要讀訊息內容
    intents: ['GuildMessages', 'MessageContent'],
  },
  {
    name: 'responses',
    label: '自訂回應 (/response)',
    entry: 'handlers/responseHandler',
    setup: (m, client) => m.setupCustomResponses(client),
    intents: ['GuildMessages', 'MessageContent'],
  },
  {
    name: 'ai',
    label: 'AI 對話 (/ai)',
    entry: 'handlers/ai/aiHandler',
    setup: (m, client) => m.setupAICommands(client),
    // GuildMembers：管理面板用 guild.members.search 搜尋成員
    intents: ['GuildMessages', 'MessageContent', 'GuildMembers'],
    missing: () => (process.env.GEMINI_API_KEY?.trim() ? null : '未設定 GEMINI_API_KEY，AI 功能停用'),
  },
  {
    name: 'autojoin',
    label: '自動加入語音頻道',
    entry: 'handlers/autoJoinHandler',
    setup: (m, client) => m.setupAutoJoinCommands(client),
    intents: ['GuildVoiceStates', 'GuildMembers'],
  },
  {
    name: 'tts',
    label: '文字轉語音 (/tts)',
    entry: 'handlers/voice/ttsHandler',
    setup: (m, client) => m.setupTTSCommands(client),
    intents: ['GuildVoiceStates'],
  },
  {
    name: 'notice',
    label: '限免通知 (/notify)',
    entry: 'handlers/notice/noticeHandler',
    setup: (m, client) => m.setupNoticeCommands(client),
    intents: [],
  },
  {
    name: 'timeannounce',
    label: '整點報時 (/timeannounce)',
    entry: 'handlers/notice/timeAnnouncer',
    setup: (m, client) => m.setupTimeAnnouncer(client),
    intents: ['GuildVoiceStates'],
  },
  {
    name: 'splitbill',
    label: '分帳系統 (/splitbill, /splitbill-quick, /splitbill-attach)',
    entry: 'handlers/splitbill',
    setup: (m, client) => m.setupSplitbillCommands(client),
    // MessageContent：帳單辨識流程用 createMessageCollector 讀附件；GuildMembers：成員顯示名稱
    intents: ['GuildMessages', 'MessageContent', 'GuildMembers'],
    missing: () => (process.env.SPLITBILL_SERVICE_URL?.trim()
      ? null
      : '未設定 SPLITBILL_SERVICE_URL，分帳指令未註冊'),
  },
  {
    name: 'music',
    label: '音樂播放 (/play, /music)',
    entry: 'handlers/musicplayer/unifiedQueue',
    setup: (m, client) => {
      // 本地引擎不依賴網路，和指令一起在登入前就註冊；線上引擎由 index.js 在 clientReady 後注入
      load('handlers/musicplayer/localMusicHandler').setupLocalMusicEngine(client);
      m.setupUnifiedCommands(client);
    },
    intents: ['GuildVoiceStates', 'GuildMembers'],
  },
  { name: 'aiTools', hidden: true, entry: 'handlers/ai/tools', requires: ['ai'] },
  { name: 'aiTts', hidden: true, entry: 'handlers/ai/aiTTS', requires: ['ai', 'tts'] },
  { name: 'gugu', hidden: true, entry: 'handlers/ai/gugugagaGenerator', requires: ['ai'] },
];

const presentMemo = new Map();

function findModule(name) {
  const mod = MODULES.find(m => m.name === name);
  if (!mod) throw new Error(`features：沒有名為 ${name} 的模組`);
  return mod;
}

function list() {
  return MODULES.filter(m => !m.hidden).map(m => m.name);
}

function parseFeatures(raw = process.env.FEATURES) {
  const tokens = String(raw ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  const known = new Set(list().map(n => n.toLowerCase()));
  const names = new Set();
  const excluded = new Set();
  const unknown = [];
  let hasAll = false;
  let positives = 0;
  for (const token of tokens) {
    const negative = token.startsWith('-');
    const name = negative ? token.slice(1) : token;
    if (!name) continue;
    if (!negative) positives++;
    if (name === 'all') {
      if (!negative) hasAll = true;
      continue;
    }
    if (!known.has(name)) {
      if (!unknown.includes(name)) unknown.push(name);
      continue;
    }
    (negative ? excluded : names).add(name);
  }
  // 只寫了排除項（例如 FEATURES=-splitbill）時視同 all,-splitbill
  const all = hasAll || positives === 0;
  return { all, names, excluded, unknown };
}

function isListed(name) {
  const mod = findModule(name);
  if (mod.hidden) return true;
  const key = name.toLowerCase();
  const { all, names, excluded } = parseFeatures();
  if (excluded.has(key)) return false;
  return all || names.has(key);
}

function isPresent(name) {
  if (presentMemo.has(name)) return presentMemo.get(name);
  const mod = findModule(name);
  let present;
  try {
    require.resolve(path.join(ROOT, mod.entry));
    present = true;
  } catch {
    present = false;
  }
  presentMemo.set(name, present);
  return present;
}

// 每次都從 process.env 重新計算（很便宜，測試可以直接改 env）
function status(name) {
  const mod = findModule(name);
  if (!isPresent(name)) return { name, state: 'absent', detail: null };
  if (!isListed(name)) return { name, state: 'excluded', detail: 'FEATURES 未包含' };
  for (const dep of mod.requires ?? []) {
    const depStatus = status(dep);
    if (depStatus.state !== 'on') {
      const detail = depStatus.detail ? `需要先啟用 ${dep}（${depStatus.detail}）` : `需要先啟用 ${dep}`;
      return { name, state: 'needs', detail };
    }
  }
  const missing = mod.missing?.();
  if (missing) return { name, state: 'unconfigured', detail: missing };
  return { name, state: 'on', detail: null };
}

function isEnabled(name) {
  return status(name).state === 'on';
}

// 只有啟用時才 require；require 時丟出的錯誤照常往上丟
function get(name) {
  if (!isEnabled(name)) return null;
  return require(path.join(ROOT, findModule(name).entry));
}

function load(rel) {
  return require(path.join(ROOT, rel));
}

function intents() {
  const set = new Set(['Guilds']);
  for (const mod of MODULES) {
    if (!mod.intents?.length || !isEnabled(mod.name)) continue;
    for (const intent of mod.intents) set.add(intent);
  }
  const rank = i => (INTENT_ORDER.includes(i) ? INTENT_ORDER.indexOf(i) : INTENT_ORDER.length);
  return [...set].sort((a, b) => rank(a) - rank(b));
}

// 依清單順序 setup 啟用的模組；沒啟用的回報 off（檔案不存在的不回報）。回傳已啟用的名稱。
function setupModules(client, report) {
  if (!report) report = require('./bootSummary').report;
  const enabled = [];
  for (const mod of MODULES) {
    if (mod.hidden) continue;
    const { state, detail } = status(mod.name);
    if (state === 'absent') continue;
    if (state !== 'on') {
      report(mod.label, 'off', detail);
      continue;
    }
    mod.setup?.(get(mod.name), client);
    enabled.push(mod.name);
  }
  const { unknown } = parseFeatures();
  if (unknown.length) {
    report('FEATURES', 'warn', `不認得的模組：${unknown.join(', ')}（可用：${list().join(', ')}）`);
  }
  return enabled;
}

function _reset() {
  presentMemo.clear();
}

module.exports = {
  ROOT,
  INTENT_ORDER,
  parseFeatures,
  isListed,
  isPresent,
  status,
  isEnabled,
  get,
  load,
  intents,
  setupModules,
  list,
  _MODULES: MODULES,
  _reset,
};

// 給 docker/entrypoint.sh 用：決定 supervisord 要不要自動啟動 oww-server 和 bgutil-pot
if (require.main === module && process.argv[2] === 'supervisor') {
  process.stdout.write(`OWW_AUTOSTART=${isEnabled('stt')}\n`);
  process.stdout.write(`BGUTIL_AUTOSTART=${isEnabled('music')}\n`);
}
