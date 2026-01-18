const {
    joinVoiceChannel,
    getVoiceConnection,
    VoiceConnectionStatus,
    entersState
} = require('@discordjs/voice');
const { EmbedBuilder } = require('discord.js');
const { getQueue } = require('./musicHandler');
const { PREFIX } = require('../config/settings');

function setupVoiceCommands(client) {
    client.on('messageCreate', async message => {
        if (message.author.bot) return;

        const content = message.content;

        // !join
        if (content === `${PREFIX}join`) {
            if (!message.member.voice.channel) {
                return message.reply('你要我去哪?');
            }

            const channel = message.member.voice.channel;

            try {
                const connection = joinVoiceChannel({
                    channelId: channel.id,
                    guildId: channel.guild.id,
                    adapterCreator: channel.guild.voiceAdapterCreator,
                    selfDeaf: false,
                    selfMute: false,
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
                        console.log('❌ 語音連接已斷開');
                    }
                });

                await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
                console.log(`✅ 已加入語音頻道：${channel.name} (${channel.guild.name})`);

            } catch (error) {
                console.error('加入語音頻道時發生錯誤：', error);
            }
        }

        // !leave
        if (content === `${PREFIX}leave`) {
            const connection = getVoiceConnection(message.guild.id);

            if (!connection) {
                return message.reply('你要我離開哪?');
            }

            connection.destroy();
            
            const queue = getQueue(message.guild.id);
            queue.clear();
            
            console.log(`👋 已離開語音頻道 (${message.guild.name})`);
        }

        // !voice
        if (content === `${PREFIX}voice`) {
            const connection = getVoiceConnection(message.guild.id);
            
            if (!connection) {
                return message.reply('📢 Bot 目前不在任何語音頻道中');
            }

            const channel = message.guild.channels.cache.get(connection.joinConfig.channelId);
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('🎤 語音頻道狀態')
                .addFields(
                    { name: '頻道名稱', value: channel?.name || '未知', inline: true },
                    { name: '連接狀態', value: connection.state.status, inline: true },
                    { name: '頻道成員', value: `${channel?.members.size || 0} 人`, inline: true }
                )
                .setTimestamp();

            message.reply({ embeds: [embed] });
        }
    });
}

module.exports = { setupVoiceCommands };