// handlers/bilibiliHandler.js - 新增按鈕控制與列表循環
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
  ComponentType 
} = require('discord.js');
const { PREFIX } = require('../config/settings');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

// 存儲播放器和佇列
const bilibiliPlayers = new Map();
const bilibiliQueues = new Map();
const errorCounts = new Map();
const activeProcesses = new Map();
const loopSettings = new Map(); // 'off' | 'one' | 'all'
const controlMessages = new Map(); // 存儲控制面板訊息

// 錯誤處理配置
const MAX_RETRIES = 3;
const RETRY_DELAY = 3000;
const MAX_CONSECUTIVE_ERRORS = 5;

// 檢測環境
const isHeroku = process.env.DYNO !== undefined;
const isWindows = process.platform === 'win32';
const ytdlpPath = 'yt-dlp';

// Cookies 配置
const COOKIES_PATH = path.join(__dirname, '..', 'cookies.txt');
const TEMP_COOKIES_PATH = '/tmp/bili_cookies.txt';

// Headers
const BILIBILI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com/',
  'Origin': 'https://www.bilibili.com',
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site'
};

function prepareBilibiliCookies() {
  if (fs.existsSync(COOKIES_PATH)) {
      console.log('✅ 找到 cookies.txt 文件');
      return COOKIES_PATH;
  }
  
  const sessdata = process.env.BILIBILI_SESSDATA;
  const biliJct = process.env.BILIBILI_BILI_JCT;
  const dedeUserId = process.env.BILIBILI_DEDEUSERID;
  
  if (sessdata) {
      console.log('✅ 從環境變數生成 Cookies');
      
      let cookiesContent = '# Netscape HTTP Cookie File\n';
      cookiesContent += `.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\t${sessdata}\n`;
      
      if (biliJct) {
          cookiesContent += `.bilibili.com\tTRUE\t/\tFALSE\t0\tbili_jct\t${biliJct}\n`;
      }
      if (dedeUserId) {
          cookiesContent += `.bilibili.com\tTRUE\t/\tFALSE\t0\tDedeUserID\t${dedeUserId}\n`;
      }
      
      try {
          fs.writeFileSync(TEMP_COOKIES_PATH, cookiesContent);
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

async function checkYtDlp() {
  try {
      const { stdout } = await execAsync(`${ytdlpPath} --version`);
      console.log(`✅ yt-dlp 版本: ${stdout.trim()}`);
      return true;
  } catch (error) {
      console.error('❌ yt-dlp 未安裝');
      return false;
  }
}

async function checkFFmpeg() {
  try {
      const paths = ['ffmpeg', '/app/vendor/ffmpeg/ffmpeg', '/usr/bin/ffmpeg'];
      
      for (const ffmpegPath of paths) {
          try {
              await execAsync(`${ffmpegPath} -version`);
              console.log(`✅ FFmpeg 已安裝: ${ffmpegPath}`);
              return true;
          } catch (e) {
              continue;
          }
      }
      
      console.error('❌ FFmpeg 未找到');
      return false;
  } catch (error) {
      console.error('❌ FFmpeg 檢測錯誤:', error);
      return false;
  }
}

// 🔥 創建控制按鈕
function createControlButtons(guildId) {
  const loopMode = loopSettings.get(guildId) || 'off';
  
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('skip')
        .setLabel('跳過')
        .setEmoji('⏭️')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('stop')
        .setLabel('停止')
        .setEmoji('⏹️')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('loop_one')
        .setLabel('單曲循環')
        .setEmoji('🔁')
        .setStyle(loopMode === 'one' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('loop_all')
        .setLabel('列表循環')
        .setEmoji('🔂')
        .setStyle(loopMode === 'all' ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('queue')
        .setLabel('佇列')
        .setEmoji('📋')
        .setStyle(ButtonStyle.Secondary)
    );
  
  return row;
}

// 🔥 更新控制面板
async function updateControlPanel(guildId, channel) {
  const playerData = bilibiliPlayers.get(guildId);
  if (!playerData) return;

  const loopMode = loopSettings.get(guildId) || 'off';
  const queue = bilibiliQueues.get(guildId) || [];
  
  let loopText = '❌ 關閉';
  if (loopMode === 'one') loopText = '🔁 單曲循環';
  if (loopMode === 'all') loopText = '🔂 列表循環';

  const embed = new EmbedBuilder()
    .setColor(0x00A1D6)
    .setTitle('🎵 正在播放')
    .setDescription(`[${playerData.title}](${playerData.url})`)
    .addFields(
      { name: '作者', value: playerData.author || '未知', inline: true },
      { name: '時長', value: playerData.duration || '未知', inline: true },
      { name: '循環模式', value: loopText, inline: true },
      { name: '佇列', value: `${queue.length} 首`, inline: true }
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
      } catch (err) {
        // 訊息可能被刪除，重新發送
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

function setupBilibiliCommands(client) {
  BILIBILI_COOKIES_FILE = prepareBilibiliCookies();
  
  Promise.all([checkYtDlp(), checkFFmpeg()]).then(([ytdlp, ffmpeg]) => {
      if (ytdlp && ffmpeg) {
          console.log('✅ Bilibili 功能已就緒');
          if (BILIBILI_COOKIES_FILE) {
              console.log('✅ Bilibili Cookies 已配置');
          } else {
              console.warn('⚠️ 未配置 Bilibili Cookies，可能無法播放');
          }
      } else {
          console.warn('⚠️ Bilibili 功能可能無法正常運作');
      }
  });

  // 🔥 按鈕互動處理
  client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const guildId = interaction.guild.id;
    const playerData = bilibiliPlayers.get(guildId);

    if (!playerData) {
      return interaction.reply({ content: '❌ 目前沒有播放音頻', ephemeral: true });
    }

    try {
      switch (interaction.customId) {
        case 'skip':
          const queue = bilibiliQueues.get(guildId) || [];
          
          if (queue.length === 0) {
            stopBilibiliAudio(guildId);
            await interaction.reply({ content: '⏭️ 已跳過，佇列為空，停止播放', ephemeral: true });
          } else {
            await interaction.reply({ content: '⏭️ 跳過當前歌曲', ephemeral: true });
            playerData.player.stop();
          }
          break;

        case 'stop':
          stopBilibiliAudio(guildId);
          await interaction.reply({ content: '⏹️ 已停止播放', ephemeral: true });
          break;

        case 'loop_one':
          const currentLoopOne = loopSettings.get(guildId);
          const newLoopOne = currentLoopOne === 'one' ? 'off' : 'one';
          loopSettings.set(guildId, newLoopOne);
          
          await interaction.reply({ 
            content: newLoopOne === 'one' ? '🔁 單曲循環已開啟' : '❌ 循環已關閉', 
            ephemeral: true 
          });
          
          await updateControlPanel(guildId, interaction.channel);
          break;

        case 'loop_all':
          const currentLoopAll = loopSettings.get(guildId);
          const newLoopAll = currentLoopAll === 'all' ? 'off' : 'all';
          loopSettings.set(guildId, newLoopAll);
          
          await interaction.reply({ 
            content: newLoopAll === 'all' ? '🔂 列表循環已開啟' : '❌ 循環已關閉', 
            ephemeral: true 
          });
          
          await updateControlPanel(guildId, interaction.channel);
          break;

        case 'queue':
          const queueList = bilibiliQueues.get(guildId) || [];
          const loopMode = loopSettings.get(guildId) || 'off';
          
          let loopText = '❌ 關閉';
          if (loopMode === 'one') loopText = '🔁 單曲循環';
          if (loopMode === 'all') loopText = '🔂 列表循環';

          const embed = new EmbedBuilder()
            .setColor(0x00A1D6)
            .setTitle('🎵 播放佇列')
            .addFields(
              { 
                name: '🎵 正在播放', 
                value: `[${playerData.title}](${playerData.url})\n作者: ${playerData.author || '未知'}`, 
                inline: false 
              },
              { name: '循環模式', value: loopText, inline: true },
              { name: '佇列數量', value: `${queueList.length} 首`, inline: true }
            )
            .setTimestamp();

          if (queueList.length > 0) {
            const queueText = queueList.map((item, index) => 
              `${index + 1}. [${item.title}](${item.url})`
            ).join('\n');
            
            embed.addFields({
              name: '📋 佇列',
              value: queueText.length > 1024 ? queueText.substring(0, 1021) + '...' : queueText,
              inline: false
            });
          }

          await interaction.reply({ embeds: [embed], ephemeral: true });
          break;
      }
    } catch (error) {
      console.error('按鈕互動錯誤:', error);
      await interaction.reply({ content: '❌ 操作失敗', ephemeral: true });
    }
  });

  client.on('messageCreate', async message => {
      if (message.author.bot) return;

      const content = message.content;

      if (content.startsWith(`${PREFIX}play `)) {
          const url = content.slice(`${PREFIX}play `.length).trim();
          await handleBilibiliPlay(message, url);
          return;
      }

      if (content === `${PREFIX}stop`) {
          if (!bilibiliPlayers.has(message.guild.id)) {
              return message.reply('❌ 目前沒有播放音頻');
          }

          stopBilibiliAudio(message.guild.id);
          message.reply('⏹️ 已停止播放');
          return;
      }

      if (content === `${PREFIX}skip`) {
          const playerData = bilibiliPlayers.get(message.guild.id);
          
          if (!playerData) {
              return message.reply('❌ 目前沒有播放音頻');
          }

          const queue = bilibiliQueues.get(message.guild.id);
          
          if (!queue || queue.length === 0) {
              stopBilibiliAudio(message.guild.id);
              return message.reply('⏭️ 已跳過，佇列為空，停止播放');
          }

          message.reply('⏭️ 跳過當前歌曲');
          playerData.player.stop();
          return;
      }

      // 🔥 循環指令改為切換模式
      if (content === `${PREFIX}loop`) {
          const playerData = bilibiliPlayers.get(message.guild.id);
          
          if (!playerData) {
              return message.reply('❌ 目前沒有播放音頻');
          }

          const currentLoop = loopSettings.get(message.guild.id) || 'off';
          let newLoop = 'off';
          
          if (currentLoop === 'off') newLoop = 'one';
          else if (currentLoop === 'one') newLoop = 'all';
          else newLoop = 'off';
          
          loopSettings.set(message.guild.id, newLoop);

          let loopText = '❌ 循環已關閉';
          let description = '播放完當前歌曲後將繼續播放佇列中的下一首';
          
          if (newLoop === 'one') {
            loopText = '🔁 單曲循環已開啟';
            description = '當前歌曲將會不斷重複播放';
          } else if (newLoop === 'all') {
            loopText = '🔂 列表循環已開啟';
            description = '播放完所有歌曲後將重新開始播放整個列表';
          }

          const embed = new EmbedBuilder()
              .setColor(newLoop === 'off' ? 0xFF0000 : 0x00FF00)
              .setTitle(loopText)
              .setDescription(description)
              .addFields(
                  { name: '正在播放', value: `[${playerData.title}](${playerData.url})`, inline: false }
              )
              .setFooter({ text: `使用 ${PREFIX}loop 切換模式` })
              .setTimestamp();

          message.reply({ embeds: [embed] });
          await updateControlPanel(message.guild.id, message.channel);
          return;
      }

      if (content === `${PREFIX}queue`) {
          const playerData = bilibiliPlayers.get(message.guild.id);
          const queue = bilibiliQueues.get(message.guild.id) || [];
          const loopMode = loopSettings.get(message.guild.id) || 'off';
          
          if (!playerData && queue.length === 0) {
              return message.reply('❌ 目前沒有播放音頻且佇列為空');
          }

          let loopText = '❌ 關閉';
          if (loopMode === 'one') loopText = '🔁 單曲循環';
          if (loopMode === 'all') loopText = '🔂 列表循環';

          const embed = new EmbedBuilder()
              .setColor(0x00A1D6)
              .setTitle('🎵 播放佇列')
              .setTimestamp();

          if (playerData) {
              embed.addFields({
                  name: `🎵 正在播放`,
                  value: `[${playerData.title}](${playerData.url})\n作者: ${playerData.author || '未知'}`,
                  inline: false
              });
          }

          embed.addFields({ name: '循環模式', value: loopText, inline: true });

          if (queue.length > 0) {
              const queueList = queue.map((item, index) => 
                  `${index + 1}. [${item.title}](${item.url})`
              ).join('\n');
              
              embed.addFields({
                  name: `📋 佇列 (${queue.length} 首)`,
                  value: queueList.length > 1024 ? queueList.substring(0, 1021) + '...' : queueList,
                  inline: false
              });
          }

          message.reply({ embeds: [embed] });
          return;
      }

      if (content === `${PREFIX}clear`) {
          const queue = bilibiliQueues.get(message.guild.id);
          
          if (!queue || queue.length === 0) {
              return message.reply('❌ 佇列已經是空的');
          }

          bilibiliQueues.set(message.guild.id, []);
          message.reply(`🗑️ 已清空佇列 (${queue.length} 首)`);
          return;
      }

      if (content === `${PREFIX}biliinfo`) {
          const playerData = bilibiliPlayers.get(message.guild.id);
          
          if (!playerData) {
              return message.reply('❌ 目前沒有播放音頻');
          }

          const queue = bilibiliQueues.get(message.guild.id) || [];
          const errorCount = errorCounts.get(message.guild.id) || 0;
          const loopMode = loopSettings.get(message.guild.id) || 'off';

          let loopText = '❌ 關閉';
          if (loopMode === 'one') loopText = '🔁 單曲循環';
          if (loopMode === 'all') loopText = '🔂 列表循環';

          const embed = new EmbedBuilder()
              .setColor(0x00A1D6)
              .setTitle('📺 播放資訊')
              .setDescription(`[${playerData.title}](${playerData.url})`)
              .addFields(
                  { name: '作者', value: playerData.author || '未知', inline: true },
                  { name: '時長', value: playerData.duration || '未知', inline: true },
                  { name: '佇列', value: `${queue.length} 首`, inline: true },
                  { name: '循環模式', value: loopText, inline: true },
                  { name: '錯誤計數', value: `${errorCount}`, inline: true }
              )
              .setThumbnail(playerData.thumbnail || null)
              .setTimestamp();

          message.reply({ embeds: [embed] });
          return;
      }

      if (content === `${PREFIX}sysinfo`) {
          const ytdlpOk = await checkYtDlp();
          const ffmpegOk = await checkFFmpeg();
          const hasCookies = BILIBILI_COOKIES_FILE !== null;
          
          const embed = new EmbedBuilder()
              .setColor(0x00FF00)
              .setTitle('🔧 系統資訊')
              .addFields(
                  { name: '環境', value: isHeroku ? 'Heroku' : 'Local', inline: true },
                  { name: 'Node.js', value: process.version, inline: true },
                  { name: 'Platform', value: process.platform, inline: true },
                  { name: 'yt-dlp', value: ytdlpOk ? '✅ 已安裝' : '❌ 未安裝', inline: true },
                  { name: 'FFmpeg', value: ffmpegOk ? '✅ 已安裝' : '❌ 未安裝', inline: true },
                  { name: 'Bilibili Cookies', value: hasCookies ? '✅ 已配置' : '❌ 未配置', inline: true }
              )
              .setTimestamp();

          message.reply({ embeds: [embed] });
          return;
      }

      if (content === `${PREFIX}testcookies`) {
          if (!BILIBILI_COOKIES_FILE) {
              return message.reply('❌ 未配置 Cookies');
          }

          const loadingMsg = await message.reply('⏳ 測試 Cookies...');

          try {
              const testUrl = 'https://www.bilibili.com/video/BV1xx411c7mD';
              const { stdout } = await execAsync(
                  `${ytdlpPath} --cookies "${BILIBILI_COOKIES_FILE}" --dump-json --skip-download "${testUrl}"`
              );
              
              const info = JSON.parse(stdout);
              await loadingMsg.edit(`✅ Cookies 有效！\n測試影片：${info.title}`);
          } catch (error) {
              await loadingMsg.edit(`❌ Cookies 無效或已過期\n錯誤：${error.message}`);
          }
          return;
      }
  });
}

async function handleBilibiliPlay(message, url) {
  const guildId = message.guild.id;

  if (!(await checkYtDlp())) {
      return message.reply('❌ 系統未正確安裝 yt-dlp，請聯繫管理員');
  }

  if (!isValidUrl(url)) {
      return message.reply('❌ 請提供有效的影片網址');
  }

  let connection = getVoiceConnection(guildId);

  if (!connection) {
      if (!message.member.voice.channel) {
          return message.reply('❌ 你必須先加入語音頻道！');
      }

      try {
          connection = joinVoiceChannel({
              channelId: message.member.voice.channel.id,
              guildId: guildId,
              adapterCreator: message.guild.voiceAdapterCreator,
              selfDeaf: false,
              selfMute: false,
          });

          await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      } catch (error) {
          console.error('加入語音頻道時發生錯誤：', error);
          return message.reply('❌ 加入語音頻道時發生錯誤');
      }
  }

  const loadingMsg = await message.reply('⏳ 正在載入影片資訊...');

  try {
      const videoInfo = await getVideoInfo(url);
      
      if (bilibiliPlayers.has(guildId)) {
          let queue = bilibiliQueues.get(guildId) || [];
          queue.push(videoInfo);
          bilibiliQueues.set(guildId, queue);

          const platform = getPlatformName(url);
          const embed = new EmbedBuilder()
              .setColor(0x00A1D6)
              .setTitle(`➕ 已加入佇列 (${platform})`)
              .setDescription(`[${videoInfo.title}](${url})`)
              .addFields(
                  { name: '作者', value: videoInfo.author || '未知', inline: true },
                  { name: '時長', value: videoInfo.duration || '未知', inline: true },
                  { name: '佇列位置', value: `第 ${queue.length} 首`, inline: true }
              )
              .setThumbnail(videoInfo.thumbnail || null)
              .setTimestamp();

          await loadingMsg.edit({ content: null, embeds: [embed] });
          await updateControlPanel(guildId, message.channel);
          return;
      }

      await playBilibiliAudio(guildId, connection, videoInfo, message.channel);

      const platform = getPlatformName(url);
      const embed = new EmbedBuilder()
          .setColor(platform === 'Bilibili' ? 0x00A1D6 : 0xFF0000)
          .setTitle(`📺 開始播放 (${platform})`)
          .setDescription(`[${videoInfo.title}](${url})`)
          .addFields(
              { name: '作者', value: videoInfo.author || '未知', inline: true },
              { name: '時長', value: videoInfo.duration || '未知', inline: true }
          )
          .setThumbnail(videoInfo.thumbnail || null)
          .setFooter({ text: '使用下方按鈕控制播放' })
          .setTimestamp();

      await loadingMsg.edit({ content: null, embeds: [embed] });
      await updateControlPanel(guildId, message.channel);

  } catch (error) {
      console.error('播放音頻時發生錯誤：', error);
      
      let errorMsg = '❌ 播放失敗：' + error.message;
      
      if (url.includes('bilibili.com')) {
          if (!BILIBILI_COOKIES_FILE) {
              errorMsg += '\n\n💡 **提示：未配置 Bilibili Cookies**\n';
              errorMsg += '請參考文檔配置 Cookies 以提高成功率';
          } else {
              errorMsg += '\n\n💡 **可能的原因：**\n';
              errorMsg += '• Cookies 已過期（請重新獲取）\n';
              errorMsg += '• 影片有地區限制\n';
              errorMsg += '• 影片需要大會員權限';
          }
      }
      
      await loadingMsg.edit(errorMsg);
  }
}

async function playBilibiliAudio(guildId, connection, videoInfo, channel, retryCount = 0) {
  const player = createAudioPlayer();
  
  const playNext = async () => {
      cleanupProcess(guildId);
      
      try {
          console.log(`🎵 播放: ${videoInfo.title} (重試: ${retryCount}/${MAX_RETRIES})`);
          
          const ytdlpArgs = [
              '-f', 'bestaudio/best',
              '-o', '-',
              '--no-playlist',
              '--quiet',
              '--no-warnings',
              '--extract-audio',
              '--audio-format', 'opus',
              '--audio-quality', '0',
              '--buffer-size', '16K',
          ];

          if (videoInfo.url.includes('bilibili.com')) {
              if (BILIBILI_COOKIES_FILE) {
                  ytdlpArgs.push('--cookies', BILIBILI_COOKIES_FILE);
              }
              
              ytdlpArgs.push(
                  '--user-agent', BILIBILI_HEADERS['User-Agent'],
                  '--referer', BILIBILI_HEADERS['Referer'],
                  '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
                  '--add-header', `Accept:${BILIBILI_HEADERS['Accept']}`,
                  '--no-check-certificate',
                  '--extractor-args', 'bilibili:getcomments=false',
                  '--extractor-args', 'bilibili:getdanmaku=false'
              );
              
              if (isHeroku) {
                  ytdlpArgs.push(
                      '--sleep-requests', '5',
                      '--sleep-interval', '5',
                      '--max-sleep-interval', '10'
                  );
              } else {
                  ytdlpArgs.push(
                      '--sleep-requests', '2',
                      '--sleep-interval', '2',
                      '--max-sleep-interval', '5'
                  );
              }
          } else if (videoInfo.url.includes('youtube.com') || videoInfo.url.includes('youtu.be')) {
              ytdlpArgs.push('--no-check-certificate');
          }

          if (isHeroku) {
              ytdlpArgs.push(
                  '--prefer-free-formats',
                  '--socket-timeout', '60',
                  '--retries', '10',
                  '--fragment-retries', '10'
              );
          }

          ytdlpArgs.push(videoInfo.url);

          console.log('🔧 yt-dlp 命令:', ytdlpPath, ytdlpArgs.join(' '));

          const ytdlp = spawn(ytdlpPath, ytdlpArgs, {
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true
          });

          activeProcesses.set(guildId, ytdlp);

          let hasError = false;
          let errorOutput = '';
          let dataReceived = false;

          ytdlp.stdout.on('data', (chunk) => {
              dataReceived = true;
          });

          ytdlp.stderr.on('data', (data) => {
              const error = data.toString();
              if (!error.includes('Deleting original file')) {
                  console.error('yt-dlp 錯誤:', error);
                  errorOutput += error;
                  
                  if (!error.includes('unable to write data') && 
                      !error.includes('Broken pipe') &&
                      !error.includes('Invalid argument')) {
                      hasError = true;
                  }
              }
          });

          ytdlp.on('error', (error) => {
              console.error('yt-dlp 進程錯誤:', error);
              hasError = true;
              errorOutput = error.message;
          });

          ytdlp.on('close', (code, signal) => {
              console.log(`yt-dlp 進程結束 (code: ${code}, signal: ${signal}, 數據已接收: ${dataReceived})`);
              
              if (code !== 0 && !dataReceived && hasError) {
                  console.error(`❌ yt-dlp 異常退出 (code: ${code})`);
                  handlePlaybackError(guildId, connection, videoInfo, channel, retryCount, errorOutput);
              }
          });

          const resource = createAudioResource(ytdlp.stdout, {
              inputType: StreamType.Arbitrary,
              inlineVolume: true
          });

          resource.volume.setVolume(0.5);
          
          resource.playStream.on('error', (error) => {
              console.error('音頻流錯誤:', error);
          });

          player.play(resource);

          errorCounts.set(guildId, 0);

      } catch (error) {
          console.error('播放錯誤：', error);
          handlePlaybackError(guildId, connection, videoInfo, channel, retryCount, error.message);
      }
  };

  player.on(AudioPlayerStatus.Idle, async () => {
      console.log('播放器進入 Idle 狀態');
      
      if (bilibiliPlayers.has(guildId)) {
          const loopMode = loopSettings.get(guildId) || 'off';
          
          // 🔥 單曲循環
          if (loopMode === 'one') {
              console.log(`🔁 單曲循環: ${videoInfo.title}`);
              
              try {
                  const embed = new EmbedBuilder()
                      .setColor(0x00A1D6)
                      .setTitle('🔁 單曲循環')
                      .setDescription(`[${videoInfo.title}](${videoInfo.url})`)
                      .setThumbnail(videoInfo.thumbnail || null)
                      .setFooter({ text: `使用 ${PREFIX}loop 切換模式` });
                  
                  channel.send({ embeds: [embed] });
              } catch (err) {
                  console.error('發送通知失敗:', err);
              }
              
              await playBilibiliAudio(guildId, connection, videoInfo, channel, 0);
              return;
          }
          
          const queue = bilibiliQueues.get(guildId) || [];
          
          if (queue.length > 0) {
              const nextVideo = queue.shift();
              bilibiliQueues.set(guildId, queue);
              console.log(`⏭️ 播放下一首: ${nextVideo.title}`);
              
              try {
                  const embed = new EmbedBuilder()
                      .setColor(0x00A1D6)
                      .setTitle('⏭️ 正在播放下一首')
                      .setDescription(`[${nextVideo.title}](${nextVideo.url})`)
                      .addFields(
                          { name: '作者', value: nextVideo.author || '未知', inline: true },
                          { name: '剩餘佇列', value: `${queue.length} 首`, inline: true }
                      )
                      .setThumbnail(nextVideo.thumbnail || null);
                  
                  channel.send({ embeds: [embed] });
              } catch (err) {
                  console.error('發送通知失敗:', err);
              }
              
              bilibiliPlayers.set(guildId, {
                  player: player,
                  url: nextVideo.url,
                  title: nextVideo.title,
                  author: nextVideo.author,
                  duration: nextVideo.duration,
                  thumbnail: nextVideo.thumbnail
              });
              
              await playBilibiliAudio(guildId, connection, nextVideo, channel, 0);
              await updateControlPanel(guildId, channel);
          } else {
              // 🔥 列表循環：重新加載整個列表
              if (loopMode === 'all') {
                  console.log('🔂 列表循環：重新開始播放列表');
                  
                  // 這裡需要保存原始播放列表，暫時不實作完整功能
                  // 可以考慮使用另一個 Map 儲存原始列表
                  
                  try {
                      channel.send('🔂 列表循環功能需要保存原始播放列表，請重新添加歌曲');
                  } catch (err) {
                      console.error('發送通知失敗:', err);
                  }
              }
              
              console.log('✅ 播放完畢，佇列為空');
              stopBilibiliAudio(guildId);
              
              try {
                  channel.send('✅ 所有歌曲播放完畢');
              } catch (err) {
                  console.error('發送通知失敗:', err);
              }
          }
      }
  });

  player.on('error', (error) => {
      console.error('❌ 播放器錯誤：', error);
      
      if (error.message && 
          (error.message.includes('aborted') || 
           error.message.includes('premature close'))) {
          console.log('⚠️ 管道正常關閉，忽略錯誤');
          return;
      }
      
      handlePlaybackError(guildId, connection, videoInfo, channel, retryCount, error.message);
  });

  bilibiliPlayers.set(guildId, {
      player: player,
      url: videoInfo.url,
      title: videoInfo.title,
      author: videoInfo.author,
      duration: videoInfo.duration,
      thumbnail: videoInfo.thumbnail
  });

  await playNext();
  connection.subscribe(player);
}

function cleanupProcess(guildId) {
  const oldProcess = activeProcesses.get(guildId);
  if (oldProcess && !oldProcess.killed) {
      console.log('🧹 清理舊的 yt-dlp 進程');
      try {
          oldProcess.kill('SIGTERM');
          
          setTimeout(() => {
              if (!oldProcess.killed) {
                  oldProcess.kill('SIGKILL');
              }
          }, 1000);
      } catch (error) {
          console.error('清理進程失敗:', error);
      }
      activeProcesses.delete(guildId);
  }
}

async function handlePlaybackError(guildId, connection, videoInfo, channel, retryCount, errorMessage) {
  const currentErrors = (errorCounts.get(guildId) || 0) + 1;
  errorCounts.set(guildId, currentErrors);

  console.error(`❌ 播放錯誤 (${currentErrors}/${MAX_CONSECUTIVE_ERRORS}):`, errorMessage);

  if (currentErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.error(`❌ 連續錯誤次數過多，停止播放`);
      
      try {
          const embed = new EmbedBuilder()
              .setColor(0xFF0000)
              .setTitle('❌ 播放失敗')
              .setDescription('連續發生多次錯誤，已停止播放')
              .addFields(
                  { name: '錯誤次數', value: `${currentErrors}`, inline: true },
                  { name: '最後錯誤', value: errorMessage.substring(0, 100), inline: false }
              )
              .setFooter({ text: '請檢查網路連線或 Cookies 配置' });
          
          channel.send({ embeds: [embed] });
      } catch (err) {
          console.error('發送錯誤通知失敗:', err);
      }
      
      stopBilibiliAudio(guildId);
      return;
  }

  if (retryCount < MAX_RETRIES) {
      console.log(`⏳ ${RETRY_DELAY/1000} 秒後重試 (${retryCount + 1}/${MAX_RETRIES})...`);
      
      setTimeout(async () => {
          if (bilibiliPlayers.has(guildId)) {
              await playBilibiliAudio(guildId, connection, videoInfo, channel, retryCount + 1);
          }
      }, RETRY_DELAY);
  } else {
      console.error(`❌ 重試次數已用盡，跳過此歌曲`);
      
      try {
          channel.send(`⚠️ 播放失敗，跳過：**${videoInfo.title}**`);
      } catch (err) {
          console.error('發送通知失敗:', err);
      }
      
      const queue = bilibiliQueues.get(guildId) || [];
      if (queue.length > 0 && bilibiliPlayers.has(guildId)) {
          const nextVideo = queue.shift();
          bilibiliQueues.set(guildId, queue);
          
          setTimeout(async () => {
              await playBilibiliAudio(guildId, connection, nextVideo, channel, 0);
          }, 2000);
      } else {
          stopBilibiliAudio(guildId);
          try {
              channel.send('❌ 播放失敗且佇列為空，已停止播放');
          } catch (err) {
              console.error('發送通知失敗:', err);
          }
      }
  }
}

async function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
      const ytdlpArgs = [
          '--dump-json',
          '--no-playlist',
          '--no-warnings',
          '--skip-download',
      ];

      if (url.includes('bilibili.com')) {
          if (BILIBILI_COOKIES_FILE) {
              ytdlpArgs.push('--cookies', BILIBILI_COOKIES_FILE);
          }
          
          ytdlpArgs.push(
              '--user-agent', BILIBILI_HEADERS['User-Agent'],
              '--referer', BILIBILI_HEADERS['Referer'],
              '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
              '--no-check-certificate',
              '--extractor-args', 'bilibili:getcomments=false',
              '--extractor-args', 'bilibili:getdanmaku=false'
          );
          
          if (isHeroku) {
              ytdlpArgs.push(
                  '--sleep-requests', '5',
                  '--sleep-interval', '5',
                  '--max-sleep-interval', '10',
                  '--socket-timeout', '60',
                  '--retries', '10'
              );
          } else {
              ytdlpArgs.push(
                  '--sleep-requests', '2',
                  '--sleep-interval', '2',
                  '--max-sleep-interval', '5'
              );
          }
      }

      ytdlpArgs.push(url);

      const ytdlp = spawn(ytdlpPath, ytdlpArgs);

      let data = '';
      let errorData = '';

      ytdlp.stdout.on('data', (chunk) => {
          data += chunk.toString();
      });

      ytdlp.stderr.on('data', (chunk) => {
          errorData += chunk.toString();
      });

      ytdlp.on('close', (code) => {
          if (code !== 0) {
              console.error('yt-dlp 錯誤輸出:', errorData);
              
              if (errorData.includes('412')) {
                  reject(new Error(
                      '❌ Bilibili 反爬蟲限制 (Error 412)\n\n' +
                      '**可能的原因：**\n' +
                      (BILIBILI_COOKIES_FILE ? 
                          '• Cookies 已過期，請重新獲取\n• 帳號被限制\n• 請等待 5-10 分鐘後重試' :
                          '• 未配置 Cookies\n• 請參考文檔配置 Bilibili Cookies'
                      )
                  ));
              } else if (errorData.includes('403')) {
                  reject(new Error('❌ 影片無法訪問 (403)，可能有地區限制或需要大會員'));
              } else if (errorData.includes('404')) {
                  reject(new Error('❌ 找不到影片 (404)'));
              } else {
                  reject(new Error(`❌ 無法獲取影片資訊\n錯誤代碼: ${code}`));
              }
              return;
          }

          try {
              const lines = data.trim().split('\n');
              const lastLine = lines[lines.length - 1];
              const info = JSON.parse(lastLine);
              
              resolve({
                  url: url,
                  title: info.title || '未知標題',
                  author: info.uploader || info.channel || info.creator || '未知作者',
                  duration: formatDuration(info.duration),
                  thumbnail: info.thumbnail || null
              });
          } catch (error) {
              console.error('解析 JSON 錯誤:', error);
              reject(new Error('解析影片資訊失敗'));
          }
      });

      ytdlp.on('error', (error) => {
          reject(new Error('執行 yt-dlp 失敗: ' + error.message));
      });
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
      controlMessages.delete(guildId); // 🔥 清除控制面板
      
      cleanupProcess(guildId);
      
      console.log(`⏹️ 停止播放 (Guild: ${guildId})`);
  }
}

function isValidUrl(url) {
  try {
      new URL(url);
      return true;
  } catch {
      return false;
  }
}

function getPlatformName(url) {
  if (url.includes('bilibili.com')) return 'Bilibili';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'YouTube';
  if (url.includes('soundcloud.com')) return 'SoundCloud';
  if (url.includes('twitter.com') || url.includes('x.com')) return 'Twitter/X';
  if (url.includes('twitch.tv')) return 'Twitch';
  return '未知平台';
}

function formatDuration(seconds) {
  if (!seconds) return '未知';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function getPlayingBilibili(guildId) {
  return bilibiliPlayers.has(guildId);
}

module.exports = {
  setupBilibiliCommands,
  stopBilibiliAudio,
  getPlayingBilibili
};