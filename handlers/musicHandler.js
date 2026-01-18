const {
    joinVoiceChannel,
    getVoiceConnection,
    VoiceConnectionStatus,
    entersState,
    createAudioResource,
    AudioPlayerStatus
} = require('@discordjs/voice');
const { EmbedBuilder } = require('discord.js');
const play = require('play-dl');
const { MusicQueue, formatDuration } = require('../utils/musicQueue');
const { PREFIX } = require('../config/settings');

// 音樂播放器管理
const musicQueues = new Map();

// 獲取或創建伺服器的音樂佇列
function getQueue(guildId) {
    if (!musicQueues.has(guildId)) {
        musicQueues.set(guildId, new MusicQueue());
    }
    return musicQueues.get(guildId);
}

// 播放下一首歌
async function playNext(guildId, textChannel) {
    const queue = getQueue(guildId);
    
    if (queue.isEmpty()) {
        queue.isPlaying = false;
        queue.currentSong = null;
        textChannel.send('🎵 播放佇列已清空');
        return;
    }

    queue.currentSong = queue.getNextSong();
    queue.isPlaying = true;

    try {
        console.log(`🎵 開始播放: ${queue.currentSong.title}`);
        console.log(`🔗 URL: ${queue.currentSong.url}`);
        
        // 確保 URL 有效
        if (!queue.currentSong.url) {
            throw new Error('無效的影片 URL');
        }
        
        // 使用 play-dl 獲取串流，直接使用 URL
        try {
            // 先檢查 URL 格式
            new URL(queue.currentSong.url);
            
            // 獲取音頻串流
            const { stream, type } = await play.stream(queue.currentSong.url, { 
                discordPlayerCompatibility: true,
                quality: 2 // 高品質音頻
            });
            
            if (!stream) {
                throw new Error('無法獲取音頻串流');
            }
            
            const resource = createAudioResource(stream, {
                inputType: type,
                inlineVolume: true
            });
            
            resource.volume.setVolume(0.5); // 設置音量為 50%
            
            queue.player.play(resource);
            
            const connection = getVoiceConnection(guildId);
            if (connection) {
                connection.subscribe(queue.player);
            }
            
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('🎵 正在播放')
                .setDescription(`[${queue.currentSong.title}](${queue.currentSong.url})`)
                .addFields(
                    { name: '時長', value: queue.currentSong.duration, inline: true },
                    { name: '點播者', value: `<@${queue.currentSong.requestedBy}>`, inline: true }
                )
                .setThumbnail(queue.currentSong.thumbnail)
                .setTimestamp();
            
            textChannel.send({ embeds: [embed] });
            console.log('✅ 播放成功');
        } catch (streamError) {
            console.error('獲取串流錯誤：', streamError);
            
            // 如果直接獲取串流失敗，嘗試使用備用方法
            console.log('🔄 嘗試使用備用方法獲取串流...');
            
            // 獲取影片資訊
            const info = await play.video_basic_info(queue.currentSong.url);
            const stream = await play.stream_from_info(info);
            
            const resource = createAudioResource(stream.stream, {
                inputType: stream.type,
                inlineVolume: true
            });
            
            resource.volume.setVolume(0.5); // 設置音量為 50%
            
            queue.player.play(resource);
            
            const connection = getVoiceConnection(guildId);
            if (connection) {
                connection.subscribe(queue.player);
            }
            
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('🎵 正在播放')
                .setDescription(`[${queue.currentSong.title}](${queue.currentSong.url})`)
                .addFields(
                    { name: '時長', value: queue.currentSong.duration, inline: true },
                    { name: '點播者', value: `<@${queue.currentSong.requestedBy}>`, inline: true }
                )
                .setThumbnail(queue.currentSong.thumbnail)
                .setTimestamp();
            
            textChannel.send({ embeds: [embed] });
            console.log('✅ 播放成功 (使用備用方法)');
        }

    } catch (error) {
        console.error('播放錯誤：', error);
        textChannel.send(`❌ 播放時發生錯誤：${error.message}\n跳過此歌曲`);
        
        // 等待一下再播放下一首
        setTimeout(() => {
            playNext(guildId, textChannel);
        }, 1000);
    }
}

// 音樂指令處理
function setupMusicCommands(client) {
    client.on('messageCreate', async message => {
        if (message.author.bot) return;
        if (!message.content.startsWith(PREFIX)) return;

        const args = message.content.slice(PREFIX.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        // !play <YouTube網址或搜尋關鍵字>
        if (command === 'play') {
            if (!message.member.voice.channel) {
                return message.reply('❌ 你必須先加入語音頻道！');
            }

            if (!args[0]) {
                return message.reply('❌ 請提供 YouTube 網址或搜尋關鍵字！\n使用方式：`!play <YouTube網址或關鍵字>`');
            }

            const input = args.join(' ');

            try {
                // 發送載入訊息
                const loadingMsg = await message.reply('⏳ 正在搜尋影片...');

                let videoUrl;
                let videoInfo;
                
                // 檢查是否為 YouTube 網址
                const validateResult = play.yt_validate(input);
                
                if (validateResult === 'video') {
                    // 直接是影片網址
                    videoUrl = input;
                    console.log('✅ 驗證通過，這是影片網址');
                } else if (validateResult === 'playlist') {
                    // 如果是播放清單，取第一個影片
                    console.log('📋 這是播放清單，取第一個影片');
                    const playlist = await play.playlist_info(input, { incomplete: true });
                    const videos = await playlist.all_videos();
                    if (videos.length > 0) {
                        videoUrl = videos[0].url;
                    } else {
                        loadingMsg.delete().catch(() => {});
                        return message.reply('❌ 播放清單是空的');
                    }
                } else {
                    // 搜尋影片
                    console.log('🔍 搜尋影片中...');
                    const searchResults = await play.search(input, {
                        limit: 1,
                        source: { youtube: "video" }
                    });
                    
                    if (!searchResults || searchResults.length === 0) {
                        loadingMsg.delete().catch(() => {});
                        return message.reply('❌ 找不到相關影片');
                    }
                    
                    videoUrl = searchResults[0].url;
                    console.log(`✅ 找到影片: ${searchResults[0].title}`);
                }

                // 獲取影片資訊
                videoInfo = await play.video_info(videoUrl);
                const video = videoInfo.video_details;
                
                // 確保所有必要資料都存在
                if (!video || !video.url) {
                    loadingMsg.delete().catch(() => {});
                    return message.reply('❌ 無法獲取影片資訊');
                }

                const song = {
                    title: video.title || '未知標題',
                    url: video.url,
                    duration: formatDuration(video.durationInSec || 0),
                    thumbnail: video.thumbnails && video.thumbnails.length > 0 
                        ? video.thumbnails[0].url 
                        : 'https://via.placeholder.com/120',
                    requestedBy: message.author.id
                };

                console.log('✅ 歌曲資訊:', song);

                // 刪除載入訊息
                loadingMsg.delete().catch(() => {});

                const queue = getQueue(message.guild.id);
                queue.addSong(song);

                let connection = getVoiceConnection(message.guild.id);
                if (!connection) {
                    connection = joinVoiceChannel({
                        channelId: message.member.voice.channel.id,
                        guildId: message.guild.id,
                        adapterCreator: message.guild.voiceAdapterCreator,
                    });

                    connection.on(VoiceConnectionStatus.Ready, () => {
                        console.log('✅ 語音連接已就緒');
                    });

                    connection.on(VoiceConnectionStatus.Disconnected, async () => {
                        try {
                            await Promise.race([
                                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                            ]);
                        } catch (error) {
                            connection.destroy();
                            const queue = getQueue(message.guild.id);
                            queue.clear();
                        }
                    });

                    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
                }

                // 設定播放器事件（只設定一次）
                if (queue.player.listenerCount(AudioPlayerStatus.Idle) === 0) {
                    queue.player.on(AudioPlayerStatus.Idle, () => {
                        console.log('⏭️ 歌曲播放完畢，播放下一首');
                        playNext(message.guild.id, message.channel);
                    });
                }

                if (queue.player.listenerCount('error') === 0) {
                    queue.player.on('error', error => {
                        console.error('播放器錯誤：', error);
                        message.channel.send('❌ 播放時發生錯誤');
                        playNext(message.guild.id, message.channel);
                    });
                }

                if (!queue.isPlaying) {
                    playNext(message.guild.id, message.channel);
                } else {
                    const embed = new EmbedBuilder()
                        .setColor(0x0099FF)
                        .setTitle('➕ 已加入播放佇列')
                        .setDescription(`[${song.title}](${song.url})`)
                        .addFields(
                            { name: '時長', value: song.duration, inline: true },
                            { name: '佇列位置', value: `${queue.getQueueLength()}`, inline: true }
                        )
                        .setThumbnail(song.thumbnail);

                    message.reply({ embeds: [embed] });
                }

            } catch (error) {
                console.error('獲取影片資訊錯誤：', error);
                message.reply('❌ 無法獲取影片資訊，請確認網址是否正確或稍後再試\n錯誤：' + error.message);
            }
        }

        // !stop
        if (command === 'stop') {
            const queue = getQueue(message.guild.id);
            queue.clear();

            const connection = getVoiceConnection(message.guild.id);
            if (connection) {
                connection.destroy();
            }

            message.reply('⏹️ 已停止播放並離開語音頻道');
        }

        // !skip
        if (command === 'skip') {
            const queue = getQueue(message.guild.id);
            
            if (!queue.isPlaying) {
                return message.reply('❌ 目前沒有正在播放的歌曲');
            }

            queue.player.stop();
            message.reply('⏭️ 已跳過當前歌曲');
        }

        // !pause
        if (command === 'pause') {
            const queue = getQueue(message.guild.id);
            
            if (!queue.isPlaying) {
                return message.reply('❌ 目前沒有正在播放的歌曲');
            }

            queue.player.pause();
            message.reply('⏸️ 已暫停播放');
        }

        // !resume
        if (command === 'resume') {
            const queue = getQueue(message.guild.id);
            
            if (!queue.isPlaying) {
                return message.reply('❌ 目前沒有正在播放的歌曲');
            }

            queue.player.unpause();
            message.reply('▶️ 已繼續播放');
        }

        // !queue
        if (command === 'queue') {
            const queue = getQueue(message.guild.id);
            
            if (!queue.currentSong && queue.isEmpty()) {
                return message.reply('📭 播放佇列是空的');
            }

            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('🎵 播放佇列')
                .setTimestamp();

            if (queue.currentSong) {
                embed.addFields({
                    name: '🎵 正在播放',
                    value: `[${queue.currentSong.title}](${queue.currentSong.url})\n時長: ${queue.currentSong.duration}`
                });
            }

            if (!queue.isEmpty()) {
                const queueList = queue.songs
                    .slice(0, 10)
                    .map((song, index) => `${index + 1}. [${song.title}](${song.url}) - ${song.duration}`)
                    .join('\n');

                embed.addFields({
                    name: `📝 接下來 (${queue.getQueueLength()} 首)`,
                    value: queueList
                });

                if (queue.getQueueLength() > 10) {
                    embed.setFooter({ text: `還有 ${queue.getQueueLength() - 10} 首歌曲...` });
                }
            }

            message.reply({ embeds: [embed] });
        }

        // !nowplaying
        if (command === 'nowplaying' || command === 'np') {
            const queue = getQueue(message.guild.id);
            
            if (!queue.currentSong) {
                return message.reply('❌ 目前沒有正在播放的歌曲');
            }

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('🎵 正在播放')
                .setDescription(`[${queue.currentSong.title}](${queue.currentSong.url})`)
                .addFields(
                    { name: '時長', value: queue.currentSong.duration, inline: true },
                    { name: '點播者', value: `<@${queue.currentSong.requestedBy}>`, inline: true }
                )
                .setThumbnail(queue.currentSong.thumbnail)
                .setTimestamp();

            message.reply({ embeds: [embed] });
        }
    });
}

module.exports = { setupMusicCommands, getQueue };