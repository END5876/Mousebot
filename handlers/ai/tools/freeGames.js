'use strict';
// AI 工具：查目前 Epic / Steam 的限時免費遊戲。
// 資料來源與 /notify 自動通知相同（notice/epicFreeHandler、steamFreeHandler 的 getFreeGames）。
// Steam 那邊每款遊戲都要多查一次商店頁，聊天時每問一次就抓一次太慢，結果快取 10 分鐘。

const { Type } = require('@google/genai');
const { fail } = require('./toolError');

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_PER_PLATFORM = 8;

const PLATFORMS = {
    epic:  { label: 'Epic Games', load: () => require('../../notice/epicFreeHandler') },
    steam: { label: 'Steam',      load: () => require('../../notice/steamFreeHandler') },
};

const cache = new Map(); // platform → { at, games }

async function getGames(platform) {
    const hit = cache.get(platform);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.games;
    const games = await PLATFORMS[platform].load().getFreeGames();
    cache.set(platform, { at: Date.now(), games: Array.isArray(games) ? games : [] });
    return cache.get(platform).games;
}

function formatEnd(endDate) {
    const d = new Date(endDate);
    if (Number.isNaN(d.getTime())) return String(endDate || '未知');
    return d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

async function freeGames(_ctx, { platform = 'all' }) {
    const keys = platform === 'epic' || platform === 'steam' ? [platform] : Object.keys(PLATFORMS);
    const sections = await Promise.all(keys.map(async (key) => {
        const { label } = PLATFORMS[key];
        let games;
        try {
            games = await getGames(key);
        } catch {
            return `${label}：查詢失敗`;
        }
        if (!games.length) return `${label}：目前沒有限時免費的遊戲`;
        const list = games.slice(0, MAX_PER_PLATFORM)
            .map(g => `- ${g.name}（到 ${formatEnd(g.endDate)}）${g.url}`)
            .join('\n');
        return `${label}：\n${list}`;
    }));
    if (sections.every(s => s.endsWith('查詢失敗'))) fail('免費遊戲資料暫時查不到，稍後再試');
    return sections.join('\n');
}

const tools = [
    {
        declaration: {
            name: 'free_games',
            description: '查詢 Epic Games / Steam 現在可以免費領取的限時免費遊戲（含連結與截止時間）。',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    platform: { type: Type.STRING, enum: ['epic', 'steam', 'all'], description: '要查哪個平台，沒指定就 all' },
                },
            },
        },
        label: '查免費遊戲',
        run: freeGames,
    },
];

// AI 工具的預篩關鍵字（tools/index.js 的 needsTools 用）：召回率優先，精準度交給判斷階段
const keywords = ['免費', '白嫖', '送遊戲', '領取', 'epic', 'steam'];

module.exports = { tools, keywords, _cache: cache };
