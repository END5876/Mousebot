'use strict';

const http = require('http');
const dns  = require('dns').promises;
const logger = require('../../../utils/logger');

// ── SoVITS 連線設定 ──────────────────────────────────────
const SOVITS_HOST = process.env.SOVITS_HOST || 'localhost';
const SOVITS_PORT = parseInt(process.env.SOVITS_PORT) || 9880;

// SoVITS 健康狀態追蹤
// 記錄 SoVITS 是否可用，避免每次都等 timeout 才 fallback
let sovitsHealthy        = true;   // 樂觀預設可用
let sovitsLastCheckAt    = 0;
const SOVITS_HEALTH_INTERVAL_MS = 30_000;  // 每 30 秒重新探測
const SOVITS_CONNECT_TIMEOUT_MS = 3_000;   // TCP 連線逾時（原本 2000，稍微放寬）
const SOVITS_RECEIVE_TIMEOUT_MS = 30_000;  // 音訊接收逾時

// ════════════════════════════════════════════════════════
//  DNS 快取
// ════════════════════════════════════════════════════════
let cachedSoVITSIP = null;
let cacheExpireAt  = 0;
const DNS_CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveSoVITSHost() {
  const now = Date.now();
  if (cachedSoVITSIP && now < cacheExpireAt) return cachedSoVITSIP;
  try {
    const resolver = new dns.Resolver();
    resolver.setServers(['8.8.8.8', '1.1.1.1']);
    const addresses = await resolver.resolve4(SOVITS_HOST);
    cachedSoVITSIP = addresses[0];
    cacheExpireAt  = now + DNS_CACHE_TTL_MS;
    logger.debug('SoVITS-DNS', `${SOVITS_HOST} → ${cachedSoVITSIP}`);
    return cachedSoVITSIP;
  } catch (err) {
    logger.debug('SoVITS-DNS', `解析失敗: ${err.message}，使用原始 hostname`);
    return SOVITS_HOST;
  }
}

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

// 由 generate.js 在合成成功/失敗後回報結果，讓健康狀態能即時反映
// （原本 ttsHandler.js 是直接在 generateTTS 內操作 sovitsHealthy 變數）
function reportSovitsSuccess() {
  sovitsHealthy = true;
}

function reportSovitsFailure() {
  sovitsHealthy = false;
  sovitsLastCheckAt = Date.now();
}

module.exports = {
  SOVITS_HOST,
  SOVITS_PORT,
  resolveSoVITSHost,
  checkSoVITSHealth,
  switchSoVITSWeights,
  generateSoVITS,
  reportSovitsSuccess,
  reportSovitsFailure
};
