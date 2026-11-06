#!/usr/bin/env node
// examples/memes/importNekowhale.js（MouseBot 與 mousebot-lite 共用，兩邊內容相同）
// 匯入「大肥鱼哈基米表情包」成人格表情包清單：data/memes/<人格>/memes.json（memeStore.js 的套組格式）。
//
//   node examples/memes/importNekowhale.js --persona xxx   匯入「大肥鱼」單人套組到人格 xxx（沒寫 --persona 時用 AI_PERSONA）
//   node examples/memes/importNekowhale.js --with-gpt      另外加上「大肥鱼和GPT娘」雙人套組
//   node examples/memes/importNekowhale.js --prefetch      順便把所有 GIF 先下載到 .cache/（大肥鱼約 358MB；預設用到才下載）
// --persona 和 AI_PERSONA 都沒有時直接報錯，不會猜要寫到哪個人格。
//
// 資料來源：
//   標註（情緒／標籤／用途）https://github.com/Loping151/dsh-nekowhale-stickers 的 meta/nekowhale.json（CC BY-NC 4.0）
//   GIF 清單與網址       https://kiriyuki.com/api/manifest
// 表情包作者：B站 可以叫我云大人/雾雪（https://space.bilibili.com/103739），kiriyuki.com 制作。
// 授權只允許非商業使用，且必須保留作者連結；產生的 memes.json 會一併寫入 attribution。

/* eslint-disable no-console -- 命令列工具，直接輸出給執行的人看 */

require('dotenv').config({ quiet: true });
const fs   = require('fs');
const path = require('path');
const { dataPath } = require('../../utils/dataDir');

const META_URL     = 'https://raw.githubusercontent.com/Loping151/dsh-nekowhale-stickers/main/meta/nekowhale.json';
const MANIFEST_URL = 'https://kiriyuki.com/api/manifest';
const SITE         = 'https://kiriyuki.com';
const UA           = 'nekowhale-stickers (+https://kiriyuki.com)';
const SOURCE_REPO  = 'https://github.com/Loping151/dsh-nekowhale-stickers';

function parseArgs(argv) {
    const opts = { persona: process.env.AI_PERSONA?.trim() || null, packs: ['大肥鱼'], prefetch: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--with-gpt') opts.packs.push('大肥鱼和GPT娘');
        else if (a === '--prefetch') opts.prefetch = true;
        else if (a === '--persona') opts.persona = argv[++i];
        else throw new Error(`不認得的參數：${a}`);
    }
    if (!opts.persona) throw new Error('請用 --persona <代號> 指定人格（或設定 AI_PERSONA）');
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(opts.persona ?? '')) throw new Error(`人格代號不合法：${opts.persona}`);
    return opts;
}

async function getJson(url) {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.json();
}

function gifUrl(manifest, item) {
    const base = manifest.site?.base || SITE;
    const gifBase = manifest.gif_base || '/media/gif';
    return `${base}${gifBase}/${encodeURIComponent(item.pack)}/${encodeURIComponent(item.file)}?h=${item.hash}`;
}

async function prefetch(dir, stickers) {
    const cacheDir = path.join(dir, '.cache');
    // 已經有送出用縮小版（memeStore 的 .cache/small-<px>/）的就不用原圖了——原圖可能是刻意刪掉省空間的，不要再抓回來
    const smallSize = Number.parseInt(process.env.MEME_DISPLAY_SIZE ?? '', 10);
    const smallDir = path.join(cacheDir, `small-${Number.isFinite(smallSize) && smallSize >= 0 ? (smallSize || 'orig') : 160}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    let done = 0, skipped = 0, failed = 0;
    const queue = [...stickers];
    const worker = async () => {
        for (let s = queue.shift(); s; s = queue.shift()) {
            const target = path.join(cacheDir, `${s.hash}.gif`);
            if (fs.existsSync(target) || fs.existsSync(path.join(smallDir, `${s.hash}.gif`))) { skipped++; continue; }
            try {
                const res = await fetch(s.url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(60_000) });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
                done++;
            } catch (err) {
                failed++;
                console.warn(`  下載失敗 ${s.name}：${err.message}`);
            }
        }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    console.log(`預先下載：新增 ${done}、已存在 ${skipped}、失敗 ${failed}`);
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    console.log(`下載標註與清單…（套組：${opts.packs.join('、')}）`);
    const [meta, manifest] = await Promise.all([getJson(META_URL), getJson(MANIFEST_URL)]);

    const items = new Map(manifest.items.map(it => [`${it.pack}/${it.stem}`, it]));
    const stickers = [];
    let missing = 0;
    for (const m of meta.stickers) {
        const [pack] = m.id.split('/');
        if (!opts.packs.includes(pack)) continue;
        const it = items.get(m.id);
        if (!it) { missing++; continue; }
        const name = it.name || it.stem;
        stickers.push({
            id: m.id,
            name: it.variant ? `${name}${it.variant}` : name,
            emotion: m.emotion || '',
            tags: Array.isArray(m.tags) ? m.tags : [],
            use: [m.use, m.dir ? `（${m.dir}）` : ''].filter(Boolean).join(''),
            url: gifUrl(manifest, it),
            hash: it.hash,
            bytes: it.bytes,
        });
    }
    // 同名的（不同版本）加上編號區分，讓「名字完全相同」的查詢不會撞名
    const seen = new Map();
    for (const s of stickers) seen.set(s.name, (seen.get(s.name) ?? 0) + 1);
    for (const s of stickers) if (seen.get(s.name) > 1) s.name = `${s.name}·${s.id.split('/')[1].split('_')[0]}`;

    const dir = dataPath('memes', opts.persona);
    fs.mkdirSync(dir, { recursive: true });
    const out = {
        source: SOURCE_REPO,
        attribution: meta.attribution?.text
            ?? '表情包作者：B站 可以叫我云大人（space.bilibili.com/103739），kiriyuki.com 制作',
        license: '标注数据 CC BY-NC 4.0；表情包图片版权归原作者，仅限非商业使用并保留作者链接',
        metaVersion: meta.version,
        manifestVersion: manifest.version,
        packs: opts.packs,
        stickers,
    };
    const file = path.join(dir, 'memes.json');
    fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
    const mb = (stickers.reduce((n, s) => n + (s.bytes || 0), 0) / 1e6).toFixed(0);
    console.log(`已寫入 ${file}：${stickers.length} 張（全部約 ${mb}MB，用到才下載）${missing ? `；${missing} 張在網站清單找不到，略過` : ''}`);

    if (opts.prefetch) await prefetch(dir, stickers);
}

module.exports = { parseArgs };

if (require.main === module) {
    main().catch((err) => {
        console.error(`匯入失敗：${err.message}`);
        process.exit(1);
    });
}
