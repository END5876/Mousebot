const { EmbedBuilder } = require('discord.js');
const { PREFIX, getRandom } = require('../config/settings');

function setupBasicCommands(client) {
    client.on('messageCreate', async message => {
        if (message.author.bot) return;

        const content = message.content;

        // !help
        /*if (content === '!help') {
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🤖 Bot 指令列表')
                .setDescription('以下是所有可用的指令：')
                .addFields(
                    {
                        name: '🎵 音樂指令',
                        value: '`!play <網址>` - 播放 YouTube 音樂\n' +
                               '`!stop` - 停止播放並離開\n' +
                               '`!skip` - 跳過當前歌曲\n' +
                               '`!pause` - 暫停播放\n' +
                               '`!resume` - 繼續播放\n' +
                               '`!queue` - 顯示播放佇列\n' +
                               '`!nowplaying` / `!np` - 顯示當前歌曲'
                    },
                    {
                        name: '🎤 語音指令',
                        value: '`!join` - 加入你的語音頻道\n' +
                               '`!leave` - 離開語音頻道\n' +
                               '`!voice` - 顯示語音狀態'
                    },
                    {
                        name: '📊 基本指令',
                        value: '`!ping` - 測試延遲\n' +
                               '`!serverinfo` - 伺服器資訊\n' +
                               '`!help` - 顯示此幫助訊息'
                    },
                    {
                        name: '🔞 其他指令',
                        value: '`!nh<數字>` - nhentai 直接連結\n' +
                               '`!nhs<關鍵字>` - nhentai 搜尋\n' +
                               '`!nhr` - nhentai 隨機'
                    }
                )
                .setFooter({ text: '使用 ! 作為指令前綴' })
                .setTimestamp();

            message.reply({ embeds: [embed] });
        }*/

        // !ping
        if (content === '!ping') {
            const sent = await message.reply('🏓 計算中...');
            const ping = sent.createdTimestamp - message.createdTimestamp;
            sent.edit(`🏓 Pong!\n📡 延遲：${ping}ms\n🌐 API 延遲：${Math.round(client.ws.ping)}ms`);
        }

        // !serverinfo
        if (content === '!serverinfo') {
            const { guild } = message;
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle(`📊 ${guild.name} 伺服器資訊`)
                .setThumbnail(guild.iconURL())
                .addFields(
                    { name: '👥 成員數量', value: `${guild.memberCount}`, inline: true },
                    { name: '📅 創建日期', value: guild.createdAt.toLocaleDateString('zh-TW'), inline: true },
                    { name: '👑 擁有者', value: `<@${guild.ownerId}>`, inline: true },
                    { name: '💬 頻道數量', value: `${guild.channels.cache.size}`, inline: true },
                    { name: '😀 表情符號', value: `${guild.emojis.cache.size}`, inline: true },
                    { name: '🎭 身分組', value: `${guild.roles.cache.size}`, inline: true }
                )
                .setTimestamp();

            message.reply({ embeds: [embed] });
        }

        // !陳樂瞳 或 !肖仔
        if (content === `${PREFIX}陳樂瞳` || content === `${PREFIX}肖仔`) {
            message.channel.send('陳樂瞳我不會再說你是肖仔了 因為你媽媽很酷');
            return;
        }

        // !nh<數字>
        if (content.startsWith(`${PREFIX}nh`) && !content.includes('s') && !content.includes('r')) {
            const code = content.replace(`${PREFIX}nh`, '').trim();
            if (code && /^\d+$/.test(code)) {
                message.channel.send(`https://nhentai.net/g/${code}/`);
                console.log(`🔞 nhentai 查詢: ${code}`);
                return;
            }
        }

        // !nhs<關鍵字>
        if (content.startsWith(`${PREFIX}nhs`)) {
            const query = content.replace(`${PREFIX}nhs`, '').trim();
            if (query) {
                message.channel.send(`https://nhentai.net/search/?q=${encodeURIComponent(query)}`);
                console.log(`🔍 nhentai 搜尋: ${query}`);
                return;
            }
        }

        // !nhr
        if (content === `${PREFIX}nhr`) {
            const randomCode = getRandom(620000);
            message.channel.send(`https://nhentai.net/g/${randomCode}/`);
            console.log(`🎲 nhentai 隨機: ${randomCode}`);
            return;
        }

        // !say<訊息>
        if (content.startsWith(`${PREFIX}say`) && content !== `${PREFIX}say`) {
            if (message.author.id === '598054316510806017') {
                const sayText = content.replace(`${PREFIX}say`, '').trim();
                message.delete().catch(() => {});
                message.channel.send(sayText);
                console.log(`💬 Say 指令: ${sayText}`);
            } else {
                message.reply('別想操控我 爛咖👎');
            }
            return;
        }

        // 有什麼了不起
        if (content.includes('有什麼了不起') && 
            message.author.id !== '932536588389466162' && 
            content !== '裊器') {
            const target = content.replace('有什麼了不起', '').trim();
            if (target) {
                message.channel.send(`${target}有什麼了不起 爛${target}😒🤙`);
                console.log(`😒 了不起回應: ${target}`);
                return;
            }
        }
    });
}

module.exports = { setupBasicCommands };