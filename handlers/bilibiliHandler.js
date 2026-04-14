// handlers/bilibiliHandler.js
const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType
} = require('@discordjs/voice');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder
} = require('discord.js');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const fs   = require('fs');
const path = require('path');

const execAsync = promisify(exec);
const { setMusicPlayer, stopMusicLayer, hasMusicPlaying } = require('./audioManager');

// ── 狀態 Map ─────────────────────────────────────────────
const bilibiliPlayers  = new Map();
const bilibiliQueues   = new Map();
const errorCounts      = new Map();
const activeProcesses  = new Map();
const loopSettings     = new Map(); // 'off' | 'one' | 'all'
const controlMessages  = new Map();

// ── 錯誤處理配置 ─────────────────────────────────────────
const MAX_RETRIES            = 3;
const RETRY_DELAY            = 3000;
const MAX_CONSECUTIVE_ERRORS = 5;

// ── 環境偵測 ─────────────────────────────────────────────
const isHeroku  = process.env.DYNO !== undefined;
const ytdlpPath = 'yt-dlp';

// ── Cookies 配置 ─────────────────────────────────────────
const COOKIES_PATH      = path.join(__dirname, '..', 'cookies.txt');
const TEMP_COOKIES_PATH = '/tmp/bili_cookies.txt';

const BILIBILI_HEADERS = {
  'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer'         : 'https://www.bilibili.com/',
  'Origin'          : 'https://www.bilibili.com',
  'Accept'          : '*/*',
  'Accept-Language' : 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding' : 'gzip, deflate, br',
  'Connection'      : 'keep-alive',
  'Sec-Fetch-Dest'  : 'empty',
  'Sec-Fetch-Mode'  : 'cors',
  'Sec-Fetch-Site'  : 'same-site'
};

// ════════════════════════════════════════════════════════
//  Cookies 準備
// ════════════════════════════════════════════════════════
function prepareBilibiliCookies() {
  if (fs.existsSync(COOKIES_PATH)) {
    console.log('✅ 找到 cookies.txt 文件');
    return COOKIES_PATH;
  }

  const sessdata    = process.env.BILIBILI_SESSDATA;
  const biliJct     = process.env.BILIBILI_BILI_JCT;
  const dedeUserId  = process.env.BILIBILI_DEDEUSERID;

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
    } catch (error) {
      console.error('❌ 無法寫入 Cookies 文件:', error);
      return null;
    }
  }

  console.warn('⚠️ 未找到 Bilibili Cookies，播放可能失敗');
  return null;
}

let BILIBILI_COOKIES_FILE = null;

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
    try {
      await execAsync(`${p} -version`);
      console.log(`✅ FFmpeg 已安裝: ${p}`);
      return true;
    } catch {}
  }
  console.error('❌ FFmpeg 未找到');
  return false;
}

// ════════════════════════════════════════════════════════
//  控制面板（按鈕 + Embed）
// ════════════════════════════════════════════════════════
function createControlButtons(guildId) {
  const loopMode = loopSettings.get(guildId) || 'off';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bili_skip').setLabel('跳過').setEmoji('⏭️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('bili_stop').setLabel('停止').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('bili_loop_one').setLabel('單曲循環').setEmoji('🔂').setStyle(loopMode === 'one' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bili_loop_all').setLabel('列表循環').setEmoji('🔁').setStyle(loopMode === 'all' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bili_queue').setLabel('佇列').setEmoji('📋').setStyle(ButtonStyle.Secondary)
  );
}

async function updateControlPanel(guildId, channel) {
  const playerData = bilibiliPlayers.get(guildId);
  if (!playerData) return;

  const loopMode = loopSettings.get(guildId) || 'off';
  const queue    = bilibiliQueues.get(guildId) || [];

  let loopText = '❌ 關閉';
  if (loopMode === 'one') loopText = '🔂 單曲循環';
  if (loopMode === 'all') loopText = '🔁 列表循環';

  const embed = new EmbedBuilder()
    .setColor(0x00A1D6)
    .setTitle('🎵 正在播放')
    .setDescription(`[${playerData.title}](${playerData.url})`)
    .addFields(
      { name: '作者',     value: playerData.author   || '未知', inline: true },
      { name: '時長',     value: playerData.duration || '未知', inline: true },
      { name: '循環模式', value: loopText,                      inline: true },
      { name: '佇列',     value: `${queue.length} 首`,          inline: true }
    )
    .setThumbnail(playerData.thumbnail || null)
    .setFooter({ text: '使用下方按鈕控制播放' })
    .setTimestamp();

  const row = createControlButtons(guildId);

  try {
    const controlMsg = controlMessages.get(guildId);
    if (controlMsg) {
      try {
        await controlMsg.edit({ embeds: [embed], components: [row] });
      } catch {
        const newMsg = await channel.send({ embeds: [embed], components: [row] });
        controlMessages.set(guildId, newMsg);
      }
    } else {
      const newMsg = await channel.send({ embeds: [embed], components: [row] });
      controlMessages.set(guildId, newMsg);
    }
  } catch (error) {
    console.error('更新控制面板失敗:', error);
  }
}

// ════════════════════════════════════════════════════════
//  核心播放邏輯
// ════════════════════════════════════════════════════════
async function handleVoiceConnectionError(guildId, connection, videoInfo, channel) {
  try {
    console.warn(`⚠️ 嘗試恢復語音連線 (Guild: ${guildId})...`);
    await Promise.race([
      entersState(connection, VoiceConnectionStatus.Ready,      10_000),
      entersState(connection, VoiceConnectionStatus.Signalling, 10_000),
      entersState(connection, VoiceConnectionStatus.Connecting, 10_000),
    ]);
    console.log('✅ VoiceConnection 已恢復');
    if (bilibiliPlayers.has(guildId)) {
      await playBilibiliAudio(guildId, connection, videoInfo, channel, 0);
    }
  } catch (err) {
    console.error('❌ VoiceConnection 無法恢復，停止播放:', err.message);
    channel.send('❌ 語音連線中斷（Cloudflare 521），請重新使用指令播放').catch(() => {});
    stopBilibiliAudio(guildId);
    try { connection.destroy(); } catch {}
  }
}

async function playBilibiliAudio(guildId, connection, videoInfo, channel, retryCount = 0) {
  const player = createAudioPlayer();

  if (!connection.listenerCount('error')) {
    connection.on('error', (error) => {
      console.error(`❌ VoiceConnection 錯誤 (Guild: ${guildId}):`, error.message);
      if (error.message?.includes('521')) {
        console.warn('⚠️ 偵測到 Cloudflare 521，嘗試恢復連線...');
        handleVoiceConnectionError(guildId, connection, videoInfo, channel);
      }
    });
  }

  const playNext = async () => {
    cleanupProcess(guildId);
    try {
      console.log(`🎵 播放: ${videoInfo.title} (重試: ${retryCount}/${MAX_RETRIES})`);

      const ytdlpArgs = [
        '-f', 'bestaudio/best', '-o', '-',
        '--no-playlist', '--quiet', '--no-warnings',
        '--extract-audio', '--audio-format', 'opus',
        '--audio-quality', '0', '--buffer-size', '16K',
      ];

      if (videoInfo.url.includes('bilibili.com')) {
        if (BILIBILI_COOKIES_FILE) ytdlpArgs.push('--cookies', BILIBILI_COOKIES_FILE);
        ytdlpArgs.push(
          '--user-agent', BILIBILI_HEADERS['User-Agent'],
          '--referer', BILIBILI_HEADERS['Referer'],
          '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
          '--add-header', `Accept:${BILIBILI_HEADERS['Accept']}`,
          '--no-check-certificate',
          '--extractor-args', 'bilibili:getcomments=false',
          '--extractor-args', 'bilibili:getdanmaku=false',
          '--sleep-requests', isHeroku ? '5' : '2',
          '--sleep-interval',  isHeroku ? '5' : '2',
          '--max-sleep-interval', isHeroku ? '10' : '5'
        );
      } else if (videoInfo.url.includes('youtube.com') || videoInfo.url.includes('youtu.be')) {
        ytdlpArgs.push('--no-check-certificate');
      }

      if (isHeroku) {
        ytdlpArgs.push('--prefer-free-formats', '--socket-timeout', '60', '--retries', '10', '--fragment-retries', '10');
      }

      ytdlpArgs.push(videoInfo.url);

      const ytdlp = spawn(ytdlpPath, ytdlpArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      activeProcesses.set(guildId, ytdlp);

      let hasError = false, errorOutput = '', dataReceived = false;

      ytdlp.stdout.on('data', () => { dataReceived = true; });
      ytdlp.stderr.on('data', (data) => {
        const err = data.toString();
        if (!err.includes('Deleting original file')) {
          console.error('yt-dlp 錯誤:', err);
          errorOutput += err;
          if (!err.includes('unable to write data') && !err.includes('Broken pipe') && !err.includes('Invalid argument')) {
            hasError = true;
          }
        }
      });
      ytdlp.on('error', (err) => { hasError = true; errorOutput = err.message; });
      ytdlp.on('close', (code, signal) => {
        console.log(`yt-dlp 進程結束 (code: ${code}, signal: ${signal}, 數據已接收: ${dataReceived})`);
        if (code !== 0 && !dataReceived && hasError) {
          handlePlaybackError(guildId, connection, videoInfo, channel, retryCount, errorOutput);
        }
      });

      const resource = createAudioResource(ytdlp.stdout, { inputType: StreamType.Arbitrary, inlineVolume: true });
      resource.volume.setVolume(0.5);
      resource.playStream.on('error', (err) => { console.error('音頻流錯誤:', err); });

      player.play(resource);
      errorCounts.set(guildId, 0);

    } catch (error) {
      console.error('播放錯誤：', error);
      handlePlaybackError(guildId, connection, videoInfo, channel, retryCount, error.message);
    }
  };

  player.on(AudioPlayerStatus.Idle, async () => {
    if (!bilibiliPlayers.has(guildId)) return;

    const loopMode = loopSettings.get(guildId) || 'off';

    if (loopMode === 'one') {
      console.log(`🔂 單曲循環: ${videoInfo.title}`);
      channel.send({ embeds: [
        new EmbedBuilder().setColor(0x00A1D6).setTitle('🔂 單曲循環')
          .setDescription(`[${videoInfo.title}](${videoInfo.url})`)
          .setThumbnail(videoInfo.thumbnail || null)
      ]}).catch(() => {});
      await playBilibiliAudio(guildId, connection, videoInfo, channel, 0);
      return;
    }

    const queue = bilibiliQueues.get(guildId) || [];

    if (queue.length > 0) {
      const nextVideo = queue.shift();
      bilibiliQueues.set(guildId, queue);
      console.log(`⏭️ 播放下一首: ${nextVideo.title}`);

      channel.send({ embeds: [
        new EmbedBuilder().setColor(0x00A1D6).setTitle('⏭️ 正在播放下一首')
          .setDescription(`[${nextVideo.title}](${nextVideo.url})`)
          .addFields(
            { name: '作者',     value: nextVideo.author || '未知', inline: true },
            { name: '剩餘佇列', value: `${queue.length} 首`,       inline: true }
          )
          .setThumbnail(nextVideo.thumbnail || null)
      ]}).catch(() => {});

      bilibiliPlayers.set(guildId, { player, url: nextVideo.url, title: nextVideo.title, author: nextVideo.author, duration: nextVideo.duration, thumbnail: nextVideo.thumbnail });
      await playBilibiliAudio(guildId, connection, nextVideo, channel, 0);
      await updateControlPanel(guildId, channel);

    } else {
      if (loopMode === 'all') {
        channel.send('🔁 列表循環功能需要保存原始播放列表，請重新添加歌曲').catch(() => {});
      }
      console.log('✅ 播放完畢，佇列為空');
      stopBilibiliAudio(guildId);
      channel.send('✅ 所有歌曲播放完畢').catch(() => {});
    }
  });

  player.on('error', (error) => {
    console.error('❌ 播放器錯誤：', error);
    if (error.message?.includes('aborted') || error.message?.includes('premature close')) {
      console.log('⚠️ 管道正常關閉，忽略錯誤');
      return;
    }
    handlePlaybackError(guildId, connection, videoInfo, channel, retryCount, error.message);
  });

  bilibiliPlayers.set(guildId, {
    player,
    url:       videoInfo.url,
    title:     videoInfo.title,
    author:    videoInfo.author,
    duration:  videoInfo.duration,
    thumbnail: videoInfo.thumbnail
  });

  await playNext();

  // ✅ 改用 audioManager 接管 subscribe，避免與 TTS / 靜音層衝突
  setMusicPlayer(guildId, player);
}

function cleanupProcess(guildId) {
  const old = activeProcesses.get(guildId);
  if (old && !old.killed) {
    console.log('🧹 清理舊的 yt-dlp 進程');
    try {
      old.kill('SIGTERM');
      setTimeout(() => { if (!old.killed) old.kill('SIGKILL'); }, 1000);
    } catch (err) { console.error('清理進程失敗:', err); }
    activeProcesses.delete(guildId);
  }
}

async function handlePlaybackError(guildId, connection, videoInfo, channel, retryCount, errorMessage) {
  const currentErrors = (errorCounts.get(guildId) || 0) + 1;
  errorCounts.set(guildId, currentErrors);
  console.error(`❌ 播放錯誤 (${currentErrors}/${MAX_CONSECUTIVE_ERRORS}):`, errorMessage);

  if (currentErrors >= MAX_CONSECUTIVE_ERRORS) {
    channel.send({ embeds: [
      new EmbedBuilder().setColor(0xFF0000).setTitle('❌ 播放失敗')
        .setDescription('連續發生多次錯誤，已停止播放')
        .addFields(
          { name: '錯誤次數', value: `${currentErrors}`,                      inline: true },
          { name: '最後錯誤', value: errorMessage.substring(0, 100),           inline: false }
        )
        .setFooter({ text: '請檢查網路連線或 Cookies 配置' })
    ]}).catch(() => {});
    stopBilibiliAudio(guildId);
    return;
  }

  if (retryCount < MAX_RETRIES) {
    console.log(`⏳ ${RETRY_DELAY/1000} 秒後重試 (${retryCount + 1}/${MAX_RETRIES})...`);
    setTimeout(async () => {
      if (bilibiliPlayers.has(guildId)) await playBilibiliAudio(guildId, connection, videoInfo, channel, retryCount + 1);
    }, RETRY_DELAY);
  } else {
    console.error('❌ 重試次數已用盡，跳過此歌曲');
    channel.send(`⚠️ 播放失敗，跳過：**${videoInfo.title}**`).catch(() => {});

    const queue = bilibiliQueues.get(guildId) || [];
    if (queue.length > 0 && bilibiliPlayers.has(guildId)) {
      const nextVideo = queue.shift();
      bilibiliQueues.set(guildId, queue);
      setTimeout(async () => { await playBilibiliAudio(guildId, connection, nextVideo, channel, 0); }, 2000);
    } else {
      stopBilibiliAudio(guildId);
      channel.send('❌ 播放失敗且佇列為空，已停止播放').catch(() => {});
    }
  }
}

async function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const ytdlpArgs = ['--dump-json', '--no-playlist', '--no-warnings', '--skip-download'];

    if (url.includes('bilibili.com')) {
      if (BILIBILI_COOKIES_FILE) ytdlpArgs.push('--cookies', BILIBILI_COOKIES_FILE);
      ytdlpArgs.push(
        '--user-agent', BILIBILI_HEADERS['User-Agent'],
        '--referer', BILIBILI_HEADERS['Referer'],
        '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
        '--no-check-certificate',
        '--extractor-args', 'bilibili:getcomments=false',
        '--extractor-args', 'bilibili:getdanmaku=false',
        '--sleep-requests', isHeroku ? '5' : '2',
        '--sleep-interval',  isHeroku ? '5' : '2',
        '--max-sleep-interval', isHeroku ? '10' : '5'
      );
      if (isHeroku) ytdlpArgs.push('--socket-timeout', '60', '--retries', '10');
    }

    ytdlpArgs.push(url);

    const ytdlp = spawn(ytdlpPath, ytdlpArgs);
    let data = '', errorData = '';

    ytdlp.stdout.on('data', (chunk) => { data += chunk.toString(); });
    ytdlp.stderr.on('data', (chunk) => { errorData += chunk.toString(); });

    ytdlp.on('close', (code) => {
      if (code !== 0) {
        console.error('yt-dlp 錯誤輸出:', errorData);
        if      (errorData.includes('412')) reject(new Error('❌ Bilibili 反爬蟲限制 (Error 412)'));
        else if (errorData.includes('403')) reject(new Error('❌ 影片無法訪問 (403)，可能有地區限制或需要大會員'));
        else if (errorData.includes('404')) reject(new Error('❌ 找不到影片 (404)'));
        else reject(new Error(`❌ 無法獲取影片資訊 (code: ${code})`));
        return;
      }
      try {
        const info = JSON.parse(data.trim().split('\n').pop());
        resolve({
          url,
          title:     info.title    || '未知標題',
          author:    info.uploader || info.channel || info.creator || '未知作者',
          duration:  formatDuration(info.duration),
          thumbnail: info.thumbnail || null
        });
      } catch { reject(new Error('解析影片資訊失敗')); }
    });

    ytdlp.on('error', (err) => { reject(new Error('執行 yt-dlp 失敗: ' + err.message)); });
  });
}

function stopBilibiliAudio(guildId) {
  const playerData = bilibiliPlayers.get(guildId);
  if (playerData) {
    playerData.player.stop();
    bilibiliPlayers.delete(guildId);
    bilibiliQueues.delete(guildId);
    errorCounts.delete(guildId);
    loopSettings.delete(guildId);
    controlMessages.delete(guildId);
    cleanupProcess(guildId);
    // ✅ 通知 audioManager 音樂層已停止，退回靜音層
    stopMusicLayer(guildId);
    console.log(`⏹️ 停止播放 (Guild: ${guildId})`);
  }
}

function isValidUrl(url) { try { new URL(url); return true; } catch { return false; } }

function getPlatformName(url) {
  if (url.includes('bilibili.com'))                             return 'Bilibili';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'YouTube';
  if (url.includes('soundcloud.com'))                           return 'SoundCloud';
  if (url.includes('twitter.com') || url.includes('x.com'))    return 'Twitter/X';
  if (url.includes('twitch.tv'))                                return 'Twitch';
  return '未知平台';
}

function formatDuration(seconds) {
  if (!seconds) return '未知';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

// ════════════════════════════════════════════════════════
//  Slash Command 核心：播放邏輯（供 /play 使用）
// ════════════════════════════════════════════════════════
async function handleBilibiliPlay(interaction, url) {
  const guildId = interaction.guildId;

  if (!(await checkYtDlp())) {
    return interaction.editReply('❌ 系統未正確安裝 yt-dlp，請聯繫管理員');
  }
  if (!isValidUrl(url)) {
    return interaction.editReply('❌ 請提供有效的影片網址');
  }

  let connection = getVoiceConnection(guildId);

  if (!connection) {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.editReply('❌ 你必須先加入語音頻道！');
    }

    try {
      connection = joinVoiceChannel({
        channelId:      voiceChannel.id,
        guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf:       false,
        selfMute:       false,
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch (err) {
          console.error(`❌ 語音連線重連失敗 (Guild: ${guildId}):`, err.message);
          try { connection.destroy(); } catch {}
          stopBilibiliAudio(guildId);
          interaction.channel.send('❌ 語音連線已斷開，請重新使用指令播放').catch(() => {});
        }
      });

      connection.on('error', (error) => {
        console.error(`❌ VoiceConnection 錯誤 (Guild: ${guildId}):`, error.message);
      });

    } catch (error) {
      console.error('加入語音頻道時發生錯誤：', error);
      return interaction.editReply('❌ 加入語音頻道時發生錯誤');
    }
  }

  try {
    const videoInfo = await getVideoInfo(url);
    const platform  = getPlatformName(url);

    if (bilibiliPlayers.has(guildId)) {
      // 加入佇列
      const queue = bilibiliQueues.get(guildId) || [];
      queue.push(videoInfo);
      bilibiliQueues.set(guildId, queue);

      await interaction.editReply({ content: null, embeds: [
        new EmbedBuilder()
          .setColor(0x00A1D6)
          .setTitle(`➕ 已加入佇列 (${platform})`)
          .setDescription(`[${videoInfo.title}](${url})`)
          .addFields(
            { name: '作者',     value: videoInfo.author   || '未知', inline: true },
            { name: '時長',     value: videoInfo.duration || '未知', inline: true },
            { name: '佇列位置', value: `第 ${queue.length} 首`,      inline: true }
          )
          .setThumbnail(videoInfo.thumbnail || null)
          .setTimestamp()
      ]});
      await updateControlPanel(guildId, interaction.channel);
      return;
    }

    // 直接播放
    await playBilibiliAudio(guildId, connection, videoInfo, interaction.channel);

    await interaction.editReply({ content: null, embeds: [
      new EmbedBuilder()
        .setColor(platform === 'Bilibili' ? 0x00A1D6 : 0xFF0000)
        .setTitle(`📺 開始播放 (${platform})`)
        .setDescription(`[${videoInfo.title}](${url})`)
        .addFields(
          { name: '作者', value: videoInfo.author   || '未知', inline: true },
          { name: '時長', value: videoInfo.duration || '未知', inline: true }
        )
        .setThumbnail(videoInfo.thumbnail || null)
        .setFooter({ text: '使用下方按鈕控制播放' })
        .setTimestamp()
    ]});
    await updateControlPanel(guildId, interaction.channel);

  } catch (error) {
    console.error('播放音頻時發生錯誤：', error);
    let errorMsg = '❌ 播放失敗：' + error.message;
    if (url.includes('bilibili.com')) {
      errorMsg += BILIBILI_COOKIES_FILE
        ? '\n\n💡 **可能原因：** Cookies 過期 / 地區限制 / 需要大會員'
        : '\n\n💡 **提示：** 未配置 Bilibili Cookies，請參考文檔配置';
    }
    await interaction.editReply(errorMsg);
  }
}

// ════════════════════════════════════════════════════════
//  setupBilibiliCommands
// ════════════════════════════════════════════════════════
function setupBilibiliCommands(client) {
  BILIBILI_COOKIES_FILE = prepareBilibiliCookies();

  Promise.all([checkYtDlp(), checkFFmpeg()]).then(([ytdlp, ffmpeg]) => {
    if (ytdlp && ffmpeg) {
      console.log('✅ Bilibili 功能已就緒');
      console.log(BILIBILI_COOKIES_FILE ? '✅ Bilibili Cookies 已配置' : '⚠️ 未配置 Bilibili Cookies，可能無法播放');
    } else {
      console.warn('⚠️ Bilibili 功能可能無法正常運作');
    }
  });

  // ── 按鈕互動（customId 加上 bili_ 前綴避免衝突）────────
  client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('bili_')) return;

    const guildId    = interaction.guildId;
    const playerData = bilibiliPlayers.get(guildId);

    if (!playerData) {
      return interaction.reply({ content: '❌ 目前沒有播放音頻', ephemeral: true });
    }

    try {
      switch (interaction.customId) {

        case 'bili_skip': {
          const queue = bilibiliQueues.get(guildId) || [];
          if (queue.length === 0) {
            stopBilibiliAudio(guildId);
            await interaction.reply({ content: '⏭️ 已跳過，佇列為空，停止播放', ephemeral: true });
          } else {
            await interaction.reply({ content: '⏭️ 跳過當前歌曲', ephemeral: true });
            playerData.player.stop();
          }
          break;
        }

        case 'bili_stop':
          stopBilibiliAudio(guildId);
          await interaction.reply({ content: '⏹️ 已停止播放', ephemeral: true });
          break;

        case 'bili_loop_one': {
          const cur = loopSettings.get(guildId);
          const next = cur === 'one' ? 'off' : 'one';
          loopSettings.set(guildId, next);
          await interaction.reply({ content: next === 'one' ? '🔂 單曲循環已開啟' : '❌ 循環已關閉', ephemeral: true });
          await updateControlPanel(guildId, interaction.channel);
          break;
        }

        case 'bili_loop_all': {
          const cur = loopSettings.get(guildId);
          const next = cur === 'all' ? 'off' : 'all';
          loopSettings.set(guildId, next);
          await interaction.reply({ content: next === 'all' ? '🔁 列表循環已開啟' : '❌ 循環已關閉', ephemeral: true });
          await updateControlPanel(guildId, interaction.channel);
          break;
        }

        case 'bili_queue': {
          const queueList = bilibiliQueues.get(guildId) || [];
          const loopMode  = loopSettings.get(guildId) || 'off';
          let loopText = '❌ 關閉';
          if (loopMode === 'one') loopText = '🔂 單曲循環';
          if (loopMode === 'all') loopText = '🔁 列表循環';

          const embed = new EmbedBuilder()
            .setColor(0x00A1D6).setTitle('🎵 播放佇列')
            .addFields(
              { name: '🎵 正在播放', value: `[${playerData.title}](${playerData.url})\n作者: ${playerData.author || '未知'}`, inline: false },
              { name: '循環模式',    value: loopText,                  inline: true },
              { name: '佇列數量',    value: `${queueList.length} 首`,  inline: true }
            ).setTimestamp();

          if (queueList.length > 0) {
            const queueText = queueList.map((item, i) => `${i+1}. [${item.title}](${item.url})`).join('\n');
            embed.addFields({ name: '📋 佇列', value: queueText.length > 1024 ? queueText.slice(0, 1021) + '...' : queueText, inline: false });
          }

          await interaction.reply({ embeds: [embed], ephemeral: true });
          break;
        }
      }
    } catch (error) {
      console.error('按鈕互動錯誤:', error);
      try { await interaction.reply({ content: '❌ 操作失敗', ephemeral: true }); } catch {}
    }
  });

  // ── 注入所有 Slash Commands ──────────────────────────

  // /play
  client.commands.set('play', {
    data: new SlashCommandBuilder()
      .setName('play')
      .setDescription('播放 Bilibili / YouTube 影片音訊')
      .addStringOption(opt =>
        opt.setName('url').setDescription('影片網址').setRequired(true)
      ),
    async execute(interaction) {
      await interaction.deferReply();
      await handleBilibiliPlay(interaction, interaction.options.getString('url'));
    }
  });

  // /stop
  client.commands.set('stop', {
    data: new SlashCommandBuilder().setName('stop').setDescription('停止播放並清空佇列'),
    async execute(interaction) {
      if (!bilibiliPlayers.has(interaction.guildId)) {
        return interaction.reply({ content: '❌ 目前沒有播放音頻', ephemeral: true });
      }
      stopBilibiliAudio(interaction.guildId);
      await interaction.reply({ content: '⏹️ 已停止播放' });
    }
  });

  // /skip
  client.commands.set('skip', {
    data: new SlashCommandBuilder().setName('skip').setDescription('跳過當前歌曲'),
    async execute(interaction) {
      const playerData = bilibiliPlayers.get(interaction.guildId);
      if (!playerData) return interaction.reply({ content: '❌ 目前沒有播放音頻', ephemeral: true });

      const queue = bilibiliQueues.get(interaction.guildId) || [];
      if (queue.length === 0) {
        stopBilibiliAudio(interaction.guildId);
        return interaction.reply({ content: '⏭️ 已跳過，佇列為空，停止播放' });
      }
      playerData.player.stop();
      await interaction.reply({ content: '⏭️ 跳過當前歌曲' });
    }
  });

  // /loop
  client.commands.set('loop', {
    data: new SlashCommandBuilder().setName('loop').setDescription('切換循環模式（關閉 → 單曲 → 列表）'),
    async execute(interaction) {
      const playerData = bilibiliPlayers.get(interaction.guildId);
      if (!playerData) return interaction.reply({ content: '❌ 目前沒有播放音頻', ephemeral: true });

      const cur  = loopSettings.get(interaction.guildId) || 'off';
      const next = cur === 'off' ? 'one' : cur === 'one' ? 'all' : 'off';
      loopSettings.set(interaction.guildId, next);

      const loopText    = next === 'one' ? '🔂 單曲循環已開啟' : next === 'all' ? '🔁 列表循環已開啟' : '❌ 循環已關閉';
      const description = next === 'one' ? '當前歌曲將會不斷重複播放' : next === 'all' ? '播放完所有歌曲後將重新開始' : '播放完當前歌曲後繼續播放佇列';

      await interaction.reply({ embeds: [
        new EmbedBuilder()
          .setColor(next === 'off' ? 0xFF0000 : 0x00FF00)
          .setTitle(loopText)
          .setDescription(description)
          .addFields({ name: '正在播放', value: `[${playerData.title}](${playerData.url})`, inline: false })
          .setTimestamp()
      ]});
      await updateControlPanel(interaction.guildId, interaction.channel);
    }
  });

  // /queue
  client.commands.set('queue', {
    data: new SlashCommandBuilder().setName('queue').setDescription('查看播放佇列'),
    async execute(interaction) {
      const playerData = bilibiliPlayers.get(interaction.guildId);
      const queue      = bilibiliQueues.get(interaction.guildId) || [];
      const loopMode   = loopSettings.get(interaction.guildId) || 'off';

      if (!playerData && queue.length === 0) {
        return interaction.reply({ content: '❌ 目前沒有播放音頻且佇列為空', ephemeral: true });
      }

      let loopText = '❌ 關閉';
      if (loopMode === 'one') loopText = '🔂 單曲循環';
      if (loopMode === 'all') loopText = '🔁 列表循環';

      const embed = new EmbedBuilder().setColor(0x00A1D6).setTitle('🎵 播放佇列').setTimestamp();

      if (playerData) {
        embed.addFields({ name: '🎵 正在播放', value: `[${playerData.title}](${playerData.url})\n作者: ${playerData.author || '未知'}`, inline: false });
      }
      embed.addFields({ name: '循環模式', value: loopText, inline: true });

      if (queue.length > 0) {
        const queueList = queue.map((item, i) => `${i+1}. [${item.title}](${item.url})`).join('\n');
        embed.addFields({ name: `📋 佇列 (${queue.length} 首)`, value: queueList.length > 1024 ? queueList.slice(0, 1021) + '...' : queueList, inline: false });
      }

      await interaction.reply({ embeds: [embed] });
    }
  });

  // /clear
  client.commands.set('clear', {
    data: new SlashCommandBuilder().setName('clear').setDescription('清空播放佇列'),
    async execute(interaction) {
      const queue = bilibiliQueues.get(interaction.guildId);
      if (!queue || queue.length === 0) {
        return interaction.reply({ content: '❌ 佇列已經是空的', ephemeral: true });
      }
      bilibiliQueues.set(interaction.guildId, []);
      await interaction.reply({ content: `🗑️ 已清空佇列 (${queue.length} 首)` });
    }
  });

  // /biliinfo
  client.commands.set('playinfo', {
    data: new SlashCommandBuilder().setName('playinfo').setDescription('查看目前播放的詳細資訊'),
    async execute(interaction) {
      const playerData = bilibiliPlayers.get(interaction.guildId);
      if (!playerData) return interaction.reply({ content: '❌ 目前沒有播放音頻', ephemeral: true });

      const queue      = bilibiliQueues.get(interaction.guildId) || [];
      const errorCount = errorCounts.get(interaction.guildId) || 0;
      const loopMode   = loopSettings.get(interaction.guildId) || 'off';
      let loopText = '❌ 關閉';
      if (loopMode === 'one') loopText = '🔂 單曲循環';
      if (loopMode === 'all') loopText = '🔁 列表循環';

      await interaction.reply({ embeds: [
        new EmbedBuilder()
          .setColor(0x00A1D6).setTitle('📺 播放資訊')
          .setDescription(`[${playerData.title}](${playerData.url})`)
          .addFields(
            { name: '作者',     value: playerData.author   || '未知', inline: true },
            { name: '時長',     value: playerData.duration || '未知', inline: true },
            { name: '佇列',     value: `${queue.length} 首`,          inline: true },
            { name: '循環模式', value: loopText,                      inline: true },
            { name: '錯誤計數', value: `${errorCount}`,               inline: true }
          )
          .setThumbnail(playerData.thumbnail || null)
          .setTimestamp()
      ]});
    }
  });

  console.log('✅ Bilibili Slash Commands 已載入');
}

function getPlayingBilibili(guildId) { return bilibiliPlayers.has(guildId); }

module.exports = { setupBilibiliCommands, stopBilibiliAudio, getPlayingBilibili };