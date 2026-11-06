'use strict';

// AI 範圍（多人格／單一人格）的解析、切換與持久化；人格 front matter 的 singleScope。
// 資料目錄用 MOUSEBOT_DATA_DIR 指到暫存資料夾，不碰正式的 data/。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-scope-'));
process.env.MOUSEBOT_DATA_DIR = TMP;
process.env.LOG_LEVEL = 'error';

const aiScope = require('../handlers/ai/aiScope');
const { DEFAULT_MODE } = require('../handlers/ai/aiSettings');

// 假的人格清單：lover 設了 singleScope: off
let fakeModes;
function resetModes() {
  fakeModes = {
    default: { name: '預設' },
    chat: { name: '聊天' },
    lover: { name: '戀人', singleScope: 'off' },
  };
}
const fresh = () => aiScope._reset({ modeLookup: (k) => fakeModes[k] ?? null });

const G = '100000000000000001';
const G2 = '100000000000000002';
const C = '200000000000000001';
const C2 = '200000000000000002';
const T = '300000000000000001'; // C 底下的討論串

test.beforeEach(() => {
  resetModes();
  fs.rmSync(path.join(TMP, 'aiScope.json'), { force: true });
  fs.rmSync(path.join(TMP, 'aiScope.json.bak'), { force: true });
  fresh();
});
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('require 與讀取時不寫入任何檔案', () => {
  aiScope.getScope(G, C);
  assert.equal(fs.existsSync(path.join(TMP, 'aiScope.json')), false);
});

test('預設是多人格；DM 一律多人格', () => {
  const s = aiScope.getScope(G, C);
  assert.equal(s.kind, 'multi');
  assert.equal(s.scopeKey, null);
  assert.equal(s.source, 'default');

  aiScope.setGuildScope(G, { kind: 'single', persona: 'chat' }, 'u1');
  const dm = aiScope.getScope(null, C);
  assert.equal(dm.kind, 'multi');
  assert.equal(dm.source, 'dm');
});

test('解析順序：頻道 > 伺服器 > 預設；scopeKey 依命中層級', () => {
  aiScope.setGuildScope(G, { kind: 'single', persona: 'chat' }, 'u1');
  let s = aiScope.getScope(G, C);
  assert.equal(s.kind, 'single');
  assert.equal(s.persona, 'chat');
  assert.equal(s.scopeKey, `g:${G}`);
  assert.equal(s.source, 'guild');

  // 別的伺服器不受影響
  assert.equal(aiScope.getScope(G2, C2).kind, 'multi');

  aiScope.setChannelScope(C, G, { kind: 'single', persona: 'default' }, 'u1');
  s = aiScope.getScope(G, C);
  assert.equal(s.persona, 'default');
  assert.equal(s.scopeKey, `c:${C}`);
  assert.equal(s.source, 'channel');

  // 頻道明確設成多人格，伺服器是單一人格也不影響這個頻道
  aiScope.setChannelScope(C2, G, { kind: 'multi' }, 'u1');
  s = aiScope.getScope(G, C2);
  assert.equal(s.kind, 'multi');
  assert.equal(s.source, 'channel');
});

test('討論串跟著父頻道（共用同一個範圍），自己的覆寫優先', () => {
  aiScope.setChannelScope(C, G, { kind: 'single', persona: 'chat' }, 'u1');
  let s = aiScope.getScope(G, T, C);
  assert.equal(s.kind, 'single');
  assert.equal(s.scopeKey, `c:${C}`);
  assert.equal(s.source, 'parent');

  // getScopeForChannel 只有討論串才帶 parentId（一般頻道的 parentId 是分類）
  const thread = { id: T, guildId: G, parentId: C, isThread: () => true };
  assert.equal(aiScope.getScopeForChannel(thread).scopeKey, `c:${C}`);
  const normal = { id: C2, guildId: G, parentId: C, isThread: () => false };
  assert.equal(aiScope.getScopeForChannel(normal).kind, 'multi');
  assert.equal(aiScope.getScopeForChannel(null, G).kind, 'multi');

  aiScope.setChannelScope(T, G, { kind: 'multi' }, 'u1');
  s = aiScope.getScope(G, T, C);
  assert.equal(s.kind, 'multi');
  assert.equal(s.source, 'channel');
});

test('人格檔被刪除時退回 DEFAULT_MODE', () => {
  aiScope.setGuildScope(G, { kind: 'single', persona: 'chat' }, 'u1');
  delete fakeModes.chat;
  const s = aiScope.getScope(G, C);
  assert.equal(s.kind, 'single');
  assert.equal(s.persona, DEFAULT_MODE);
});

test('設定驗證：single 必須有存在的人格；不能什麼都不改', () => {
  assert.equal(aiScope.setGuildScope(G, { kind: 'single' }, 'u1').ok, false);
  assert.equal(aiScope.setGuildScope(G, { kind: 'single', persona: 'nope' }, 'u1').ok, false);
  assert.equal(aiScope.setGuildScope(G, { kind: 'weird' }, 'u1').ok, false);
  assert.equal(aiScope.setGuildScope(G, {}, 'u1').ok, false);
  assert.equal(aiScope.setGuildScope(G, { persona: 'chat' }, 'u1').ok, false);
  assert.equal(fs.existsSync(path.join(TMP, 'aiScope.json')), false);
});

test('每次切換 epoch 變大、changedAt 遞增；設成一樣的不動', () => {
  const e0 = aiScope.getScope(G, C).epoch;
  aiScope.setGuildScope(G, { kind: 'single', persona: 'chat' }, 'u1');
  const s1 = aiScope.getScope(G, C);
  assert.ok(s1.epoch > e0);
  assert.ok(s1.changedAt > 0);

  aiScope.setGuildScope(G, { kind: 'single', persona: 'chat' }, 'u1');
  assert.equal(aiScope.getScope(G, C).epoch, s1.epoch);

  aiScope.setGuildScope(G, { kind: 'single', persona: 'default' }, 'u1');
  const s2 = aiScope.getScope(G, C);
  assert.ok(s2.epoch > s1.epoch);
  assert.ok(s2.changedAt > s1.changedAt);

  aiScope.setGuildScope(G, { kind: 'multi' }, 'u1');
  const s3 = aiScope.getScope(G, C);
  assert.equal(s3.kind, 'multi');
  assert.ok(s3.epoch > s2.epoch);
});

test('頻道 reset 留下 tombstone：changedAt 不會退回伺服器較舊的值', () => {
  aiScope.setGuildScope(G, { kind: 'multi' }, 'u1');
  const guildChangedAt = aiScope.getScope(G, C).changedAt;
  aiScope.setChannelScope(C, G, { kind: 'single', persona: 'chat' }, 'u1');
  const single = aiScope.getScope(G, C);

  const res = aiScope.setChannelScope(C, G, null, 'u1');
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  const after = aiScope.getScope(G, C);
  assert.equal(after.kind, 'multi');
  assert.equal(after.source, 'guild');
  assert.ok(after.changedAt >= single.changedAt);
  assert.ok(after.changedAt > guildChangedAt);
  assert.ok(after.epoch > single.epoch);

  // 沒有設定過的頻道 reset：不做事
  assert.equal(aiScope.setChannelScope(C2, G, null, 'u1').changed, false);
});

test('重複 reset 不算改變；設成跟原本一樣也不算', () => {
  aiScope.setChannelScope(C, G, { kind: 'multi' }, 'u1');
  assert.equal(aiScope.setChannelScope(C, G, null, 'u1').changed, true);
  assert.equal(aiScope.setChannelScope(C, G, null, 'u1').changed, false);

  aiScope.setGuildScope(G, { kind: 'single', persona: 'chat' }, 'u1');
  assert.equal(aiScope.setGuildScope(G, { kind: 'single', persona: 'chat' }, 'u1').changed, false);
  assert.equal(aiScope.setGuildScope(G, { kind: 'single', persona: 'default' }, 'u1').changed, true);
});

test('伺服器 reset 後回到預設多人格，epoch 仍然變大', () => {
  aiScope.setGuildScope(G, { kind: 'single', persona: 'chat' }, 'u1');
  const s1 = aiScope.getScope(G, C);
  aiScope.setGuildScope(G, null, 'u1');
  const s2 = aiScope.getScope(G, C);
  assert.equal(s2.kind, 'multi');
  assert.ok(s2.epoch > s1.epoch);
  assert.ok(s2.changedAt >= s1.changedAt);
});

test('伺服器切換不影響有自己覆寫的頻道', () => {
  aiScope.setChannelScope(C, G, { kind: 'single', persona: 'chat' }, 'u1');
  const s1 = aiScope.getScope(G, C);
  aiScope.setGuildScope(G, { kind: 'single', persona: 'default' }, 'u1');
  const s2 = aiScope.getScope(G, C);
  assert.equal(s2.epoch, s1.epoch);
  assert.equal(s2.persona, 'chat');
});

test('singleScope: off 的人格只有擁有者能選', () => {
  assert.equal(aiScope.isPersonaAllowedInSingle('lover', false), false);
  assert.equal(aiScope.isPersonaAllowedInSingle('lover', true), true);
  assert.equal(aiScope.isPersonaAllowedInSingle('chat', false), true);
  assert.equal(aiScope.isPersonaAllowedInSingle('nope', true), false);
});

test('寫檔後重新載入（模擬重啟）結果一致；listScopePersonas', () => {
  aiScope.setGuildScope(G, { kind: 'single', persona: 'chat' }, 'u1');
  aiScope.setChannelScope(C, G, { kind: 'single', persona: 'default' }, 'u2');
  aiScope.setChannelScope(C2, G, { kind: 'single', persona: 'default' }, 'u2');
  aiScope.setChannelScope(C2, G, null, 'u2');
  const before = [aiScope.getScope(G, C), aiScope.getScope(G, C2)];

  fresh();
  const after = [aiScope.getScope(G, C), aiScope.getScope(G, C2)];
  assert.deepEqual(after, before);
  assert.deepEqual(aiScope.listScopePersonas().sort(), ['chat', 'default']);
  assert.equal(aiScope.getChannelEntry(C).changedBy, 'u2');

  // 重啟後的切換 epoch 仍然繼續往上加
  aiScope.setChannelScope(C, G, { kind: 'multi' }, 'u1');
  assert.ok(aiScope.getScope(G, C).epoch > before[0].epoch);
});

test('壞掉的設定檔：single 沒有人格就當作繼承', () => {
  fs.writeFileSync(path.join(TMP, 'aiScope.json'), JSON.stringify({
    guilds: { [G]: { kind: 'single', epoch: 3, changedAt: 5 } },
    channels: { [C]: 'garbage' },
  }));
  fresh();
  const s = aiScope.getScope(G, C);
  assert.equal(s.kind, 'multi');
  assert.equal(s.epoch, 3);
});

// ── 人格 front matter：singleScope ─────────────────
test('promptStore：解析與存檔保留 singleScope', () => {
  const { parseModeFile, serializeModeFile, mergeModeData } = require('../handlers/ai/promptStore')._internal;
  const raw = '---\nname: 戀人\nsingleScope: OFF\n---\n本文\n';
  const parsed = parseModeFile('lover', raw);
  assert.equal(parsed.singleScope, 'off');

  const bad = parseModeFile('x', '---\nsingleScope: maybe\n---\n本文');
  assert.equal(bad.singleScope, undefined);

  // /ai prompt edit 不帶這個欄位：保留原值
  const merged = mergeModeData('lover', parsed, { prompt: '新本文', name: '' });
  assert.equal(merged.singleScope, 'off');
  const text = serializeModeFile(merged);
  assert.match(text, /singleScope: off/);
  assert.equal(parseModeFile('lover', text).singleScope, 'off');

  // 管理面板送空字串＝移除
  const cleared = mergeModeData('lover', parsed, { prompt: 'p', singleScope: '' });
  assert.equal(cleared.singleScope, undefined);
  assert.doesNotMatch(serializeModeFile(cleared), /singleScope/);
});

test('promptStore：_group 是共用規則，缺檔時回傳空字串', () => {
  const promptStore = require('../handlers/ai/promptStore');
  assert.ok(promptStore.SHARED_KEYS.includes('_group'));
  assert.equal(promptStore.getShared('_group'), '');
});
