// handlers/voice/tts/generate.js
// 職責：TTS 生成核心（SoVITS 優先、edge-tts fallback）、健康檢查、模型切換

const { spawn } = require('child_process');
const http = require('http');
const {
  state,
  SOVITS_HOST, SOVITS_PORT,
  SOVITS_CONNECT_TIMEOUT_MS, SOVITS_RECEIVE_TIMEOUT_MS, SOVITS_HEALTH_INTERVAL_MS,
  resolveSoVITSHost, getActiveModel, resolveVoice, detectLanguage,
} = require('./config');
const { getCached, putCache } = require('./cache');

// SoVITS 健康狀態追蹤
// 記錄 SoVITS 是否可用，避免每次都等 timeout 才 fallback
let sovitsHealthy        = true;   // 樂觀預設可用
let sovitsLastCheckAt    = 0;

async function switchSoVITSWeights(gptWeights, sovitsWeights) {
  const resolvedIP = await resolveSoVITSHost();

  const callAPI = (apiPath) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(new Error('切換模型逾時')); }, 15000);
    const req = http.request({
      hostname: resolvedIP, port: SOVITS_PORT, path: apiPath,
      method: 'GET', headers: { Host: SOVITS_HOST },
    }, (res) => {
      clearTimeout(timer);
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(body);
        else reject(new Error(`HTTP ${res.statusCode}: ${body}`));
      });
    });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.end();
  });

  console.log(`🔄 [SoVITS] 切換 GPT: ${gptWeights}`);
  await callAPI(`/set_gpt_weights?weights_path=${encodeURIComponent(gptWeights)}`);
  console.log(`🔄 [SoVITS] 切換 SoVITS: ${sovitsWeights}`);
  await callAPI(`/set_sovits_weights?weights_path=${encodeURIComponent(sovitsWeights)}`);
}

// ════════════════════════════════════════════════════════
//  SoVITS 健康檢查
//  定期探測 SoVITS 是否可用，避免每次都等 timeout 才 fallback
// ════════════════════════════════════════════════════════
async function checkSoVITSHealth() {
  const now = Date.now();
  if (now - sovitsLastCheckAt < SOVITS_HEALTH_INTERVAL_MS) return sovitsHealthy;

  sovitsLastCheckAt = now;
  const resolvedIP  = await resolveSoVITSHost();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      req.destroy();
      if (sovitsHealthy) console.warn('⚠️ [SoVITS] 健康檢查逾時，標記為不可用');
      sovitsHealthy = false;
      resolve(false);
    }, SOVITS_CONNECT_TIMEOUT_MS);

    const req = http.request(
      { hostname: resolvedIP, port: SOVITS_PORT, path: '/', method: 'GET', headers: { Host: SOVITS_HOST } },
      (res) => {
        clearTimeout(timer);
        res.resume();
        if (!sovitsHealthy) console.log('✅ [SoVITS] 服務已恢復');
        sovitsHealthy = true;
        resolve(true);
      }
    );
    req.on('error', () => {
      clearTimeout(timer);
      if (sovitsHealthy) console.warn('⚠️ [SoVITS] 健康檢查失敗，標記為不可用');
      sovitsHealthy = false;
      resolve(false);
    });
    req.end();
  });
}

// ════════════════════════════════════════════════════════
//  TTS 生成核心
// ════════════════════════════════════════════════════════
async function generateSoVITS(text, filename, guildId) {
  const resolvedIP = await resolveSoVITSHost();
  const model = getActiveModel(guildId);

  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      text, text_lang: model.text_lang, ref_audio_path: model.ref_audio,
      prompt_lang: model.prompt_lang, prompt_text: model.prompt_text, media_type: 'wav',
    });

    let settled = false;
    function done(err) {
      if (settled) return; settled = true;
      clearTimeout(connectTimer); clearTimeout(receiveTimer);
      if (err) reject(err); else resolve();
    }

    const connectTimer = setTimeout(() => {
      req.destroy(new Error('SoVITS 連線逾時（Port 無回應，Server 可能關機）'));
    }, SOVITS_CONNECT_TIMEOUT_MS);
    let receiveTimer = null;

    const req = http.request({
      hostname: resolvedIP, port: SOVITS_PORT,
      path: `/tts?${params.toString()}`, method: 'GET', headers: { Host: SOVITS_HOST },
    }, (res) => {
      if (res.statusCode !== 200) { done(new Error(`SoVITS HTTP ${res.statusCode}`)); res.resume(); return; }
      receiveTimer = setTimeout(() => {
        req.destroy(new Error('SoVITS 音訊接收逾時（處理超過 30 秒）'));
      }, SOVITS_RECEIVE_TIMEOUT_MS);
      const fs = require('fs');
      const fileStream = fs.createWriteStream(filename);
      res.pipe(fileStream);
      fileStream.on('finish', () => done(null));
      fileStream.on('error',  (err) => done(err));
    });

    req.on('socket', (socket) => {
      if (!socket.connecting) {
        clearTimeout(connectTimer);
      } else {
        socket.on('connect', () => {
          clearTimeout(connectTimer);
          console.log('🔌 [SoVITS] TCP 連線成功，等待推理完成...');
        });
      }
    });

    req.on('error', (err) => done(err));
    req.end();
  });
}

function generateEdgeTTS(text, filename, voice) {
  return new Promise((resolve, reject) => {
    const proc = spawn('edge-tts', ['--voice', voice, '--text', text, '--write-media', filename, '--rate', '+10%']);
    proc.on('close', (code) => { if (code === 0) resolve(); else reject(new Error(`edge-tts 退出碼: ${code}`)); });
    proc.on('error', reject);
  });
}

/**
 * 合成單一文字片段。
 * 先查健康狀態，不可用時直接走 edge-tts，不等 SoVITS timeout。
 * 合成前查快取，命中則直接返回。
 */
async function generateTTS(text, filename, guildId) {
  const model    = getActiveModel(guildId);
  const path     = require('path');
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
      sovitsHealthy = true;
      console.log(`✅ [SoVITS][${model.name}] 生成成功: ${text.slice(0, 20)}...`);
      const result = { file: sovitsFile, engine: 'sovits', model: model.name };
      putCache(text, model.key, result);
      return result;
    } catch (err) {
      // SoVITS 失敗：標記不可用，下次直接走 fallback
      sovitsHealthy     = false;
      sovitsLastCheckAt = Date.now();
      console.warn(`⚠️ [SoVITS] 失敗 (${err.message})，切換至 edge-tts`);
    }
  } else {
    console.log(`⚡ [SoVITS] 已知不可用，直接使用 edge-tts`);
  }

  if (!state.hasEdgeTTS) throw new Error('SoVITS 不可用且 edge-tts 未安裝');

  const voice    = resolveVoice(text, guildId);
  const edgeFile = filename.replace(/\.\w+$/, '_edge.mp3');
  await generateEdgeTTS(text, edgeFile, voice);
  console.log(`✅ [edge-tts] 生成成功: ${text.slice(0, 20)}...`);
  const result = { file: edgeFile, engine: 'edge', voice };
  putCache(text, model.key, result);
  return result;
}

module.exports = {
  switchSoVITSWeights,
  checkSoVITSHealth,
  generateSoVITS,
  generateEdgeTTS,
  generateTTS,
  // 供 commands.js 顯示開機摘要使用
  getSovitsHealthySync: () => sovitsHealthy,
};
