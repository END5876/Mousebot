// utils/heartbeat.js
// 對外部監控服務送「我還活著」的心跳（例如 healthchecks.io、Uptime Kuma 的 Push monitor、
// Better Stack 的 Heartbeat）。外部服務超過一段時間沒收到心跳就通知你。
//
// 和 /healthz 的差別：/healthz 只在 VPS 上給 Docker 與 heal.sh 用，整台 VPS 掛掉、網路斷掉、
// Docker 本身出問題時沒有人會發現；心跳是從 Bot 往外送，任何一環斷掉外部監控都會察覺。
//
// 只在 Discord Gateway 為 Ready 時送：程序活著但 Discord 斷線一樣算掛掉。
//
// 環境變數：
//   HEARTBEAT_URL           監控服務給的網址（GET）；未設定＝停用
//   HEARTBEAT_INTERVAL_SEC  間隔，預設 300（監控端的寬限時間請設得比這個長，例如 10 分鐘）

const { Status } = require('discord.js');
const logger = require('./logger');
const bootSummary = require('./bootSummary');

const URL_ = process.env.HEARTBEAT_URL || '';
const INTERVAL_MS = Math.max(60, Number.parseInt(process.env.HEARTBEAT_INTERVAL_SEC ?? '', 10) || 300) * 1000;
const TIMEOUT_MS = 10_000;

let timer = null;
let failing = false;

async function beat(client) {
  if (client.ws.status !== Status.Ready) return;
  try {
    const res = await fetch(URL_, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (failing) logger.info('Heartbeat', '心跳已恢復送出');
    failing = false;
  } catch (err) {
    // 連續失敗只記第一次，避免監控服務掛掉時每 5 分鐘一行
    if (!failing) logger.warn('Heartbeat', `心跳送出失敗：${err.message}`);
    failing = true;
  }
}

/** @param {import('discord.js').Client} client 在 clientReady 之後呼叫 */
function startHeartbeat(client) {
  if (timer) return;
  if (!URL_) {
    bootSummary.report('外部心跳', 'off', '未設定 HEARTBEAT_URL');
    return;
  }
  beat(client);
  timer = setInterval(() => beat(client), INTERVAL_MS);
  timer.unref();
  bootSummary.report('外部心跳', 'ok', `每 ${INTERVAL_MS / 1000} 秒送一次（Discord 連線正常時）`);
}

module.exports = { startHeartbeat };
