const { EmbedBuilder, SlashCommandBuilder, MessageFlags } = require('discord.js');
const bootSummary = require('../utils/bootSummary');

const SAY_AUTHORIZED_ID = process.env.SAY_AUTHORIZED_ID;

// ── 原本在 settings.js 的 getRandom，直接內聯 ──────────
function getRandom(max) {
    return Math.floor(Math.random() * max) + 1;
}

function setupBasicCommands(client) {

    // ════════════════════════════════════════════════════
    //  保留：被動關鍵字監聽（不適合做成指令）
    // ════════════════════════════════════════════════════
    client.on('messageCreate', async message => {
        if (message.author.bot) return;
        const content = message.content;

        // 「有什麼了不起」觸發
        if (
            content.includes('有什麼了不起') &&
            content !== '裊器'
        ) {
            const target = content.replace('有什麼了不起', '').trim();
            if (target) {
                message.channel.send(`${target}有什麼了不起 爛${target}🙁🤙`);
                console.log(`🙁 了不起回應: ${target}`);
            }
        }
    });

    // ════════════════════════════════════════════════════
    //  Slash Commands 注入
    // ════════════════════════════════════════════════════

    // ── /ping ────────────────────────────────────────────
    client.commands.set('ping', {
        data: new SlashCommandBuilder()
            .setName('ping')
            .setDescription('測試 Bot 延遲'),

        async execute(interaction, client) {
            await interaction.reply({ content: '🏓 計算中...' });
            const ping = interaction.createdTimestamp - Date.now();
            await interaction.editReply(
                `🏓 Pong!\n` +
                `📡 延遲：${Math.abs(ping)}ms\n` +
                `🌐 API 延遲：${Math.round(client.ws.ping)}ms`
            );
        }
    });

    // ── /serverinfo ──────────────────────────────────────
    client.commands.set('serverinfo', {
        data: new SlashCommandBuilder()
            .setName('serverinfo')
            .setDescription('查看伺服器資訊'),

        async execute(interaction) {
            const { guild } = interaction;
            await interaction.reply({ embeds: [
                new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle(`📊 ${guild.name} 伺服器資訊`)
                    .setThumbnail(guild.iconURL())
                    .addFields(
                        { name: '👥 成員數量', value: `${guild.memberCount}`,                          inline: true },
                        { name: '📅 創建日期', value: guild.createdAt.toLocaleDateString('zh-TW'),    inline: true },
                        { name: '👑 擁有者',   value: `<@${guild.ownerId}>`,                          inline: true },
                        { name: '💬 頻道數量', value: `${guild.channels.cache.size}`,                 inline: true },
                        { name: '😀 表情符號', value: `${guild.emojis.cache.size}`,                   inline: true },
                        { name: '🎭 身分組',   value: `${guild.roles.cache.size}`,                    inline: true }
                    )
                    .setTimestamp()
            ]});
        }
    });

    // ── /nh（合併 nh / nhs / nhr）───────────────────────
    client.commands.set('nh', {
        data: new SlashCommandBuilder()
            .setName('nh')
            .setDescription('🔞 nhentai 相關查詢')
            .addSubcommand(sub =>
                sub.setName('code')
                    .setDescription('🔞 nhentai 直接連結')
                    .addIntegerOption(opt =>
                        opt.setName('code')
                            .setDescription('nhentai 編號')
                            .setRequired(true)
                            .setMinValue(1)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('search')
                    .setDescription('🔞 nhentai 搜尋')
                    .addStringOption(opt =>
                        opt.setName('query')
                            .setDescription('搜尋關鍵字')
                            .setRequired(true)
                    )
            )
            .addSubcommand(sub =>
                sub.setName('random')
                    .setDescription('🔞 nhentai 隨機')
            ),

        async execute(interaction) {
            const sub = interaction.options.getSubcommand();

            if (sub === 'code') {
                const code = interaction.options.getInteger('code');
                await interaction.reply({ content: `https://nhentai.net/g/${code}/` });
                console.log(`🔞 nhentai 查詢: ${code}`);
                return;
            }

            if (sub === 'search') {
                const query = interaction.options.getString('query');
                await interaction.reply({ content: `https://nhentai.net/search/?q=${encodeURIComponent(query)}` });
                console.log(`🔍 nhentai 搜尋: ${query}`);
                return;
            }

            if (sub === 'random') {
                const randomCode = getRandom(620000);
                await interaction.reply({ content: `https://nhentai.net/g/${randomCode}/` });
                console.log(`🎲 nhentai 隨機: ${randomCode}`);
                return;
            }
        }
    });

    // ── /say ─────────────────────────────────────────────
    client.commands.set('say', {
        data: new SlashCommandBuilder()
            .setName('say')
            .setDescription('讓機器裊說一句話')
            .addStringOption(opt =>
                opt.setName('text')
                    .setDescription('要說的內容')
                    .setRequired(true)
            ),

        async execute(interaction) {
            if (interaction.user.id !== SAY_AUTHORIZED_ID) {
                return interaction.reply({
                    content: '別想操控我 爛咖👎',
                    flags: MessageFlags.Ephemeral
                });
            }

            const sayText = interaction.options.getString('text');
            await interaction.reply({
                content: `✅ 已發送`,
                flags: MessageFlags.Ephemeral
            });
            await interaction.channel.send(sayText);
            console.log(`💬 Say 指令: ${sayText}`);
        }
    });

    bootSummary.report('基本指令', 'ok', 'ping / serverinfo / say / nh');
}

module.exports = { setupBasicCommands };