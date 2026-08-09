'use strict';

const path = require('path');
const { getActiveModel } = require('./models');
const { getCached, putCache } = require('./cache');
const {
  checkSoVITSHealth, generateSoVITS, reportSovitsSuccess, reportSovitsFailure
} = require('./sovitsClient');
const { resolveVoice, generateEdgeTTS, getHasEdgeTTS } = require('./edgeTTS');

/**
 * 合成單一文字片段。
 * 先查健康狀態，不可用時直接走 edge-tts，不等 SoVITS timeout。
 * 合成前查快取，命中則直接返回。
 */
async function generateTTS(text, filename, guildId) {
  const model    = getActiveModel(guildId);
  const tempDir  = path.dirname(filename);

  // 查詢快取
  const cached = await getCached(text, model.key, tempDir);
  if (cached) return cached;

  // 先做健康檢查，已知不可用時跳過 SoVITS
  const healthy = await checkSoVITSHealth();

  if (healthy) {
    try {
      const sovitsFile = filename.replace(/\.\w+$/, '_sovits.wav');
      await generateSoVITS(text, sovitsFile, guildId);
      // SoVITS 成功：標記健康
      reportSovitsSuccess();
      console.log(`✅ [SoVITS][${model.name}] 生成成功: ${text.slice(0, 20)}...`);
      const result = { file: sovitsFile, engine: 'sovits', model: model.name };
      putCache(text, model.key, result);
      return result;
    } catch (err) {
      // SoVITS 失敗：標記不可用，下次直接走 fallback
      reportSovitsFailure();
      console.warn(`⚠️ [SoVITS] 失敗 (${err.message})，切換至 edge-tts`);
    }
  } else {
    console.log(`⚡ [SoVITS] 已知不可用，直接使用 edge-tts`);
  }

  if (!getHasEdgeTTS()) throw new Error('SoVITS 不可用且 edge-tts 未安裝');

  const voice    = resolveVoice(text, guildId);
  const edgeFile = filename.replace(/\.\w+$/, '_edge.mp3');
  await generateEdgeTTS(text, edgeFile, voice);
  console.log(`✅ [edge-tts] 生成成功: ${text.slice(0, 20)}...`);
  const result = { file: edgeFile, engine: 'edge', voice };
  putCache(text, model.key, result);
  return result;
}

module.exports = { generateTTS };
