'use strict';
// admin/api/prompts.js — AI 人格 prompt（data/prompts/），存檔後由 promptStore 立即生效
//
// 共用規則的清單是 promptStore.SHARED_KEYS，語音（voice）沒開時去掉 _voice（register 時決定）。
// 範圍鎖定（persona.getLock()，見 handlers/ai/persona.js；register 時讀一次）時只有一個人格：
//   - 清單只列出鎖定的人格；只能編輯它，不能新增其他人格、不能刪除
//   - PUT 時忽略 singleScope（鎖定時沒有意義，不改檔案裡原本的值）
//   - 回應多了 singlePersona；deleted 只列鎖定的人格（被刪掉過才列，可以還原）
// 不鎖定時才 lazy require aiScope、modeSelector（使用人數、刪除前檢查要用）。
// 兩種情況都附上內建內容（人格檔或 _group.md 不存在時 persona.js 實際使用的），網頁可以從內建內容建立檔案：
//   - builtin：人格檔（鎖定的人格／DEFAULT_MODE）不存在時是內建人格，否則 null
//   - shared[].builtin、GET /api/prompts/shared/:key 的 builtinText：_group.md 空白時是內建群聊規則

const promptStore = require('../../handlers/ai/promptStore');
const persona = require('../../handlers/ai/persona');
const features = require('../../utils/features');
const { DEFAULT_MODE } = require('../../handlers/ai/aiSettings');
const { HttpError, str, oneOf } = require('../http');

// DEFAULT_MODE（aiSettings）是找不到模式時的退路（persona.js、modeSelector 的預設），刪掉它所有人都會變成沒有人格
const MAX_PROMPT = 30000;
const HISTORY_KINDS = ['modes', 'shared'];

function validKey(key) {
  if (!promptStore.MODE_KEY_RE.test(key)) throw new HttpError(400, '模式代號只能使用英數、底線、連字號（1~32 字）');
  return key;
}

// 內建人格（人格檔不存在時 persona.js 實際使用的）；檔案存在時是 null
function builtinPersona(key) {
  if (persona.hasPersonaFile(key)) return null;
  return {
    key,
    name: persona.getPersonaName(key),
    clearMemoryMessage: persona.getClearMessage(key),
    prompt: persona.BUILTIN_PERSONA_PROMPT,
  };
}

const builtinShared = (key) => (key === '_group' && !promptStore.getShared('_group') ? persona.getGroupRules() : null);

module.exports = function registerPrompts(router) {
  const lock = persona.getLock();
  const sharedKeys = promptStore.SHARED_KEYS.filter((k) => k !== '_voice' || features.isEnabled('voice'));
  const sharedList = () => sharedKeys.map((key) => ({ key, length: promptStore.getShared(key).length, builtin: !!builtinShared(key) }));

  if (lock) registerLocked(router, lock, sharedKeys, sharedList);
  else registerMulti(router, sharedKeys, sharedList);

  router.get('/api/prompts/shared/:key', ({ params }) => {
    if (!sharedKeys.includes(params.key)) throw new HttpError(404, '找不到這個共用規則');
    return { key: params.key, text: promptStore.getShared(params.key), builtinText: builtinShared(params.key) };
  });

  router.put('/api/prompts/shared/:key', ({ params, body, audit }) => {
    if (!sharedKeys.includes(params.key)) throw new HttpError(404, '找不到這個共用規則');
    promptStore.saveShared(params.key, str(body.text, '規則內容', { max: MAX_PROMPT, allowEmpty: true }));
    audit(`修改共用規則 ${params.key}.md`);
  });
};

// ── 版本紀錄（每次覆寫或刪除前自動保留，最近 20 版）────────
function registerHistory(router, historyTarget) {
  router.get('/api/prompts/history/:kind/:key', ({ params }) => {
    const { kind, key } = historyTarget(params);
    return { versions: promptStore.listHistory(kind, key) };
  });

  router.get('/api/prompts/history/:kind/:key/:id', ({ params }) => {
    const { kind, key } = historyTarget(params);
    const version = promptStore.getHistoryVersion(kind, key, params.id);
    if (!version) throw new HttpError(404, '找不到這個版本');
    return version;
  });
}

// 鎖定：只用一個人格（lock.persona）
function registerLocked(router, lock, sharedKeys, sharedList) {
  const key0 = lock.persona;

  // 只接受鎖定的人格：其他代號在這隻 Bot 不會被用到
  function modeKey(params) {
    const key = validKey(params.key);
    if (key !== key0) throw new HttpError(400, `這隻 Bot 只使用人格「${key0}」（環境變數 ${lock.source}）`);
    return key;
  }

  router.get('/api/prompts', () => {
    const mode = promptStore.getMode(key0);
    return {
      singlePersona: true,
      defaultMode: key0,
      modes: mode ? [{
        key: key0,
        name: mode.name,
        shortDescription: mode.shortDescription ?? '',
        length: mode.prompt.length,
        users: 0,
      }] : [],
      builtin: builtinPersona(key0),
      shared: sharedList(),
      // 只有鎖定的人格被刪掉過才列出來（可以還原）
      deleted: !mode && promptStore.listDeletedModes().includes(key0) ? [key0] : [],
    };
  });

  router.get('/api/prompts/modes/:key', ({ params }) => {
    const key = modeKey(params);
    const mode = promptStore.getMode(key);
    if (!mode) throw new HttpError(404, '還沒有人格檔，目前用的是內建的通用人格');
    return {
      key,
      name: mode.name,
      shortDescription: mode.shortDescription ?? '',
      clearMemoryMessage: mode.clearMemoryMessage,
      prompt: mode.prompt,
    };
  });

  // body：{ name, shortDescription, clearMemoryMessage, prompt, create? }
  // singleScope 在鎖定時沒有意義：不改檔案裡原本的值
  router.put('/api/prompts/modes/:key', ({ params, body, audit }) => {
    const key = modeKey(params);
    const existed = !!promptStore.getMode(key);
    if (body.create && existed) throw new HttpError(409, `已經有「${key}」這個人格檔`);
    promptStore.saveMode(key, {
      name: str(body.name, '顯示名稱', { max: 100, allowEmpty: true }),
      shortDescription: str(body.shortDescription, '簡短說明', { max: 200, allowEmpty: true }),
      clearMemoryMessage: str(body.clearMemoryMessage, '清除記憶訊息', { max: 500, allowEmpty: true }),
      singleScope: undefined,
      prompt: str(body.prompt, 'Prompt 本文', { max: MAX_PROMPT }),
    });
    audit(`${existed ? '修改' : '建立'} AI 人格「${promptStore.getMode(key)?.name ?? key}」（${key}）`);
    return { created: !existed };
  });

  router.delete('/api/prompts/modes/:key', () => {
    throw new HttpError(400, `這隻 Bot 只有一個人格，不能刪除（要換人格請改環境變數 ${lock.source}）`);
  });

  registerHistory(router, (params) => {
    const kind = oneOf(params.kind, HISTORY_KINDS, '版本類型');
    if (kind === 'modes') return { kind, key: modeKey(params) };
    if (!sharedKeys.includes(params.key)) throw new HttpError(404, '找不到這個共用規則');
    return { kind, key: params.key };
  });
}

// 不鎖定（多人格）
function registerMulti(router, sharedKeys, sharedList) {
  const aiScope = require('../../handlers/ai/aiScope');
  const { listUserModes, listFixedUserModes } = require('../../handlers/ai/modeSelector');

  // 每個模式目前有多少人在用：/ai mode 指定的人，加上 AI_USER_MODE_OVERRIDES 指定的固定人格（已用 /ai mode 設定的人不重複計算），
  // 再加上被 /ai scope 指定為單一人格的伺服器／頻道（每個範圍算一次）
  function modeUsage() {
    const counts = {};
    const add = (mode) => { counts[mode] = (counts[mode] ?? 0) + 1; };
    const overrides = listUserModes();
    Object.values(overrides).forEach(add);
    Object.entries(listFixedUserModes()).filter(([id]) => !overrides[id]).forEach(([, m]) => add(m));
    aiScope.listScopePersonas().forEach(add);
    return counts;
  }

  router.get('/api/prompts', () => {
    const usage = modeUsage();
    return {
      defaultMode: DEFAULT_MODE,
      modes: promptStore.listModes().sort().map((key) => {
        const mode = promptStore.getMode(key);
        return {
          key,
          name: mode.name,
          shortDescription: mode.shortDescription ?? '',
          length: mode.prompt.length,
          users: usage[key] ?? 0,
        };
      }),
      builtin: builtinPersona(DEFAULT_MODE),
      shared: sharedList(),
      deleted: promptStore.listDeletedModes().sort(),
    };
  });

  router.get('/api/prompts/modes/:key', ({ params }) => {
    const key = validKey(params.key);
    const mode = promptStore.getMode(key);
    if (!mode) throw new HttpError(404, '找不到這個模式，可能已經被刪除');
    return {
      key,
      name: mode.name,
      shortDescription: mode.shortDescription ?? '',
      clearMemoryMessage: mode.clearMemoryMessage,
      singleScope: mode.singleScope ?? '',
      prompt: mode.prompt,
    };
  });

  // body：{ name, shortDescription, clearMemoryMessage, singleScope?, prompt, create? }；create 為 true 時代號已存在就拒絕
  // singleScope 沒帶（舊版前端）就保留檔案裡原本的值，空字串＝移除
  router.put('/api/prompts/modes/:key', ({ params, body, audit }) => {
    const key = validKey(params.key);
    const existed = !!promptStore.getMode(key);
    if (body.create && existed) throw new HttpError(409, `已經有「${key}」這個模式代號`);

    const name = str(body.name, '顯示名稱', { max: 100, allowEmpty: true });
    promptStore.saveMode(key, {
      name,
      shortDescription: str(body.shortDescription, '簡短說明', { max: 200, allowEmpty: true }),
      clearMemoryMessage: str(body.clearMemoryMessage, '清除記憶訊息', { max: 500, allowEmpty: true }),
      singleScope: body.singleScope === undefined ? undefined : oneOf(body.singleScope, ['', ...promptStore.SINGLE_SCOPE_VALUES], '群組人格限制'),
      prompt: str(body.prompt, 'Prompt 本文', { max: MAX_PROMPT }),
    });
    audit(`${existed ? '修改' : '建立'} AI 人格「${promptStore.getMode(key)?.name ?? key}」（${key}）`);
    return { created: !existed };
  });

  router.delete('/api/prompts/modes/:key', ({ params, audit }) => {
    const key = validKey(params.key);
    if (key === DEFAULT_MODE) throw new HttpError(400, `「${DEFAULT_MODE}」是預設模式，找不到其他模式時都會用它，不能刪除`);
    const name = promptStore.getMode(key)?.name ?? key;
    if (aiScope.listScopePersonas().includes(key)) {
      throw new HttpError(400, `「${name}」正被單一人格範圍使用中，請先用 /ai scope 或 AI 設定頁改掉再刪除`);
    }
    if (!promptStore.deleteMode(key)) throw new HttpError(404, '找不到這個模式，可能已經被刪除');
    audit(`刪除 AI 人格「${name}」（${key}）`);
  });

  registerHistory(router, (params) => {
    const kind = oneOf(params.kind, HISTORY_KINDS, '版本類型');
    const key = kind === 'modes' ? validKey(params.key) : oneOf(params.key, sharedKeys, '共用規則');
    return { kind, key };
  });
}
