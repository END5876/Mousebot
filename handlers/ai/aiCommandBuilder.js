// handlers/ai/aiCommandBuilder.js（MouseBot 與 mousebot-lite 共用，兩邊內容相同）
// /ai 指令的定義（子指令與選項）。

const { SlashCommandBuilder, InteractionContextType } = require('discord.js');
const { DEFAULT_CHANCE } = require('./aiChance');

// ════════════════════════════════════════════════════════
//  /ai 單一指令，底下掛 ask / clear / tts / mode / prompt(group) / chance(group) / scope(group) / gugu
// ════════════════════════════════════════════════════════
/**
 * 建立 /ai 指令。子指令的加入順序固定（ask、clear、tts、mode、prompt、chance、scope、gugu），
 * 條件相同時指令 JSON 就和以前完全一樣（不一致的話開機會重新 PUT 全域指令）。
 * @param {object} opts
 * @param {object|null} opts.lock  persona.getLock()；鎖定時沒有 mode／prompt／scope，只能在伺服器內使用
 * @param {boolean} opts.tts       aiTts 模組啟用時才有 /ai tts
 * @param {boolean} opts.gugu      gugu 模組啟用時才有 /ai gugu
 */
function buildAiCommand({ lock: locked, tts, gugu }) {
    const builder = new SlashCommandBuilder()
        .setName('ai')
        .setDescription('AI 對話相關功能');

    // 鎖定時群聊歷史以伺服器頻道為單位（精簡版也沒有 DM 的 intent）：只在伺服器內提供
    if (locked) builder.setContexts(InteractionContextType.Guild);

    builder
        // ── /ai ask ──
        .addSubcommand(sub =>
            sub.setName('ask')
                .setDescription('詢問 AI 問題')
                .addStringOption(opt =>
                    opt.setName('question').setDescription('你想問的問題').setRequired(true)
                )
                .addAttachmentOption(opt =>
                    opt.setName('image').setDescription('附上圖片（選填）').setRequired(false)
                )
        );

    // ── /ai clear ──
    if (locked) {
        builder.addSubcommand(sub =>
            sub.setName('clear')
                .setDescription('清除你在這個頻道與 AI 的對話記憶')
                .addBooleanOption(opt =>
                    opt.setName('all')
                        .setDescription('清除整個頻道所有人的對話記憶（僅限管理員）')
                        .setRequired(false)
                )
        );
    } else {
        builder.addSubcommand(sub =>
            sub.setName('clear')
                .setDescription('清除你與 AI 的對話記憶')
                .addBooleanOption(opt =>
                    opt.setName('scope')
                        .setDescription('單一人格頻道：清除整個頻道的對話記憶（僅限管理員）')
                        .setRequired(false)
                )
        );
    }

    if (tts) {
        builder
            // ── /ai tts ──
            .addSubcommand(sub =>
                sub.setName('tts')
                    .setDescription('切換 AI 回覆是否自動朗讀（語音頻道）')
            );
    }

    if (!locked) {
        builder
            // ── /ai mode ──
            .addSubcommand(sub =>
                sub.setName('mode')
                    .setDescription('設定指定使用者的 AI 人格模式')
                    .addUserOption(opt =>
                        opt.setName('target')
                            .setDescription('要設定的使用者（不填則設定自己）')
                            .setRequired(false)
                    )
                    .addStringOption(opt =>
                        opt.setName('mode')
                            .setDescription('模式名稱（不填則重置為預設）')
                            .setRequired(false)
                    )
            )

            // ── /ai prompt edit（子指令群組，僅限擁有者） ──
            .addSubcommandGroup(group =>
                group.setName('prompt')
                    .setDescription('AI 模式設定')
                    .addSubcommand(sub =>
                        sub.setName('edit')
                            .setDescription('編輯 AI 模式')
                            .addStringOption(opt =>
                                opt.setName('mode')
                                    .setDescription('模式名稱')
                                    .setRequired(true)
                            )
                    )
            );
    }

    builder
        // ── /ai chance set / toggle（子指令群組） ──
        .addSubcommandGroup(group =>
            group.setName('chance')
                .setDescription('AI 隨機回覆機率設定')
                .addSubcommand(sub =>
                    sub.setName('set')
                        .setDescription('設定本伺服器的 AI 隨機回覆機率')
                        .addNumberOption(opt =>
                            opt.setName('chance')
                                .setDescription(`機率 0~100（%），不填則重置為預設值 ${(DEFAULT_CHANCE * 100).toFixed(0)}%`)
                                .setMinValue(0)
                                .setMaxValue(100)
                                .setRequired(false)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('toggle')
                        .setDescription('切換本頻道的 AI 隨機回覆開關（不影響其他頻道）')
                )
        );

    if (!locked) {
        builder
            // ── /ai scope show / set / reset（子指令群組；show 所有人可用，其餘僅限管理員） ──
            .addSubcommandGroup(group =>
                group.setName('scope')
                    .setDescription('AI 範圍：多人格（每人各自的人格）或單一人格（大家共用同一個人格）')
                    .addSubcommand(sub =>
                        sub.setName('show')
                            .setDescription('查看這裡目前的 AI 範圍設定')
                    )
                    .addSubcommand(sub =>
                        sub.setName('set')
                            .setDescription('設定本伺服器（或本頻道）的 AI 範圍')
                            .addStringOption(opt =>
                                opt.setName('kind')
                                    .setDescription('多人格或單一人格')
                                    .setRequired(true)
                                    .addChoices(
                                        { name: '多人格（每人各自的人格）', value: 'multi' },
                                        { name: '單一人格（大家共用同一個人格）', value: 'single' },
                                    )
                            )
                            .addStringOption(opt =>
                                opt.setName('persona')
                                    .setDescription('單一人格時使用的人格代號（kind 為 single 時必填）')
                                    .setRequired(false)
                            )
                            .addBooleanOption(opt =>
                                opt.setName('channel')
                                    .setDescription('只套用到目前這個頻道（預設 false＝整個伺服器）')
                                    .setRequired(false)
                            )
                    )
                    .addSubcommand(sub =>
                        sub.setName('reset')
                            .setDescription('移除本伺服器（或本頻道）的 AI 範圍設定，回到上一層的設定')
                            .addBooleanOption(opt =>
                                opt.setName('channel')
                                    .setDescription('只重置目前這個頻道的覆寫（預設 false＝整個伺服器）')
                                    .setRequired(false)
                            )
                    )
            );
    }

    if (gugu) {
        builder
            // ── /ai gugu ──
            .addSubcommand(sub =>
                sub.setName('gugu')
                    .setDescription('生成一篇咕咕嘎嘎體文章')
                    .addStringOption(opt =>
                        opt.setName('topic')
                            .setDescription('文章主題（例如：上班、貓咪、宇宙）')
                            .setRequired(true)
                    )
            );
    }

    builder.setDefaultMemberPermissions(null); // 個別子指令權限在 execute() 內手動判斷
    return builder;
}

module.exports = {
  buildAiCommand,
};
