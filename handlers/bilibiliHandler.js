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
const { EmbedBuilder } = require('discord.js');
const { PREFIX } = require('../config/settings');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');

const execAsync = promisify(exec);

// 存儲 Bilibili 播放器
const bilibiliPlayers = new Map();

// 檢查 yt-dlp 是否可用
let ytdlpPath = 'yt-dlp';

async function checkYtDlp() {
    try {
        // 先檢查專案目錄
        const localPath = path.join(__dirname, '..', 'yt-dlp.exe');
        if (fs.existsSync(localPath)) {
            ytdlpPath = localPath;
            console.log('✅ 找到本地 yt-dlp:', localPath);
            return true;
        }

        // 檢查系統 PATH
        await execAsync('yt-dlp --version');
        console.log('✅ yt-dlp 已安裝在系統中');
        return true;
    } catch (error) {
        console.error('❌ 找不到 yt-dlp，請先安裝：https://github.com/yt-dlp/yt-dlp/releases');
        return false;
    }
}

function setupBilibiliCommands(client) {
    // 啟動時檢查 yt-dlp
    checkYtDlp();

    client.on('messageCreate', async message => {
        if (message.author.bot) return;

        const content = message.content;

        // !bili <URL> - 播放 Bilibili/YouTube 影片音頻
        if (content.startsWith(`${PREFIX}bili `)) {
            const url = content.slice(`${PREFIX}bili `.length).trim();
            await handleBilibiliPlay(message, url);
            return;
        }

        // !stopbili - 停止播放
        if (content === `${PREFIX}stopbili`) {
            if (!bilibiliPlayers.has(message.guild.id)) {
                return message.reply('❌ 目前沒有播放音頻');
            }

            stopBilibiliAudio(message.guild.id);
            message.reply('⏹️ 已停止播放');
            return;
        }

        // !biliinfo - 顯示當前播放資訊
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
    });
}

async function handleBilibiliPlay(message, url) {
    const guildId = message.guild.id;

    // 檢查 yt-dlp
    if (!(await checkYtDlp())) {
        return message.reply('❌ 系統未安裝 yt-dlp\n請下載：https://github.com/yt-dlp/yt-dlp/releases\n並放到專案資料夾或安裝到系統');
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
            
            // 使用 yt-dlp 獲取音頻串流
            const ytdlp = spawn(ytdlpPath, [
                '-f', 'bestaudio/best',  // 獲取最佳音質
                '-o', '-',               // 輸出到 stdout
                '--no-playlist',         // 不下載播放列表
                '--quiet',               // 安靜模式
                '--no-warnings',         // 不顯示警告
                '--extract-audio',       // 只提取音頻
                '--audio-format', 'opus', // 使用 opus 格式（Discord 最佳）
                videoInfo.url
            ]);

            // 錯誤處理
            ytdlp.stderr.on('data', (data) => {
                console.error('yt-dlp 錯誤:', data.toString());
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
            
            // 發生錯誤時等待 3 秒後重試
            if (bilibiliPlayers.has(guildId)) {
                setTimeout(() => {
                    if (bilibiliPlayers.has(guildId)) {
                        playLoop();
                    }
                }, 3000);
            }
        }
    };

    // 播放結束時重新播放
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
        
        // 發生錯誤時嘗試重新播放
        if (bilibiliPlayers.has(guildId)) {
            setTimeout(() => {
                if (bilibiliPlayers.has(guildId)) {
                    playLoop();
                }
            }, 3000);
        }
    });

    // 儲存播放器資訊
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
        const ytdlp = spawn(ytdlpPath, [
            '--dump-json',
            '--no-playlist',
            '--no-warnings',
            url
        ]);

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
                reject(new Error('無法獲取影片資訊'));
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
