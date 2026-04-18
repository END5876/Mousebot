// handlers/bilibiliHandler.js（重構版）
// 職責：串流播放 + 影片資訊抓取 + 重試機制
// 佇列 / 指令 / 控制面板 → 全部交由 unifiedQueue.js 管理

const {
  createAudioResource,
  StreamType,
} = require('@discordjs/voice');
const { EmbedBuilder } = require('discord.js');
const { spawn, exec }  = require('child_process');
const { promisify }    = require('util');
const fs   = require('fs');
const path = require('path');

const { registerEngine, stopAll } = require('./unifiedQueue');

const execAsync = promisify(exec);

// ── 環境偵測 ─────────────────────────────────────────────
const isHeroku  = process.env.DYNO !== undefined;
const ytdlpPath = 'yt-dlp';

// ── Cookies 配置 ─────────────────────────────────────────
const COOKIES_PATH      = path.join(__dirname, '..', 'cookies.txt');
const TEMP_COOKIES_PATH = '/tmp/bili_cookies.txt';

const BILIBILI_HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer'        : 'https://www.bilibili.com/',
  'Origin'         : 'https://www.bilibili.com',
  'Accept'         : '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection'     : 'keep-alive',
  'Sec-Fetch-Dest' : 'empty',
  'Sec-Fetch-Mode' : 'cors',
  'Sec-Fetch-Site' : 'same-site',
};

let BILIBILI_COOKIES_FILE = null;

// ── 重試配置 ──────────────────────────────────────────────
const MAX_RETRIES            = 3;
const RETRY_DELAY            = 3000;
const MAX_CONSECUTIVE_ERRORS = 5;

// ── 進程 & 錯誤計數 ───────────────────────────────────────
const activeProcesses = new Map(); // guildId -> ChildProcess
const errorCounts     = new Map(); // guildId -> number

// ════════════════════════════════════════════════════════
//  Cookies 準備
// ════════════════════════════════════════════════════════
function prepareBilibiliCookies() {
  if (fs.existsSync(COOKIES_PATH)) {
    console.log('✅ 找到 cookies.txt 文件');
    return COOKIES_PATH;
  }

  const sessdata   = process.env.BILIBILI_SESSDATA;
  const biliJct    = process.env.BILIBILI_BILI_JCT;
  const dedeUserId = process.env.BILIBILI_DEDEUSERID;

  if (sessdata) {
    console.log('✅ 從環境變數生成 Cookies');
    let content = '# Netscape HTTP Cookie File\n';
    content += `.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\t${sessdata}\n`;
    if (biliJct)    content += `.bilibili.com\tTRUE\t/\tFALSE\t0\tbili_jct\t${biliJct}\n`;
    if (dedeUserId) content += `.bilibili.com\tTRUE\t/\tFALSE\t0\tDedeUserID\t${dedeUserId}\n`;
    try {
      fs.writeFileSync(TEMP_COOKIES_PATH, content);
      console.log('✅ Cookies 已寫入臨時文件:', TEMP_COOKIES_PATH);
      return TEMP_COOKIES_PATH;
    } catch (err) {
      console.error('❌ 無法寫入 Cookies 文件:', err);
      return null;
    }
  }

  console.warn('⚠️ 未找到 Bilibili Cookies，播放可能失敗');
  return null;
}

// ════════════════════════════════════════════════════════
//  環境檢查
// ════════════════════════════════════════════════════════
async function checkYtDlp() {
  try {
    const { stdout } = await execAsync(`${ytdlpPath} --version`);
    console.log(`✅ yt-dlp 版本: ${stdout.trim()}`);
    return true;
  } catch {
    console.error('❌ yt-dlp 未安裝');
    return false;
  }
}

async function checkFFmpeg() {
  for (const p of ['ffmpeg', '/app/vendor/ffmpeg/ffmpeg', '/usr/bin/ffmpeg']) {
    try { await execAsync(`${p} -version`); console.log(`✅ FFmpeg: ${p}`); return true; }
    catch {}
  }
  console.error('❌ FFmpeg 未找到');
  return false;
}

// ════════════════════════════════════════════════════════
//  工具
// ════════════════════════════════════════════════════════
function formatDuration(seconds) {
  if (!seconds) return '未知';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

function cleanupProcess(guildId) {
  const old = activeProcesses.get(guildId);
  if (old && !old.killed) {
    console.log('🧹 清理舊的 yt-dlp 進程');
    try {
      old.kill('SIGTERM');
      setTimeout(() => { if (!old.killed) old.kill('SIGKILL'); }, 1000);
    } catch {}
    activeProcesses.delete(guildId);
  }
}

function buildYtdlpArgs(url) {
  const args = [
    '-f', 'bestaudio/best', '-o', '-',
    '--no-playlist', '--quiet', '--no-warnings',
    '--extract-audio', '--audio-format', 'opus',
    '--audio-quality', '0', '--buffer-size', '16K',
  ];

  if (url.includes('bilibili.com')) {
    if (BILIBILI_COOKIES_FILE) args.push('--cookies', BILIBILI_COOKIES_FILE);
    args.push(
      '--user-agent', BILIBILI_HEADERS['User-Agent'],
      '--referer',    BILIBILI_HEADERS['Referer'],
      '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
      '--add-header', `Accept:${BILIBILI_HEADERS['Accept']}`,
      '--no-check-certificate',
      '--extractor-args', 'bilibili:getcomments=false',
      '--extractor-args', 'bilibili:getdanmaku=false',
      '--sleep-requests',     isHeroku ? '5' : '2',
      '--sleep-interval',     isHeroku ? '5' : '2',
      '--max-sleep-interval', isHeroku ? '10' : '5',
    );
  } else {
    args.push('--no-check-certificate');
  }

  if (isHeroku) {
    args.push('--prefer-free-formats', '--socket-timeout', '60', '--retries', '10', '--fragment-retries', '10');
  }

  args.push(url);
  return args;
}

// ════════════════════════════════════════════════════════
//  getInfo（取得影片資訊）
// ════════════════════════════════════════════════════════
async function getInfo(url) {
  return new Promise((resolve, reject) => {
    const args = ['--dump-json', '--no-playlist', '--no-warnings', '--skip-download'];

    if (url.includes('bilibili.com')) {
      if (BILIBILI_COOKIES_FILE) args.push('--cookies', BILIBILI_COOKIES_FILE);
      args.push(
        '--user-agent', BILIBILI_HEADERS['User-Agent'],
        '--referer',    BILIBILI_HEADERS['Referer'],
        '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
        '--no-check-certificate',
        '--extractor-args', 'bilibili:getcomments=false',
        '--extractor-args', 'bilibili:getdanmaku=false',
        '--sleep-requests',     isHeroku ? '5' : '2',
        '--sleep-interval',     isHeroku ? '5' : '2',
        '--max-sleep-interval', isHeroku ? '10' : '5',
      );
      if (isHeroku) args.push('--socket-timeout', '60', '--retries', '10');
    }

    args.push(url);
    const ytdlp = spawn(ytdlpPath, args);
    let data = '', errorData = '';

    ytdlp.stdout.on('data', c => { data += c.toString(); });
    ytdlp.stderr.on('data', c => { errorData += c.toString(); });

    ytdlp.on('close', code => {
      if (code !== 0) {
        console.error('yt-dlp 錯誤輸出:', errorData);
        if      (errorData.includes('412')) reject(new Error('Bilibili 反爬蟲限制 (412)'));
        else if (errorData.includes('403')) reject(new Error('影片無法訪問 (403)，可能有地區限制或需要大會員'));
        else if (errorData.includes('404')) reject(new Error('找不到影片 (404)'));
        else reject(new Error(`無法獲取影片資訊 (code: ${code})`));
        return;
      }
      try {
        const info = JSON.parse(data.trim().split('\n').pop());
        resolve({
          url,
          title:     info.title    || '未知標題',
          author:    info.uploader || info.channel || info.creator || '未知作者',
          duration:  formatDuration(info.duration),
          thumbnail: info.thumbnail || null,
        });
      } catch { reject(new Error('解析影片資訊失敗')); }
    });

    ytdlp.on('error', err => reject(new Error('執行 yt-dlp 失敗: ' + err.message)));
  });
}

// ════════════════════════════════════════════════════════
//  playStream（由 unifiedQueue 呼叫）
//  內含重試機制，失敗時透過 player.emit('error') 通知上層
// ════════════════════════════════════════════════════════
async function playStream(guildId, item, player, retryCount = 0) {
  cleanupProcess(guildId);

  try {
    console.log(`🎵 [Bilibili] 串流: ${item.title} (重試: ${retryCount}/${MAX_RETRIES})`);

    const ytdlp = spawn(ytdlpPath, buildYtdlpArgs(item.url), {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    activeProcesses.set(guildId, ytdlp);

    let hasError = false, errorOutput = '', dataReceived = false;

    ytdlp.stdout.on('data', () => { dataReceived = true; });
    ytdlp.stderr.on('data', data => {
      const err = data.toString();
      if (!err.includes('Deleting original file')) {
        console.error('yt-dlp stderr:', err);
        errorOutput += err;
        if (!err.includes('unable to write data') && !err.includes('Broken pipe') && !err.includes('Invalid argument')) {
          hasError = true;
        }
      }
    });

    ytdlp.on('error', err => { hasError = true; errorOutput = err.message; });
    ytdlp.on('close', (code, signal) => {
      console.log(`yt-dlp 進程結束 (code: ${code}, signal: ${signal}, 數據已接收: ${dataReceived})`);
      if (code !== 0 && !dataReceived && hasError) {
        _handleStreamError(guildId, item, player, retryCount, errorOutput);
      }
    });

    const resource = createAudioResource(ytdlp.stdout, {
      inputType:    StreamType.Arbitrary,
      inlineVolume: true,
    });
    resource.volume.setVolume(0.5);
    resource.playStream?.on('error', err => { console.error('音頻流錯誤:', err); });

    player.play(resource);
    errorCounts.set(guildId, 0);

  } catch (err) {
    console.error('❌ [Bilibili] playStream 錯誤:', err);
    _handleStreamError(guildId, item, player, retryCount, err.message);
  }
}

// ── 重試 / 跳過邏輯 ──────────────────────────────────────
function _handleStreamError(guildId, item, player, retryCount, errorMessage) {
  const currentErrors = (errorCounts.get(guildId) || 0) + 1;
  errorCounts.set(guildId, currentErrors);
  console.error(`❌ [Bilibili] 串流錯誤 (${currentErrors}/${MAX_CONSECUTIVE_ERRORS}): ${errorMessage}`);

  if (currentErrors >= MAX_CONSECUTIVE_ERRORS) {
    console.error('❌ [Bilibili] 連續錯誤過多，停止播放');
    player.emit('error', new Error(`連續發生 ${currentErrors} 次錯誤，已停止播放`));
    stopAll(guildId);
    return;
  }

  if (retryCount < MAX_RETRIES) {
    console.log(`⏳ [Bilibili] ${RETRY_DELAY / 1000} 秒後重試 (${retryCount + 1}/${MAX_RETRIES})...`);
    setTimeout(() => playStream(guildId, item, player, retryCount + 1), RETRY_DELAY);
  } else {
    console.error('❌ [Bilibili] 重試次數已用盡，通知上層跳過');
    // 觸發 player error → unifiedQueue 的 error handler 會處理跳過
    player.emit('error', new Error(`播放失敗（已重試 ${MAX_RETRIES} 次）：${errorMessage.substring(0, 100)}`));
  }
}

// ════════════════════════════════════════════════════════
//  setupBilibiliEngine
// ════════════════════════════════════════════════════════
async function setupBilibiliEngine() {
  BILIBILI_COOKIES_FILE = prepareBilibiliCookies();

  const [ytdlpOk, ffmpegOk] = await Promise.all([checkYtDlp(), checkFFmpeg()]);
  if (ytdlpOk && ffmpegOk) {
    console.log('✅ [Bilibili] 引擎已就緒');
    console.log(BILIBILI_COOKIES_FILE ? '✅ Bilibili Cookies 已配置' : '⚠️ 未配置 Bilibili Cookies，可能無法播放');
  } else {
    console.warn('⚠️ [Bilibili] 引擎可能無法正常運作');
  }

  // 注入引擎到 unifiedQueue
  registerEngine('bilibili', { playStream, getInfo });
}

module.exports = { setupBilibiliEngine, cleanupProcess };