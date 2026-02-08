// handlers/bilibiliHandler.js - 完整版（支援 Cookies）
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
const { EmbedBuilder } = require('discord.js');
const { PREFIX } = require('../config/settings');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

// 存儲播放器
const bilibiliPlayers = new Map();

// 檢測環境
const isHeroku = process.env.DYNO !== undefined;
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

// 🔥 檢查並準備 Cookies
function prepareBilibiliCookies() {
    // 方法 1：檢查 cookies.txt 文件
    if (fs.existsSync(COOKIES_PATH)) {
        console.log('✅ 找到 cookies.txt 文件');
        return COOKIES_PATH;
    }
    
    // 方法 2：從環境變數生成 cookies
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
        
        // 寫入臨時文件
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

// 全局 Cookies 路徑
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

function setupBilibiliCommands(client) {
    // 🔥 初始化時準備 Cookies
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

    client.on('messageCreate', async message => {
        if (message.author.bot) return;

        const content = message.content;

        if (content.startsWith(`${PREFIX}bili `)) {
            const url = content.slice(`${PREFIX}bili `.length).trim();
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

        if (content === `${PREFIX}biliinfo`) {
            const playerData = bilibiliPlayers.get(message.guild.id);
            
            if (!playerData) {
                return message.reply('❌ 目前沒有播放音頻');
            }

            const embed = new EmbedBuilder()
                .setColor(0x00A1D6)
                .setTitle('📺 播放資訊')
                .setDescription(`[${playerData.title}](${playerData.url})`)
                .addFields(
                    { name: '作者', value: playerData.author || '未知', inline: true },
                    { name: '時長', value: playerData.duration || '未知', inline: true },
                    { name: '狀態', value: '🔁 循環播放中', inline: true }
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

        // 🔥 新增：測試 Cookies 命令
        if (content === `${PREFIX}testcookies`) {
            if (!BILIBILI_COOKIES_FILE) {
                return message.reply('❌ 未配置 Cookies');
            }

            const loadingMsg = await message.reply('⏳ 測試 Cookies...');

            try {
                const testUrl = 'https://www.bilibili.com/video/BV1xx411c7mD'; // 測試影片
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

    if (bilibiliPlayers.has(guildId)) {
        return message.reply('❌ 已經在播放音頻，請先使用 `!stop` 停止');
    }

    if (!isValidUrl(url)) {
        return message.reply('❌ 請提供有效的影片網址\n✅ 支援：YouTube、Bilibili、Twitter、SoundCloud 等\n範例：`!bili https://www.bilibili.com/video/BVxxxxx`');
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
        
        await playBilibiliLoop(guildId, connection, videoInfo);

        const platform = getPlatformName(url);
        const embed = new EmbedBuilder()
            .setColor(platform === 'Bilibili' ? 0x00A1D6 : 0xFF0000)
            .setTitle(`📺 開始播放 (${platform})`)
            .setDescription(`[${videoInfo.title}](${url})`)
            .addFields(
                { name: '作者', value: videoInfo.author || '未知', inline: true },
                { name: '時長', value: videoInfo.duration || '未知', inline: true },
                { name: '狀態', value: '🔁 循環播放中', inline: true }
            )
            .setThumbnail(videoInfo.thumbnail || null)
            .setFooter({ text: `使用 ${PREFIX}stop 停止播放` })
            .setTimestamp();

        await loadingMsg.edit({ content: null, embeds: [embed] });

    } catch (error) {
        console.error('播放音頻時發生錯誤：', error);
        
        let errorMsg = '❌ 播放失敗：' + error.message;
        
        // 針對 Bilibili 提供額外說明
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

async function playBilibiliLoop(guildId, connection, videoInfo) {
    const player = createAudioPlayer();
    
    const playLoop = async () => {
        try {
            console.log(`🔁 播放: ${videoInfo.title}`);
            
            // 🔥 構建 yt-dlp 參數
            const ytdlpArgs = [
                '-f', 'bestaudio/best',
                '-o', '-',
                '--no-playlist',
                '--quiet',
                '--no-warnings',
                '--extract-audio',
                '--audio-format', 'opus',
                '--audio-quality', '0',
            ];

            // 🔥 針對 Bilibili 的特殊處理
            if (videoInfo.url.includes('bilibili.com')) {
                // 使用 Cookies（最重要！）
                if (BILIBILI_COOKIES_FILE) {
                    ytdlpArgs.push('--cookies', BILIBILI_COOKIES_FILE);
                    console.log('✅ 使用 Cookies:', BILIBILI_COOKIES_FILE);
                }
                
                // 添加 Headers
                ytdlpArgs.push(
                    '--user-agent', BILIBILI_HEADERS['User-Agent'],
                    '--referer', BILIBILI_HEADERS['Referer'],
                    '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
                    '--add-header', `Accept:${BILIBILI_HEADERS['Accept']}`,
                    '--no-check-certificate',
                    '--extractor-args', 'bilibili:getcomments=false',
                    '--extractor-args', 'bilibili:getdanmaku=false'
                );
                
                // 雲端環境需要更長的延遲
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

            const ytdlp = spawn(ytdlpPath, ytdlpArgs);

            ytdlp.stderr.on('data', (data) => {
                const error = data.toString();
                if (!error.includes('Deleting original file')) {
                    console.error('yt-dlp 錯誤:', error);
                }
            });

            ytdlp.on('error', (error) => {
                console.error('yt-dlp 進程錯誤:', error);
            });

            const resource = createAudioResource(ytdlp.stdout, {
                inputType: StreamType.Arbitrary,
                inlineVolume: true
            });

            resource.volume.setVolume(0.5);
            player.play(resource);

        } catch (error) {
            console.error('播放循環錯誤：', error);
            
            if (bilibiliPlayers.has(guildId)) {
                setTimeout(() => {
                    if (bilibiliPlayers.has(guildId)) {
                        playLoop();
                    }
                }, 3000);
            }
        }
    };

    player.on(AudioPlayerStatus.Idle, () => {
        if (bilibiliPlayers.has(guildId)) {
            console.log(`🔁 重新播放: ${videoInfo.title}`);
            setTimeout(() => {
                if (bilibiliPlayers.has(guildId)) {
                    playLoop();
                }
            }, 1000);
        }
    });

    player.on('error', (error) => {
        console.error('❌ 播放器錯誤：', error);
        
        if (bilibiliPlayers.has(guildId)) {
            setTimeout(() => {
                if (bilibiliPlayers.has(guildId)) {
                    playLoop();
                }
            }, 3000);
        }
    });

    bilibiliPlayers.set(guildId, {
        player: player,
        url: videoInfo.url,
        title: videoInfo.title,
        author: videoInfo.author,
        duration: videoInfo.duration,
        thumbnail: videoInfo.thumbnail
    });

    await playLoop();
    connection.subscribe(player);
}

async function getVideoInfo(url) {
    return new Promise((resolve, reject) => {
        // 🔥 構建 yt-dlp 參數
        const ytdlpArgs = [
            '--dump-json',
            '--no-playlist',
            '--no-warnings',
            '--skip-download',
        ];

        // 🔥 針對 Bilibili 的特殊處理
        if (url.includes('bilibili.com')) {
            // 使用 Cookies（最重要！）
            if (BILIBILI_COOKIES_FILE) {
                ytdlpArgs.push('--cookies', BILIBILI_COOKIES_FILE);
                console.log('✅ 獲取資訊時使用 Cookies');
            }
            
            // 添加 Headers
            ytdlpArgs.push(
                '--user-agent', BILIBILI_HEADERS['User-Agent'],
                '--referer', BILIBILI_HEADERS['Referer'],
                '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
                '--no-check-certificate',
                '--extractor-args', 'bilibili:getcomments=false',
                '--extractor-args', 'bilibili:getdanmaku=false'
            );
            
            // 雲端環境需要更長的延遲
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

        console.log('🔧 獲取資訊命令:', ytdlpPath, ytdlpArgs.join(' '));

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
                console.error('原始數據:', data);
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
