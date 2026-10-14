// utils/health.js
// 給 Docker HEALTHCHECK 用的 /healthz 端點。
//
// supervisord 只看得出「程序有沒有死」，看不出「程序還活著但 Discord 已斷線」或
// 「OWW server 卡住不回應」。這裡提供一個極小的 HTTP 端點：
//   GET /healthz → 200 / 503，回傳 JSON 詳細狀態
//
// 判定規則：
//   critical：Discord Gateway 連線（WebSocket 狀態 Ready）——失敗時回 503
//   optional：OWW 喚醒詞服務、bgutil PO Token 服務——只回報狀態，不影響 HTTP 狀態碼
//             （兩者已由 supervisord 監管，且停掉時 Bot 會降級運作而非完全失效）
//
// 環境變數：
//   HEALTH_PORT  監聽埠（預設 3939；設為 0 則不啟動）
//   HEALTH_HOST  監聽位址（預設 127.0.0.1，只供容器內部的 HEALTHCHECK 使用）

const http = require('http');
const { Status } = require('discord.js');
const logger = require('./logger');

const PORT = Number.parseInt(process.env.HEALTH_PORT ?? '3939', 10);
const HOST = process.env.HEALTH_HOST || '127.0.0.1';
const PROBE_TIMEOUT_MS = 2000;

// Discord 剛啟動或短暫重連時 status 不是 Ready，給一段寬限期再判定為不健康，
// 避免正常的 resume 被 Docker 記成失敗。
const DISCORD_GRACE_MS = 60 * 1000;

const startedAt = Date.now();
let notReadySince = null;

async function probe(url) {
    if (!url) return { status: 'disabled' };
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return { status: res.ok ? 'ok' : 'down', httpStatus: res.status };
    } catch (err) {
        return { status: 'down', error: err.name === 'TimeoutError' ? 'timeout' : err.message };
    }
}

function checkDiscord(client) {
    const wsStatus = client.ws.status;
    const ready = wsStatus === Status.Ready;
    if (ready) notReadySince = null;
    else notReadySince ??= Date.now();

    const withinGrace = !ready && Date.now() - notReadySince < DISCORD_GRACE_MS;
    return {
        status: ready ? 'ok' : withinGrace ? 'recovering' : 'down',
        wsStatus: Status[wsStatus] ?? wsStatus,
        ping: client.ws.ping,
        guilds: client.guilds.cache.size,
    };
}

async function collect(client) {
    const owwUrl = process.env.OWW_HTTP_URL ? `${process.env.OWW_HTTP_URL}/health` : null;
    const potUrl = `${process.env.YT_POT_PROVIDER_URL || 'http://127.0.0.1:4416'}/ping`;

    const discord = checkDiscord(client);
    const [oww, potProvider] = await Promise.all([probe(owwUrl), probe(potUrl)]);
    const healthy = discord.status !== 'down';

    return {
        healthy,
        body: {
            status: healthy ? 'ok' : 'unhealthy',
            uptimeSec: Math.round((Date.now() - startedAt) / 1000),
            memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
            checks: { discord, oww, potProvider },
        },
    };
}

/**
 * @param {import('discord.js').Client} client
 * @returns {http.Server|null}
 */
function startHealthServer(client) {
    if (!Number.isFinite(PORT) || PORT <= 0) return null;

    const server = http.createServer(async (req, res) => {
        if (req.method !== 'GET' || req.url !== '/healthz') {
            res.writeHead(404).end();
            return;
        }
        try {
            const { healthy, body } = await collect(client);
            res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', error: err.message }));
        }
    });

    server.on('error', err => logger.warn('Health', `健康檢查端點啟動失敗：${err.message}`));
    server.listen(PORT, HOST, () => logger.debug('Health', `健康檢查端點：http://${HOST}:${PORT}/healthz`));
    server.unref();
    return server;
}

module.exports = { startHealthServer };
