'use strict';
// admin/api/responses.js — 自訂關鍵字回應（data/responses.json）

const { listResponses, upsertResponse, removeResponse, reorderResponses } = require('../../handlers/responseHandler');
const { HttpError, str, oneOf } = require('../http');

const TYPES = ['exact', 'contains'];
const TYPE_LABEL = { exact: '完全匹配', contains: '包含匹配' };
const MAX_KEYWORD = 500;
const MAX_MESSAGE = 2000; // Discord 單則訊息上限
const MAX_MESSAGES = 10;

function parseMessages(value) {
  if (!Array.isArray(value)) throw new HttpError(400, '回應內容格式不正確');
  const messages = value.map((m) => str(m, '回應內容', { max: MAX_MESSAGE, allowEmpty: true })).filter(Boolean);
  if (!messages.length) throw new HttpError(400, '至少要有一則回應');
  if (messages.length > MAX_MESSAGES) throw new HttpError(400, `最多 ${MAX_MESSAGES} 則回應`);
  return messages;
}

module.exports = function registerResponses(router) {
  router.get('/api/responses', () => listResponses());

  // body：{ type, keyword, messages: string[], from?: { type, keyword }, overwrite?: boolean }
  // 多則回應會依序送出（與 /response add 用 | 分隔的效果相同）
  router.put('/api/responses', ({ body, audit }) => {
    const type = oneOf(body.type, TYPES, '匹配類型');
    const keyword = str(body.keyword, '關鍵字', { max: MAX_KEYWORD });
    if (keyword === '__proto__') throw new HttpError(400, '這個關鍵字是保留字，不能使用');
    const messages = parseMessages(body.messages);
    const from = body.from
      ? { type: oneOf(body.from.type, TYPES, '原本的匹配類型'), keyword: str(body.from.keyword, '原本的關鍵字', { max: MAX_KEYWORD, trim: false }) }
      : null;

    let result;
    try {
      result = upsertResponse({
        type,
        keyword,
        value: messages.length === 1 ? messages[0] : messages,
        from,
        overwrite: body.overwrite === true,
      });
    } catch (err) {
      if (err.code === 'EEXIST') throw new HttpError(409, err.message);
      throw err;
    }

    const renamed = from && (from.type !== type || from.keyword !== keyword);
    audit(result.created
      ? `新增自訂回應（${TYPE_LABEL[type]}）「${keyword}」`
      : renamed
        ? `修改自訂回應「${from.keyword}」→（${TYPE_LABEL[type]}）「${keyword}」`
        : `修改自訂回應（${TYPE_LABEL[type]}）「${keyword}」`);
    return result;
  });

  // body：{ type, keywords: string[] }——該類全部關鍵字的新順序（包含匹配由上往下比對，第一條符合的生效）
  router.put('/api/responses/order', ({ body, audit }) => {
    const type = oneOf(body.type, TYPES, '匹配類型');
    if (!Array.isArray(body.keywords) || body.keywords.some((k) => typeof k !== 'string')) {
      throw new HttpError(400, '順序格式不正確');
    }
    try {
      reorderResponses(type, body.keywords);
    } catch (err) {
      if (err.code === 'ECONFLICT') throw new HttpError(409, err.message);
      if (err.code === 'EINVAL') throw new HttpError(400, err.message);
      throw err;
    }
    audit(`調整${TYPE_LABEL[type]}的規則順序`);
  });

  router.delete('/api/responses', ({ query, audit }) => {
    const type = oneOf(query.get('type'), TYPES, '匹配類型');
    const keyword = query.get('keyword') ?? '';
    if (!removeResponse(type, keyword)) throw new HttpError(404, '找不到這條規則，可能已經被刪除');
    audit(`刪除自訂回應（${TYPE_LABEL[type]}）「${keyword}」`);
  });
};
