'use strict';

// 人格表情包（memeStore.js）：讀圖庫、組 prompt、解析 [表情:關鍵詞]、還原歷史裡的表情包附件與網址、多人格各自的圖庫。
// 資料目錄指到暫存資料夾，不碰正式的 data/；不打網路（套組只測解析，不測下載）。
// 鎖定成單一人格 testfish：不傳 key 時用的就是 testfish 的圖庫。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mousebot-meme-'));
process.env.MOUSEBOT_DATA_DIR = TMP;
process.env.LOG_LEVEL = 'error';
process.env.AI_SCOPE_LOCK = 'single:testfish';
delete process.env.AI_PERSONA;
delete process.env.MEME_PUBLIC_URL;
delete process.env.MEME_DISPLAY_SIZE;

const memeStore = require('../handlers/ai/memeStore');

const DIR = path.join(TMP, 'memes', 'testfish');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  setTimeout(() => process.exit(), 500).unref();
});

function reset(files = {}) {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(DIR, name), content);
  memeStore._internal.resetCache();
}

function kit(stickers) {
  return JSON.stringify({ stickers });
}

const KIT = [
  { id: 'p/1N01_摸鱼', name: '摸鱼', emotion: '开心', tags: ['偷懒', '摸鱼'], use: '上班偷懒时', url: 'https://example.com/a.gif', hash: 'aaaaaaaaaaaa' },
  { id: 'p/1N02_吃瓜', name: '吃瓜', emotion: '其他', tags: ['围观'], use: '看热闹', url: 'https://example.com/b.gif', hash: 'bbbbbbbbbbbb' },
  { id: 'p/1N03_生气', name: '我要咬他', emotion: '生气', tags: ['别惹我'], use: '', url: 'https://example.com/c.gif', hash: 'cccccccccccc' },
  { id: 'p/bad', name: '沒有網址', emotion: '开心', tags: [] },
  { id: 'p/http', name: '不是https', url: 'http://example.com/d.gif' },
];

test('沒有圖庫：prompt 不加東西，標記照樣被移除', () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  memeStore._internal.resetCache();
  assert.equal(memeStore.getMemePrompt(), '');
  assert.deepEqual(memeStore.extractMemes('哈哈\n[表情:嘴饞]'), { text: '哈哈', memes: [] });
});

test('直接放圖：只收圖片檔，張數少時 prompt 逐張列出', () => {
  reset({ '嘴饞.png': 'x', '得意.gif': 'x', 'notes.txt': 'x', 'memes.json': JSON.stringify({ 嘴饞: '看到吃的' }) });
  assert.deepEqual(memeStore.listMemes().map(m => m.name).sort(), ['嘴饞', '得意'].sort());
  const prompt = memeStore.getMemePrompt();
  assert.match(prompt, /- 嘴饞：看到吃的/);
  assert.match(prompt, /- 得意$/m);
  assert.match(prompt, /^【表情包】/);
});

test('extractMemes＋toFiles：本機圖直接當附件、最多一張、全形括號也接受', async () => {
  reset({ '嘴饞.png': 'x', '得意.gif': 'x' });
  const r = memeStore.extractMemes('好餓\n［表情：嘴饞］\n[表情:得意]\n[表情:不存在]');
  assert.equal(r.text, '好餓');
  assert.deepEqual(r.memes.map(m => m.name), ['嘴饞']);
  const files = await memeStore.toFiles(r.memes);
  assert.equal(files[0].attachment, path.join(DIR, '嘴饞.png'));
  assert.match(files[0].name, /^meme-[0-9a-f]{10}\.png$/);

  const only = memeStore.extractMemes('[表情:得意]');
  assert.equal(only.text, '');
  assert.equal(only.memes.length, 1);
});

test('套組清單：略過沒網址／非 https 的項目，依名字 → 情緒 → 標籤 → 包含 解析', () => {
  reset({ 'memes.json': kit(KIT) });
  assert.deepEqual(memeStore.listMemes().map(m => m.name), ['摸鱼', '吃瓜', '我要咬他']);
  assert.equal(memeStore.resolveMeme('吃瓜').name, '吃瓜');          // 名字
  assert.equal(memeStore.resolveMeme('生气').name, '我要咬他');      // 情緒
  assert.equal(memeStore.resolveMeme('围观').name, '吃瓜');          // 標籤
  assert.equal(memeStore.resolveMeme('偷懒时').name, '摸鱼');        // 用途包含
  assert.equal(memeStore.resolveMeme('完全沒有'), null);
});

test('繁體關鍵詞先轉簡體再比對；英文不分大小寫', () => {
  assert.equal(memeStore._internal.normalize(' 摸魚 開心 生氣 ABC '), '摸鱼 开心 生气 abc');
  reset({ 'memes.json': kit(KIT) });
  assert.equal(memeStore.resolveMeme('摸魚').name, '摸鱼');          // 名字
  assert.equal(memeStore.resolveMeme('生氣').name, '我要咬他');      // 情緒
  assert.equal(memeStore.resolveMeme('圍觀').name, '吃瓜');          // 標籤
  assert.equal(memeStore.resolveMeme('偷懶時').name, '摸鱼');        // 用途包含
  const r = memeStore.extractMemes('笑死\n[表情:摸魚]');
  assert.deepEqual(r.memes.map(m => m.name), ['摸鱼']);
});

test('圖庫網站連不上：改送同情緒、已快取的圖；之後一段時間不再連線', async () => {
  const down = 'https://127.0.0.1:1/x.gif';          // 連不上的位址，不打外部網路
  reset({
    'memes.json': kit([
      { id: 'p/a', name: '没下载过', emotion: '开心', url: down, hash: '111111111111' },
      { id: 'p/b', name: '已快取', emotion: '开心', url: down, hash: '222222222222' },
      { id: 'p/c', name: '别的情绪', emotion: '生气', url: down, hash: '333333333333' },
    ]),
  });
  fs.mkdirSync(path.join(DIR, '.cache'));
  fs.writeFileSync(path.join(DIR, '.cache', '222222222222.gif'), 'gif');

  const [file] = await memeStore.toFiles([memeStore.resolveMeme('没下载过')]);
  assert.equal(file.attachment, path.join(DIR, '.cache', '222222222222.gif'));

  // 同情緒沒有快取 → 不送圖；而且退避期間不再嘗試下載（立刻回來）
  const t0 = Date.now();
  assert.deepEqual(await memeStore.toFiles([memeStore.resolveMeme('别的情绪')]), []);
  assert.ok(Date.now() - t0 < 1000);
});

test('輪流：同名的圖不會搶走整個情緒，同一批候選每張都輪得到', () => {
  const many = ['害怕', '发抖', '躲起来', '救命', '吓到', '缩成一团'].map((name, i) => ({
    id: `p/${i}`, name, emotion: '害怕', tags: [], url: `https://example.com/${i}.gif`,
  }));
  reset({ 'memes.json': kit(many) });
  const seen = new Set();
  for (let i = 0; i < many.length; i++) seen.add(memeStore.extractMemes('[表情:害怕]').memes[0].name);
  assert.equal(seen.size, many.length);              // 6 次剛好 6 張都送過，不會一直是名字叫「害怕」的那張
});

test('候選太少時併入「包含」的', () => {
  reset({ 'memes.json': kit(KIT) });
  // 「摸鱼」完全相同的只有 1 張，併入「包含」的也沒有別張 → 仍找得到那 1 張
  assert.equal(memeStore.resolveMeme('摸鱼').name, '摸鱼');
  // 「别惹」沒有完全相同的，靠標籤「别惹我」包含找到
  assert.equal(memeStore.resolveMeme('别惹').name, '我要咬他');
});

test('套組很多張時 prompt 只列情緒與常用關鍵詞', () => {
  const many = Array.from({ length: memeStore._internal.INDEX_MODE_MAX + 1 }, (_, i) => ({
    id: `p/${i}`, name: `图${i}`, emotion: i % 2 ? '开心' : '生气', tags: ['摸鱼'], url: `https://example.com/${i}.gif`,
  }));
  reset({ 'memes.json': kit(many) });
  const prompt = memeStore.getMemePrompt();
  assert.match(prompt, /情绪：.*开心/);
  assert.match(prompt, /常用关键词：摸鱼/);
  assert.ok(!prompt.includes('图0'));
});

test('buildPayloads：附件跟在最後一塊，沒文字就單獨送圖', () => {
  const files = [{ attachment: 'a', name: 'meme-x.png' }];
  assert.deepEqual(memeStore.buildPayloads(['一', '二'], files), [{ content: '一' }, { content: '二', files }]);
  assert.deepEqual(memeStore.buildPayloads([], files), [{ files }]);
  assert.deepEqual(memeStore.buildPayloads(['一']), [{ content: '一' }]);
});

test('buildPayloads：網址另外單獨送一則，放在文字之後', () => {
  const link = { url: 'https://meme.example.com/testfish/small-160/aaaaaaaaaaaa.gif' };
  assert.deepEqual(memeStore.buildPayloads(['一', '二'], [link]), [{ content: '一' }, { content: '二' }, { content: link.url }]);
  assert.deepEqual(memeStore.buildPayloads([], [link]), [{ content: link.url }]);
});

/** 在 MEME_PUBLIC_URL 設定下跑 fn，結束後還原 */
async function withPublicUrl(value, fn) {
  const saved = process.env.MEME_PUBLIC_URL;
  if (value === undefined) delete process.env.MEME_PUBLIC_URL; else process.env.MEME_PUBLIC_URL = value;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.MEME_PUBLIC_URL; else process.env.MEME_PUBLIC_URL = saved;
  }
}

test('網址模式：大圖縮小、小圖原樣複製，都放進 small-<px>/ 並送網址；沒設或不是 https 就送附件', async () => {
  const sharp = require('sharp');
  const big = await sharp({ create: { width: 300, height: 300, channels: 4, background: '#f00' } }).png().toBuffer();
  const small = await sharp({ create: { width: 100, height: 50, channels: 4, background: '#0f0' } }).png().toBuffer();
  reset({ '大圖.png': big, '小圖.png': small });
  const smallDir = path.join(DIR, '.cache', 'small-160');

  await withPublicUrl('https://meme.example.com/', async () => {
    const [b] = await memeStore.toFiles([memeStore.resolveMeme('大圖')]);
    const [s] = await memeStore.toFiles([memeStore.resolveMeme('小圖')]);
    const hb = memeStore._internal.hashId('大圖');
    const hs = memeStore._internal.hashId('小圖');
    assert.deepEqual(b, { url: `https://meme.example.com/testfish/small-160/${hb}.png` });
    assert.deepEqual(s, { url: `https://meme.example.com/testfish/small-160/${hs}.png` });
    // aiUtils 擋掉了 sharp 從檔案路徑讀圖，這裡也要先讀成 Buffer
    const mb = await sharp(fs.readFileSync(path.join(smallDir, `${hb}.png`))).metadata();
    assert.deepEqual([mb.width, mb.height], [160, 160]);
    assert.ok(fs.readFileSync(path.join(smallDir, `${hs}.png`)).equals(small));
  });

  await withPublicUrl(undefined, async () => {
    const [f] = await memeStore.toFiles([memeStore.resolveMeme('大圖')]);
    assert.equal(f.attachment, path.join(smallDir, `${memeStore._internal.hashId('大圖')}.png`));
  });
  await withPublicUrl('http://meme.example.com', async () => {
    assert.equal(memeStore.publicBase(), '');
    const [f] = await memeStore.toFiles([memeStore.resolveMeme('大圖')]);
    assert.ok(f.attachment);
  });
});

test('原圖刪掉、只剩縮小版：直接用縮小版，不重新下載', async () => {
  const down = 'https://127.0.0.1:1/x.gif';          // 真的去下載就會失敗
  reset({ 'memes.json': kit([{ id: 'p/a', name: '只剩小图', emotion: '开心', url: down, hash: '444444444444' }]) });
  fs.mkdirSync(path.join(DIR, '.cache', 'small-160'), { recursive: true });
  const small = path.join(DIR, '.cache', 'small-160', '444444444444.gif');
  fs.writeFileSync(small, 'gif');

  await withPublicUrl('https://meme.example.com', async () => {
    assert.deepEqual(await memeStore.toFiles([memeStore.resolveMeme('只剩小图')]),
      [{ url: 'https://meme.example.com/testfish/small-160/444444444444.gif' }]);
  });
  await withPublicUrl(undefined, async () => {
    const [f] = await memeStore.toFiles([memeStore.resolveMeme('只剩小图')]);
    assert.equal(f.attachment, small);
  });
  assert.ok(!fs.existsSync(path.join(DIR, '.cache', '444444444444.gif')));
});

test('網址模式：Bot 自己發的表情包網址還原成名字', async () => {
  reset({ 'memes.json': kit(KIT) });
  await withPublicUrl('https://meme.example.com', async () => {
    const url = 'https://meme.example.com/testfish/small-160/aaaaaaaaaaaa.gif';
    assert.equal(memeStore.memeTagOfContent(url), '摸鱼');
    assert.equal(memeStore.memeTagOfContent('https://meme.example.com/testfish/small-160/ffffffffffff.gif'), null);
    assert.equal(memeStore.memeTagOfContent(`看這個 ${url}`), undefined);
    assert.equal(memeStore.memeTagOfContent('https://other.example.com/testfish/small-160/aaaaaaaaaaaa.gif'), undefined);
  });
});

test('memeTagOfAttachment：Bot 的表情包附件還原成名字，雜湊對不到回 null，不是表情包回 undefined', () => {
  reset({ 'memes.json': kit(KIT) });
  const hash = memeStore._internal.hashId('p/1N01_摸鱼');
  assert.equal(memeStore.memeTagOfAttachment({ name: `meme-${hash}.gif` }), '摸鱼');
  assert.equal(memeStore.memeTagOfAttachment({ name: 'meme-ffffffffff.png' }), null);
  assert.equal(memeStore.memeTagOfAttachment({ name: 'photo.png' }), undefined);
});

// ── 多人格：每個人格各自一套圖庫（MouseBot 的多人格模式） ──

function resetLib(key, files = {}) {
  const dir = path.join(TMP, 'memes', key);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  memeStore._internal.resetCache();
  return dir;
}

test('多人格：每個人格用自己的圖庫，Meme 帶著人格代號', async () => {
  const alphaDir = resetLib('alpha', { '開心.png': 'x', 'memes.json': JSON.stringify({ 開心: 'A 的用途' }) });
  resetLib('beta', { 'memes.json': kit([{ id: 'b/1', name: '开心', emotion: '开心', url: 'https://example.com/b.gif', hash: 'bbbbbb000001' }]) });

  assert.deepEqual(memeStore.listMemes('alpha').map(m => [m.persona, m.name]), [['alpha', '開心']]);
  assert.deepEqual(memeStore.listMemes('beta').map(m => [m.persona, m.name]), [['beta', '开心']]);
  assert.match(memeStore.getMemePrompt('alpha'), /- 開心：A 的用途/);
  assert.ok(!memeStore.getMemePrompt('beta').includes('A 的用途'));
  assert.equal(memeStore.getMemePrompt('gamma'), '');                     // 沒有資料夾的人格：不啟用

  const r = memeStore.extractMemes('好耶\n[表情:開心]', 'alpha');
  assert.equal(r.text, '好耶');
  assert.equal(r.memes[0].persona, 'alpha');
  const [file] = await memeStore.toFiles(r.memes);                       // 人格從 meme.persona 取
  assert.equal(file.attachment, path.join(alphaDir, '開心.png'));

  assert.equal(memeStore.resolveMeme('開心', 'beta').persona, 'beta');
  assert.equal(memeStore.resolveMeme('開心', 'gamma'), null);

  const hash = memeStore._internal.hashId('開心');
  assert.equal(memeStore.memeTagOfAttachment({ name: `meme-${hash}.png` }, 'alpha'), '開心');
  assert.equal(memeStore.memeTagOfAttachment({ name: `meme-${hash}.png` }, 'beta'), null);
});

test('多人格：送網址時網址帶人格；從網址還原時依網址裡的人格查圖庫', async () => {
  resetLib('alpha', { 'memes.json': kit([{ id: 'a/1', name: '阿法', emotion: '开心', url: 'https://example.com/a.gif', hash: 'cccccc000001' }]) });
  resetLib('beta', { 'memes.json': kit([{ id: 'b/1', name: '貝塔', emotion: '开心', url: 'https://example.com/b.gif', hash: 'cccccc000001' }]) });
  const small = path.join(TMP, 'memes', 'beta', '.cache', 'small-160');
  fs.mkdirSync(small, { recursive: true });
  fs.writeFileSync(path.join(small, 'cccccc000001.gif'), 'gif');

  await withPublicUrl('https://meme.example.com', async () => {
    assert.deepEqual(await memeStore.toFiles([memeStore.resolveMeme('貝塔', 'beta')]),
      [{ url: 'https://meme.example.com/beta/small-160/cccccc000001.gif' }]);
    // 同一個檔名，在不同人格的圖庫是不同的圖
    assert.equal(memeStore.memeTagOfContent('https://meme.example.com/alpha/small-160/cccccc000001.gif'), '阿法');
    assert.equal(memeStore.memeTagOfContent('https://meme.example.com/beta/small-160/cccccc000001.gif'), '貝塔');
    assert.equal(memeStore.memeTagOfContent('https://meme.example.com/gamma/small-160/cccccc000001.gif'), null);
    // 人格段不合法（編碼過的 ..、解不開的 %zz）：格式對但查不到，回 null
    assert.equal(memeStore.memeTagOfContent('https://meme.example.com/%2E%2E/small-160/cccccc000001.gif'), null);
    assert.equal(memeStore.memeTagOfContent('https://meme.example.com/%zz/small-160/cccccc000001.gif'), null);
  });
});

test('多人格：輪流與「最近送過」各人格分開記', () => {
  const many = n => Array.from({ length: n }, (_, i) => ({ id: `p/${i}`, name: `图${i}`, emotion: '害怕', url: `https://example.com/${i}.gif` }));
  resetLib('alpha', { 'memes.json': kit(many(3)) });
  resetLib('beta', { 'memes.json': kit(many(3)) });                     // 同樣的 id，不同人格
  const seenA = new Set();
  for (let i = 0; i < 3; i++) seenA.add(memeStore.extractMemes('[表情:害怕]', 'alpha').memes[0].name);
  assert.equal(seenA.size, 3);
  // alpha 已經送完一輪，不影響 beta：beta 一樣輪得到全部 3 張
  const seenB = new Set();
  for (let i = 0; i < 3; i++) seenB.add(memeStore.extractMemes('[表情:害怕]', 'beta').memes[0].name);
  assert.equal(seenB.size, 3);
});

test('人格代號不合法時整個功能關閉（不碰任何資料夾），標記照樣移除', () => {
  resetLib('alpha', { '開心.png': 'x' });
  for (const bad of ['..', '../alpha', 'a/b', '', 'bad key!', null]) {
    assert.equal(memeStore._internal.memeDir(bad), null, String(bad));
    assert.deepEqual(memeStore.listMemes(bad), [], String(bad));
    assert.equal(memeStore.getMemePrompt(bad), '', String(bad));
    assert.equal(memeStore.resolveMeme('開心', bad), null, String(bad));
  }
  assert.deepEqual(memeStore.extractMemes('哈哈\n[表情:開心]', '../alpha'), { text: '哈哈', memes: [] });
});

test('listLibraries：只列有圖、代號合法的人格資料夾，依代號排序', () => {
  fs.rmSync(path.join(TMP, 'memes'), { recursive: true, force: true });
  memeStore._internal.resetCache();
  assert.deepEqual(memeStore.listLibraries(), []);                       // 沒有 data/memes/
  resetLib('beta', { 'a.png': 'x', 'b.gif': 'x' });
  resetLib('alpha', { 'a.png': 'x' });
  resetLib('empty', { 'notes.txt': 'x' });
  resetLib('bad key', { 'a.png': 'x' });
  fs.writeFileSync(path.join(TMP, 'memes', 'loose.png'), 'x');
  assert.deepEqual(memeStore.listLibraries(), [{ key: 'alpha', count: 1 }, { key: 'beta', count: 2 }]);
});

// ── 接上 aiCore（system instruction、歷史與引用的表情包還原） ──

const aiCore = require('../handlers/ai/aiCore');
const msgLog = require('../handlers/ai/aiMessageLog');

const noMentions = () => ({ users: new Map(), roles: new Map(), channels: new Map(), repliedUser: null });

test('aiCore：有圖庫時 system instruction 帶【表情包】，語音不帶；沒有圖庫時不加', () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  memeStore._internal.resetCache();
  assert.ok(!aiCore.buildSystemInstruction().includes('【表情包】'));
  reset({ '嘴饞.png': 'x' });
  assert.ok(aiCore.buildSystemInstruction().includes('【表情包】'));          // 鎖定時預設用鎖定的人格
  assert.ok(!aiCore.buildSystemInstruction({ isVoice: true }).includes('【表情包】'));
  // 多人格：用這次人格的圖庫
  resetLib('alpha', { '開心.png': 'x' });
  assert.ok(aiCore.buildSystemInstruction({ mode: 'alpha' }).includes('- 開心'));
  assert.ok(!aiCore.buildSystemInstruction({ mode: 'alpha' }).includes('嘴饞'));
});

test('aiCore：splitMemeAttachments 還原 Bot 的表情包附件與網址，其他附件照舊；人類訊息原樣', async () => {
  reset({ 'memes.json': kit(KIT) });
  const hash = memeStore._internal.hashId('p/1N01_摸鱼');
  const attachments = new Map([
    ['1', { name: `meme-${hash}.gif` }],
    ['2', { name: 'meme-ffffffffff.png' }],
    ['3', { name: 'photo.png' }],
  ]);
  const bot = aiCore._internal.splitMemeAttachments({ author: { id: 'BOT' }, attachments }, 'BOT');
  assert.deepEqual(bot.memeTags, ['[表情:摸鱼]', '[表情包]']);
  assert.deepEqual([...bot.attachments.keys()], ['3']);
  // 指定人格：附件查那個人格的圖庫
  const other = aiCore._internal.splitMemeAttachments({ author: { id: 'BOT' }, attachments }, 'BOT', 'gamma');
  assert.deepEqual(other.memeTags, ['[表情包]', '[表情包]']);

  const human = aiCore._internal.splitMemeAttachments({ author: { id: 'U' }, attachments }, 'BOT');
  assert.equal(human.attachments, attachments);
  assert.deepEqual(human.memeTags, []);

  await withPublicUrl('https://meme.example.com', async () => {
    const url = 'https://meme.example.com/testfish/small-160/aaaaaaaaaaaa.gif';
    const byUrl = aiCore._internal.splitMemeAttachments({ author: { id: 'BOT' }, content: url, attachments: new Map() }, 'BOT');
    assert.deepEqual(byUrl.memeTags, ['[表情:摸鱼]']);
    assert.equal(byUrl.contentIsMeme, true);
    const humanUrl = aiCore._internal.splitMemeAttachments({ author: { id: 'U' }, content: url, attachments: new Map() }, 'BOT');
    assert.equal(humanUrl.contentIsMeme, false);
  });
});

test('aiCore：引用 Bot 自己的表情包（附件或網址）時換成 [表情:名字]，不下載圖片、不抓網址預覽', async () => {
  reset({ 'memes.json': kit(KIT) });
  const hash = memeStore._internal.hashId('p/1N01_摸鱼');
  const makeMessage = refMsg => ({
    id: 'CUR', author: { id: 'U', bot: false, username: 'u' }, member: null, content: '笑死',
    reference: { messageId: 'REF' }, embeds: [], attachments: new Map(), mentions: noMentions(),
    channel: { messages: { fetch: async () => refMsg } },
  });

  let touched = false;
  const memeAtt = { name: `meme-${hash}.gif`, get url() { touched = true; return 'https://127.0.0.1:1/x.gif'; } };
  const refAtt = {
    id: 'REF', author: { id: 'BOT', bot: true, username: 'bot' }, member: null, content: '',
    attachments: new Map([['a', memeAtt]]), embeds: [], mentions: noMentions(),
  };
  const parts = await aiCore._internal.buildMessagePartsWithReference(makeMessage(refAtt), '笑死', [], 'BOT', 'testfish', 'U');
  assert.ok(parts.every(p => !p.inlineData));
  assert.match(parts[0].text, /\[表情:摸鱼\]/);
  assert.equal(touched, false);

  await withPublicUrl('https://meme.example.com', async () => {
    const url = 'https://meme.example.com/testfish/small-160/aaaaaaaaaaaa.gif';
    let embedsTouched = false;
    const refUrl = {
      id: 'REF', author: { id: 'BOT', bot: true, username: 'bot' }, member: null, content: url,
      attachments: new Map(),
      get embeds() { embedsTouched = true; return [{ data: { type: 'image', url } }]; },
      mentions: noMentions(),
    };
    const urlParts = await aiCore._internal.buildMessagePartsWithReference(makeMessage(refUrl), '笑死', [], 'BOT', 'testfish', 'U');
    assert.ok(urlParts.every(p => !p.inlineData));
    assert.match(urlParts[0].text, /\[表情:摸鱼\]/);
    assert.ok(!urlParts[0].text.includes('meme.example.com'));
    assert.equal(embedsTouched, false);
  });
});

test('aiCore：歷史裡 Bot 的表情包用「當時回覆的人格」的圖庫還原，查不到紀錄時用這次的人格', async () => {
  resetLib('alpha', { '開心.png': 'x' });
  resetLib('beta', { '生氣.png': 'x' });
  const BOT = '500000000000000001';
  const botMsg = (id, file) => ({
    id, author: { id: BOT, bot: true, username: 'bot' }, member: null, content: '',
    attachments: new Map([['a', { name: `meme-${memeStore._internal.hashId(file)}.png` }]]),
    embeds: [], mentions: noMentions(),
  });
  const logged = botMsg('700000000000000101', '開心');
  const unlogged = botMsg('700000000000000102', '生氣');
  msgLog.recordBotMessageContext(logged.id, 'alpha', 'U', 'u', { kind: 'multi', scopeKey: null });
  const history = await aiCore._internal.renderHistoryMessages([logged, unlogged], BOT, { labelFn: () => 'u', mode: 'beta' });
  assert.deepEqual(history.map(c => c.parts.map(p => p.text)), [['[表情:開心]'], ['[表情:生氣]']]);
});
