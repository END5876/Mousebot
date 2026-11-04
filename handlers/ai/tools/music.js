'use strict';
// AI 工具：音樂播放（點歌、隨機播放、控制、查詢目前播放）。
// 邏輯比照 /play、/music 與控制面板按鈕（unifiedQueue/commands.js、webSync.js 的 execute），
// 差別只在：一律要求發言者跟 Bot 在同一個語音頻道，避免有人在文字頻道一句話就切掉別人正在聽的歌。
//
// unifiedQueue 會間接載入 voiceHandler → aiHandler → aiCore → 這裡，全部延遲到執行時才 require，避免循環依賴。

const { Type } = require('@google/genai');
const { fail } = require('./toolError');
const { requireUserWithBot, requireBotAndUserTogether } = require('./voiceGuard');

const QUEUE_PREVIEW = 10;
const SEARCH_LIMIT  = 3;

const uq = () => ({
    state:    require('../../musicplayer/unifiedQueue/state'),
    playback: require('../../musicplayer/unifiedQueue/playback'),
    session:  require('../../musicplayer/unifiedQueue/session'),
    monitor:  require('../../musicplayer/voiceActivityMonitor'),
});

// 沒有可以發訊息的文字頻道時（理論上不會），給 enqueue 一個不發訊息的替身，內部通知不會出錯
const silentChannel = { id: null, send: async () => {} };
const channelOf = (ctx) => ctx.textChannel || silentChannel;

async function refreshPanel(guildId, ctx) {
    if (!ctx.textChannel) return;
    await uq().playback.updateControlPanel(guildId, ctx.textChannel).catch(() => {});
}

async function connect(ctx) {
    const voiceChannel = requireUserWithBot(ctx);
    const { playback, monitor } = uq();
    let connection;
    try {
        connection = await playback.ensureConnection({
            guild: ctx.guild,
            member: ctx.member,
            channel: channelOf(ctx),
            client: ctx.guild.client,
        });
    } catch {
        fail('加入語音頻道時發生錯誤');
    }
    if (!connection) fail(`無法加入語音頻道「${voiceChannel.name}」`);
    monitor.touchActivity(ctx.guild.id);
    return connection;
}

const normalize = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

/** 本地音樂庫：完全相同的名稱優先，其次是包含關鍵字的（清單本身已依播放次數排序） */
function findLocal(query) {
    const engine = uq().state._engines.local;
    if (!engine) return null;
    const q = normalize(query);
    if (!q) return null;
    const files = engine.getMusicFiles();
    const hit = files.find(f => normalize(f.name) === q)
        ?? files.find(f => normalize(f.name).includes(q) || normalize(f.filename).includes(q));
    if (!hit) return null;
    const item = engine.getTrackInfo(hit.filename);
    return item ? { ...item, type: 'local' } : null;
}

async function resolveTrack(query) {
    const { isSupportedMediaUrl } = require('../../musicplayer/musicAntiBot');
    const { cleanUrl } = require('../../musicplayer/unifiedQueue/search/urlUtils');
    const online = uq().state._engines.bilibili;

    if (/^https?:\/\//i.test(query)) {
        const url = cleanUrl(query);
        if (!url || !isSupportedMediaUrl(url)) fail('只支援 YouTube 與 Bilibili 的網址');
        if (!online) fail('線上音樂引擎還沒準備好');
        try {
            return { ...(await online.getInfo(url)), type: 'bilibili' };
        } catch (err) {
            fail(`無法取得影片資訊：${err.message}`);
        }
    }

    const local = findLocal(query);
    if (local) return local;

    if (!online || typeof online.searchMulti !== 'function') fail(`本地音樂庫找不到「${query}」，線上搜尋也還沒準備好`);
    let results;
    try {
        results = await online.searchMulti(query, SEARCH_LIMIT);
    } catch (err) {
        fail(`線上搜尋失敗：${err.message}`);
    }
    if (!results?.length) fail(`找不到跟「${query}」有關的歌`);
    try {
        return { ...(await online.getInfo(results[0].url)), type: 'bilibili' };
    } catch (err) {
        fail(`無法取得「${results[0].title}」的資訊：${err.message}`);
    }
}

const describeItem = (item) => item.type === 'bilibili' && item.author && item.author !== '未知作者'
    ? `「${item.title}」（${item.author}）`
    : `「${item.title}」`;

// ════════════════════════════════════════════════════════
//  工具實作
// ════════════════════════════════════════════════════════
async function play(ctx, { query }) {
    query = String(query || '').trim();
    if (!query) fail('沒有說要放哪首歌');
    await connect(ctx);
    const item = await resolveTrack(query);

    const { playback, state } = uq();
    const guildId = ctx.guild.id;
    const result = await playback.enqueue(guildId, item, channelOf(ctx));
    // 沒在播時 enqueue 會直接開始播，播放失敗也一樣回 queued:false，要確認真的在播
    if (!result.queued && !state.nowPlaying.has(guildId)) fail(`無法播放${describeItem(item)}`);
    await refreshPanel(guildId, ctx);

    const source = item.type === 'local' ? '本地音樂庫' : '線上搜尋';
    return result.queued
        ? `已把${describeItem(item)}加入佇列第 ${result.position} 首（來源：${source}）`
        : `開始播放${describeItem(item)}（來源：${source}）`;
}

async function random(ctx, { continuous = false }) {
    await connect(ctx);
    const { playback, state } = uq();
    const guildId = ctx.guild.id;
    if (state.nowPlaying.has(guildId)) playback.stopAll(guildId);

    const track = await playback.playRandomLocal(guildId, channelOf(ctx), { enableContinuous: !!continuous });
    if (!track) fail('本地音樂庫裡沒有歌');
    await refreshPanel(guildId, ctx);
    return `隨機播放「${track.title}」${continuous ? '，並開啟隨機連播（播完自動換下一首）' : ''}`;
}

const LOOP_TEXT = { one: '單曲循環已開啟', all: '列表循環已開啟', off: '循環已關閉' };

async function control(ctx, { action }) {
    requireBotAndUserTogether(ctx);
    const { playback, state, session, monitor } = uq();
    const guildId = ctx.guild.id;
    const np = state.nowPlaying.get(guildId);
    const needPlaying = () => { if (!np) fail('現在沒有在播音樂'); };
    monitor.touchActivity(guildId);

    switch (action) {
        case 'skip': {
            needPlaying();
            const queue = state.queues.get(guildId) || [];
            const loopMode = state.loopSettings.get(guildId) || 'off';
            // 與 /music skip、控制面板一致：隨機連播交給 Idle 挑下一首；佇列空且不循環才整組停止
            if (state.randomPlaySettings.get(guildId)) {
                playback.skipCurrent(guildId);
                return `已跳過「${np.item.title}」，隨機連播下一首`;
            }
            if (queue.length === 0 && loopMode === 'off') {
                playback.stopAll(guildId);
                return `已跳過「${np.item.title}」，佇列空了所以停止播放`;
            }
            playback.skipCurrent(guildId);
            return `已跳過「${np.item.title}」`;
        }
        case 'stop':
            needPlaying();
            playback.stopAll(guildId);
            return '已停止播放並清空佇列';
        case 'loop_one':
        case 'loop_all':
        case 'loop_off': {
            needPlaying();
            const mode = action.slice('loop_'.length);
            state.randomPlaySettings.set(guildId, false); // 與循環互斥
            state.loopSettings.set(guildId, mode);
            if (mode === 'all') state.resetLoopAllCycle(guildId);
            session.schedule();
            await refreshPanel(guildId, ctx);
            return LOOP_TEXT[mode];
        }
        case 'clear_queue': {
            const queue = state.queues.get(guildId) || [];
            if (!queue.length) fail('佇列本來就是空的');
            state.queues.set(guildId, []);
            session.schedule();
            await refreshPanel(guildId, ctx);
            return `已清空佇列（${queue.length} 首）`;
        }
        default:
            fail('不支援的播放操作');
    }
}

async function status(ctx) {
    const { state } = uq();
    const guildId = ctx.guild.id;
    const np = state.nowPlaying.get(guildId);
    const queue = state.queues.get(guildId) || [];
    if (!np && !queue.length) return '現在沒有在播音樂，佇列也是空的';

    const loopMode = state.randomPlaySettings.get(guildId)
        ? '隨機連播'
        : { one: '單曲循環', all: '列表循環' }[state.loopSettings.get(guildId)] ?? '不循環';
    const lines = [];
    if (np) lines.push(`正在播放：${describeItem(np.item)}`);
    lines.push(`播放模式：${loopMode}`);
    if (queue.length) {
        const preview = queue.slice(0, QUEUE_PREVIEW).map((t, i) => `${i + 1}. ${t.title}`).join('\n');
        const more = queue.length > QUEUE_PREVIEW ? `\n…還有 ${queue.length - QUEUE_PREVIEW} 首` : '';
        lines.push(`佇列（${queue.length} 首）：\n${preview}${more}`);
    } else {
        lines.push('佇列是空的');
    }
    return lines.join('\n');
}

// ════════════════════════════════════════════════════════
//  宣告
// ════════════════════════════════════════════════════════
const tools = [
    {
        declaration: {
            name: 'music_play',
            description: '在 Discord 語音頻道播放或點一首歌。使用者明確要求播放、點歌時才呼叫。會先找本地音樂庫，找不到再上 YouTube/Bilibili 搜尋。',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    query: { type: Type.STRING, description: '歌名、歌手加歌名，或 YouTube/Bilibili 網址。保留使用者原本的寫法，不要翻譯' },
                },
                required: ['query'],
            },
        },
        label: '點歌',
        run: play,
    },
    {
        declaration: {
            name: 'music_random',
            description: '從本地音樂庫隨機播放一首歌。使用者說「隨便放一首」「隨機播」時呼叫。',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    continuous: { type: Type.BOOLEAN, description: '是否開啟隨機連播（播完自動隨機下一首，直到停止）。使用者說「一直放」「連播」時為 true' },
                },
            },
        },
        label: '隨機播放',
        run: random,
    },
    {
        declaration: {
            name: 'music_control',
            description: '控制正在播放的音樂：跳過、停止、循環、清空佇列。',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    action: {
                        type: Type.STRING,
                        enum: ['skip', 'stop', 'loop_one', 'loop_all', 'loop_off', 'clear_queue'],
                        description: 'skip=切下一首；stop=停止播放；loop_one=單曲循環；loop_all=列表循環；loop_off=關閉循環；clear_queue=清空待播佇列',
                    },
                },
                required: ['action'],
            },
        },
        label: '控制播放',
        run: control,
    },
    {
        declaration: {
            name: 'music_status',
            description: '查詢現在正在播放的歌與待播佇列。使用者問「這首是什麼歌」「接下來放什麼」時呼叫。',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        label: '查詢播放狀態',
        run: status,
    },
];

module.exports = { tools, _findLocal: findLocal };
