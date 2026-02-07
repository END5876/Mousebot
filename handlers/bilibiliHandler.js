// handlers/bilibiliHandler.js - 完整修復版本
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

const execAsync = promisify(exec);

// 存儲 Bilibili 播放器
const bilibiliPlayers = new Map();

// 檢測環境
const isHeroku = process.env.DYNO !== undefined;
const ytdlpPath = 'yt-dlp';

// Bilibili 需要的 headers
const BILIBILI_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com/'
};

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
        // 嘗試多個可能的路徑
        const paths = ['ffmpeg', '/app/vendor/ffmpeg/ffmpeg', '/usr/bin/ffmpeg'];
        
        for (const ffmpegPath of paths) {
            try {
                const { stdout } = await execAsync(`${ffmpegPath} -version`);
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
    // 啟動時檢查依賴
    Promise.all([checkYtDlp(), checkFFmpeg()]).then(([ytdlp, ffmpeg]) => {
        if (ytdlp && ffmpeg) {
            console.log('✅ Bilibili 功能已就緒');
        } else {
            console.warn('⚠️ Bilibili 功能可能無法正常運作');
        }
    });

    client.on('messageCreate', async message => {
        if (message.author.bot) return;

        const content = message.content;

        // !bili <URL>
        if (content.startsWith(`${PREFIX}bili `)) {
            const url = content.slice(`${PREFIX}bili `.length).trim();
            await handleBilibiliPlay(message, url);
            return;
        }

        // !stopbili
        if (content === `${PREFIX}stopbili`) {
            if (!bilibiliPlayers.has(message.guild.id)) {
                return message.reply('❌ 目前沒有播放音頻');
            }

            stopBilibiliAudio(message.guild.id);
            message.reply('⏹️ 已停止播放');
            return;
        }

        // !biliinfo
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

        // !sysinfo
        if (content === `${PREFIX}sysinfo`) {
            const ytdlpOk = await checkYtDlp();
            const ffmpegOk = await checkFFmpeg();
            
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('🔧 系統資訊')
                .addFields(
                    { name: '環境', value: isHeroku ? 'Heroku' : 'Local', inline: true },
                    { name: 'Node.js', value: process.version, inline: true },
                    { name: 'Platform', value: process.platform, inline: true },
                    { name: 'yt-dlp', value: ytdlpOk ? '✅ 已安裝' : '❌ 未安裝', inline: true },
                    { name: 'FFmpeg', value: ffmpegOk ? '✅ 已安裝' : '❌ 未安裝', inline: true }
                )
                .setTimestamp();

            message.reply({ embeds: [embed] });
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
        return message.reply('❌ 已經在播放音頻，請先使用 `!stopbili` 停止');
    }

    if (!isValidUrl(url)) {
        return message.reply('❌ 請提供有效的影片網址\n支援：Bilibili、YouTube、Twitter 等\n範例：`!bili https://www.bilibili.com/video/BVxxxxxxxxx`');
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

        const embed = new EmbedBuilder()
            .setColor(0x00A1D6)
            .setTitle('📺 開始播放')
            .setDescription(`[${videoInfo.title}](${url})`)
            .addFields(
                { name: '作者', value: videoInfo.author || '未知', inline: true },
                { name: '時長', value: videoInfo.duration || '未知', inline: true },
                { name: '狀態', value: '🔁 循環播放中', inline: true }
            )
            .setThumbnail(videoInfo.thumbnail || null)
            .setFooter({ text: `使用 ${PREFIX}stopbili 停止播放` })
            .setTimestamp();

        await loadingMsg.edit({ content: null, embeds: [embed] });

    } catch (error) {
        console.error('播放音頻時發生錯誤：', error);
        await loadingMsg.edit('❌ 播放失敗：' + error.message);
    }
}

async function playBilibiliLoop(guildId, connection, videoInfo) {
    const player = createAudioPlayer();
    
    const playLoop = async () => {
        try {
            console.log(`🔁 播放: ${videoInfo.title}`);
            
            // 構建 yt-dlp 參數
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

            // 如果是 Bilibili，添加必要的 headers
            if (videoInfo.url.includes('bilibili.com')) {
                ytdlpArgs.push('--add-header', `User-Agent:${BILIBILI_HEADERS['User-Agent']}`);
                ytdlpArgs.push('--add-header', `Referer:${BILIBILI_HEADERS['Referer']}`);
                ytdlpArgs.push('--no-check-certificate');
            }

            // Heroku 環境的額外參數
            if (isHeroku) {
                ytdlpArgs.push('--prefer-free-formats');
                ytdlpArgs.push('--socket-timeout', '30');
            }

            ytdlpArgs.push(videoInfo.url);

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
        const ytdlpArgs = [
            '--dump-json',
            '--no-playlist',
            '--no-warnings',
        ];

        // 如果是 Bilibili，添加 headers
        if (url.includes('bilibili.com')) {
            ytdlpArgs.push('--add-header', `User-Agent:${BILIBILI_HEADERS['User-Agent']}`);
            ytdlpArgs.push('--add-header', `Referer:${BILIBILI_HEADERS['Referer']}`);
            ytdlpArgs.push('--no-check-certificate');
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
                
                // 提供更友善的錯誤訊息
                if (errorData.includes('412')) {
                    reject(new Error('Bilibili 拒絕訪問，可能需要登入或使用代理'));
                } else if (errorData.includes('403')) {
                    reject(new Error('影片無法訪問，可能有地區限制'));
                } else {
                    reject(new Error('無法獲取影片資訊'));
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
