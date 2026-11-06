'use strict';
// AI 工具：音樂播放（點歌、隨機播放、控制、查詢目前播放）。
// 邏輯比照 /play、/music 與控制面板按鈕（unifiedQueue/commands.js、webSync.js 的 execute），
// 差別只在：一律要求發言者跟 Bot 在同一個語音頻道，避免有人在文字頻道一句話就切掉別人正在聽的歌。
//
// unifiedQueue 會間接載入 voiceHandler → aiHandler → aiCore → 這裡，全部延遲到執行時才 require，避免循環依賴。

const { Type } = require('@google/genai');
const { fail } = require('./toolError');
const { requireUserWithBot, requireBotAndUserTogether } = require('./voiceGuard');
const { zhFold } = require('../../../utils/zhFold');

const QUEUE_PREVIEW = 10;
const SEARCH_LIMIT  = 5; // 每個平台；fast 模式很便宜，多抓幾筆給過濾／排序挑

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

// ════════════════════════════════════════════════════════
//  比對（純函式，測試直接呼叫）
//  兩邊都先經過 zhFold：轉小寫＋繁體轉簡體，「周杰倫」「周杰伦」視為相同
// ════════════════════════════════════════════════════════
// 關鍵字以空白與各種連字號分隔（-、全形－、破折號 —、–）
const SEPARATORS = /[\s\-－—–]+/g;
const tokensOf = (query) => zhFold(query).split(SEPARATORS).filter(Boolean);
const compact  = (s) => zhFold(s).replace(SEPARATORS, '');

/**
 * 本地音樂庫比對。files 已依播放次數由多到少排序（localMusicHandler.getMusicFiles）。
 *   1. 名稱完全相同（忽略大小寫、繁簡、空白與連字號）
 *   2. 每個關鍵字都出現在名稱或檔名（含資料夾，例如「周杰倫/晴天.mp3」）裡；名稱越短越優先
 *   3. 名稱一樣長時，播放次數多的優先（沿用清單原本的順序）
 * @returns {object|null} 命中的檔案
 */
function rankLocal(files, query) {
    const tokens = tokensOf(query);
    if (!tokens.length) return null;
    const wanted = tokens.join('');

    const exact = files.find(f => compact(f.name) === wanted);
    if (exact) return exact;

    const hits = [];
    files.forEach((f, order) => {
        const haystack = `${zhFold(f.name)} ${zhFold(f.filename)}`;
        if (tokens.every(t => haystack.includes(t))) hits.push({ f, order, len: compact(f.name).length });
    });
    hits.sort((a, b) => a.len - b.len || a.order - b.order);
    return hits[0]?.f ?? null;
}

const MAX_ONLINE_SEC = 15 * 60;
// 標題有這些字的版本往後排（除非使用者的關鍵字本身就有）。英文字用單字邊界，免得「Oliver」被當成 live
const VARIANT_GROUPS = [
    [/(^|[^a-z])live([^a-z]|$)/],
    [/(^|[^a-z])cover([^a-z]|$)/],
    [/翻唱/],
    [/(^|[^0-9])1\s*(hour|hr)s?([^a-z]|$)/, /[1一]\s*(小时|个小时)/],
];

/**
 * 線上搜尋結果排序。
 *   - 超過 15 分鐘的直接排除（沒有長度資訊的保留）
 *   - 標題有 live／cover／翻唱／1 hour 的往後排，除非關鍵字本身就有同一類的字
 *   - 標題或上傳者包含所有關鍵字的優先
 *   - 其餘維持搜尋引擎原本的順序（YouTube 在前、Bilibili 在後）
 * @returns {Array} 排序後的候選（可能是空陣列）
 */
function rankOnline(results, query) {
    const tokens = tokensOf(query);
    const q = zhFold(query);
    const activeGroups = VARIANT_GROUPS.filter(group => !group.some(re => re.test(q)));

    return results
        .map((r, order) => {
            const title = zhFold(r.title);
            const haystack = `${title} ${zhFold(r.author)}`;
            return {
                r, order,
                variant: activeGroups.some(group => group.some(re => re.test(title))) ? 1 : 0,
                allTokens: tokens.length > 0 && tokens.every(t => haystack.includes(t)) ? 1 : 0,
            };
        })
        .filter(({ r }) => !(Number.isFinite(r.durationSec) && r.durationSec > MAX_ONLINE_SEC))
        .sort((a, b) => a.variant - b.variant || b.allTokens - a.allTokens || a.order - b.order)
        .map(({ r }) => r);
}

function findLocal(query) {
    const engine = uq().state._engines.local;
    if (!engine) return null;
    const hit = rankLocal(engine.getMusicFiles(), query);
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
        // fast：只拿搜尋清單（不逐一完整解析），選定之後再對那一首 getInfo
        results = await online.searchMulti(query, SEARCH_LIMIT, true);
    } catch (err) {
        fail(`線上搜尋失敗：${err.message}`);
    }
    if (!results?.length) fail(`找不到跟「${query}」有關的歌`);
    const ranked = rankOnline(results, query);
    if (!ranked.length) fail(`「${query}」的搜尋結果都超過 15 分鐘，請直接貼網址`);
    const picked = ranked[0];
    try {
        return { ...(await online.getInfo(picked.url)), type: 'bilibili' };
    } catch (err) {
        fail(`無法取得「${picked.title}」的資訊：${err.message}`);
    }
}

const describeItem = (item) => item.type === 'bilibili' && item.author && item.author !== '未知作者'
    ? `「${item.title}」（${item.author}）`
    : `「${item.title}」`;

// ════════════════════════════════════════════════════════
//  工具實作
// ════════════════════════════════════════════════════════
async function play(ctx, { query, next = false }) {
    query = String(query || '').trim();
    if (!query) fail('沒有說要放哪首歌');
    await connect(ctx);
    const item = await resolveTrack(query);

    const { playback, state, session } = uq();
    const guildId = ctx.guild.id;
    const result = await playback.enqueue(guildId, item, channelOf(ctx));
    // 沒在播時 enqueue 會直接開始播，播放失敗也一樣回 queued:false，要確認真的在播
    if (!result.queued && !state.nowPlaying.has(guildId)) fail(`無法播放${describeItem(item)}`);

    // 插播：與網頁播放器的 enqueue next 相同，把剛加到最後的這首移到佇列最前面
    let insertedNext = false;
    if (result.queued && next) {
        const queue = state.queues.get(guildId) || [];
        const k = queue.lastIndexOf(item);
        if (k > 0) {
            queue.splice(k, 1);
            queue.unshift(item);
            session.schedule();
            playback.prefetchUpcoming(guildId);
        }
        insertedNext = k >= 0;
    }
    await refreshPanel(guildId, ctx);

    // 線上歌曲附上實際網址：沒給的話人格被要求附連結時會自己編一個假的 YouTube 網址
    const source = item.type === 'local' ? '本地音樂庫' : `線上搜尋，網址 ${item.url}`;
    if (!result.queued) return `開始播放${describeItem(item)}（來源：${source}）`;
    if (insertedNext) return `已把${describeItem(item)}排在下一首播放（來源：${source}）`;
    return `已把${describeItem(item)}加入佇列第 ${result.position} 首（來源：${source}）`;
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
                    query: { type: Type.STRING, description: '歌名、歌手加歌名（用空白分開），或 YouTube/Bilibili 網址。保留使用者原本的寫法，不要翻譯、不要加「MV」「歌詞」等字' },
                    next: { type: Type.BOOLEAN, description: '使用者說「下一首放」「插播」「先放這首」時為 true（排到佇列最前面）；一般點歌省略' },
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

// quiet：用到音樂工具時，這次的 AI 回覆不用 TTS 朗讀（朗讀會蓋過／打斷剛點的歌）
// AI 工具的預篩關鍵字（tools/index.js 的 needsTools 用）：召回率優先，精準度交給判斷階段
const keywords = [
    '歌', '曲', '音樂', '播', '放', '點', '跳過', '切', '下一首', '停', '循環', '重複', '佇列', '隊列',
    'music', 'play', 'skip', 'song', 'youtu', 'bilibili', 'b23\\.tv',
];

// 可不可用由群組（music 模組）判斷，工具本身一律可用
module.exports = {
    tools: tools.map(t => ({ ...t, quiet: true, isAvailable: () => true })),
    keywords,
    _rankLocal: rankLocal,
    _rankOnline: rankOnline,
};
