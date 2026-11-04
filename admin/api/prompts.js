'use strict';
// admin/api/prompts.js — AI 人格 prompt（data/prompts/），存檔後由 promptStore 立即生效

const promptStore = require('../../handlers/ai/promptStore');
const { listUserModes } = require('../../handlers/ai/modeSelector');
const aiScope = require('../../handlers/ai/aiScope');
const { LOVER_MODE_USER_IDS, DEVELOPER_MODE_USER_IDS, DEFAULT_MODE } = require('../../handlers/ai/aiSettings');
const { HttpError, str, oneOf } = require('../http');

// DEFAULT_MODE（aiSettings）是找不到模式時的退路（aiCore.js 的 FALLBACK_MODE、modeSelector 的預設），刪掉它所有人都會變成沒有人格
const MAX_PROMPT = 30000;
const HISTORY_KINDS = ['modes', 'shared'];

function modeKey(params) {
  const key = params.key;
  if (!promptStore.MODE_KEY_RE.test(key)) throw new HttpError(400, '模式代號只能使用英數、底線、連字號（1~32 字）');
  return key;
}

function historyTarget(params) {
  const kind = oneOf(params.kind, HISTORY_KINDS, '版本類型');
  const key = kind === 'modes' ? modeKey(params) : oneOf(params.key, promptStore.SHARED_KEYS, '共用規則');
  return { kind, key };
}

// 每個模式目前有多少人在用：/ai mode 指定的人，加上環境變數指定的特殊身分，
// 再加上被 /ai scope 指定為單一人格的伺服器／頻道（每個範圍算一次）
function modeUsage() {
  const counts = {};
  const add = (mode) => { counts[mode] = (counts[mode] ?? 0) + 1; };
  const overrides = listUserModes();
  Object.values(overrides).forEach(add);
  LOVER_MODE_USER_IDS.filter((id) => !overrides[id]).forEach(() => add('lover'));
  DEVELOPER_MODE_USER_IDS.filter((id) => !overrides[id]).forEach(() => add('developer'));
  aiScope.listScopePersonas().forEach(add);
  return counts;
}

module.exports = function registerPrompts(router) {
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
      shared: promptStore.SHARED_KEYS.map((key) => ({ key, length: promptStore.getShared(key).length })),
      deleted: promptStore.listDeletedModes().sort(),
    };
  });

  router.get('/api/prompts/modes/:key', ({ params }) => {
    const key = modeKey(params);
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
    const key = modeKey(params);
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
    const key = modeKey(params);
    if (key === DEFAULT_MODE) throw new HttpError(400, `「${DEFAULT_MODE}」是預設模式，找不到其他模式時都會用它，不能刪除`);
    const name = promptStore.getMode(key)?.name ?? key;
    if (aiScope.listScopePersonas().includes(key)) {
      throw new HttpError(400, `「${name}」正被單一人格範圍使用中，請先用 /ai scope 或 AI 設定頁改掉再刪除`);
    }
    if (!promptStore.deleteMode(key)) throw new HttpError(404, '找不到這個模式，可能已經被刪除');
    audit(`刪除 AI 人格「${name}」（${key}）`);
  });

  router.get('/api/prompts/shared/:key', ({ params }) => {
    if (!promptStore.SHARED_KEYS.includes(params.key)) throw new HttpError(404, '找不到這個共用規則');
    return { key: params.key, text: promptStore.getShared(params.key) };
  });

  router.put('/api/prompts/shared/:key', ({ params, body, audit }) => {
    if (!promptStore.SHARED_KEYS.includes(params.key)) throw new HttpError(404, '找不到這個共用規則');
    promptStore.saveShared(params.key, str(body.text, '規則內容', { max: MAX_PROMPT, allowEmpty: true }));
    audit(`修改共用規則 ${params.key}.md`);
  });

  // ── 版本紀錄（每次覆寫或刪除前自動保留，最近 20 版）────────
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
};
