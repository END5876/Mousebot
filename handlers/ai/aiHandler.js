// handlers/ai/aiHandler.js（MouseBot 與 mousebot-lite 共用，兩邊內容相同）
// /ai 指令、@ 提及回覆、隨機插話。能用哪些功能由兩件事決定：
//   - 範圍鎖定（persona.getLock()，AI_SCOPE_LOCK／profile.aiScopeLock）：
//       鎖定時只有單一人格（群聊），沒有 /ai mode、/ai prompt、/ai scope，/ai 只能在伺服器內使用，私訊不回覆
//   - 模組（utils/features.js）：/ai tts 要有 aiTts、/ai gugu 要有 gugu；AI 工具、自訂回應也是有才用
// 沒有設定 GEMINI_API_KEY 時 setupAICommands 不註冊任何東西。
//
// 注意：aiScope、modeSelector 只在不鎖定時才 lazy require；不能在最上層呼叫 features.get()（會循環 require）。

const persona = require('./persona');
const { getGeminiResponse, getGeminiResponseVoice } = require('./aiCore');
const { replaceMentions } = require('./aiUtils');
const bootSummary = require('../../utils/bootSummary');
const features = require('../../utils/features');
const { isAIEnabled } = require('./aiSettings');
const { handleAsk, handleClear, handleTTS, handleChanceSet, handleGugu } = require('./aiCommands');
const {
  handleMode, handlePromptEdit, handleScopeShow, handleScopeSet, handleScopeReset,
} = require('./aiPersonaCommands');
const { buildAiCommand } = require('./aiCommandBuilder');
const { handleMention, handleRandomReply } = require('./aiMessages');
const { reportBootSummary } = require('./aiBootSummary');

// 範圍鎖定：persona 在模組載入時就算好了，之後不會變
const getLock = () => persona.getLock();

// 每則訊息都會跑一次的正規表示式：原本 `[^\s)\]>]+.*\.` 的兩段貪婪量詞在長訊息上會
// 造成 O(n²) 回溯；改成單段非空白匹配，語意相同（網址中任一處出現圖片副檔名）。
const LIKELY_IMAGE_LINK_RE = /https?:\/\/\S+\.(?:png|jpe?g|webp|heic|heif|gif)(?:\?\S*)?|cdn\.discordapp\.com\/attachments\//i;

const aiCommand = {
    // setupAICommands 依範圍鎖定與模組是否啟用建立
    data: null,

    async execute(interaction) {
        const sub   = interaction.options.getSubcommand();
        const group = interaction.options.getSubcommandGroup(false);

        if (group === 'chance') {
            return handleChanceSet(interaction);
        }
        // 鎖定時沒有註冊 prompt／scope／mode，萬一收到（舊的指令定義）也不處理
        if (group === 'prompt') {
            return getLock() ? undefined : handlePromptEdit(interaction);
        }
        if (group === 'scope') {
            if (getLock()) return;
            if (sub === 'show')  return handleScopeShow(interaction);
            if (sub === 'set')   return handleScopeSet(interaction);
            if (sub === 'reset') return handleScopeReset(interaction);
            return;
        }

        switch (sub) {
            case 'ask':   return handleAsk(interaction);
            case 'clear': return handleClear(interaction);
            case 'tts':   return handleTTS(interaction);
            case 'mode':  return getLock() ? undefined : handleMode(interaction);
            case 'gugu':  return handleGugu(interaction);
        }
    }
};

// ════════════════════════════════════════════════════════
//  setupAICommands
// ════════════════════════════════════════════════════════
function setupAICommands(client) {
    // 正常情況下 utils/features.js 在沒有 GEMINI_API_KEY 時就不會呼叫這裡；這是直接呼叫時的防線
    if (!isAIEnabled()) {
        bootSummary.report('AI 對話 (/ai)', 'off', '未設定 GEMINI_API_KEY，AI 功能停用');
        return false;
    }

    const lock = getLock();
    aiCommand.data = buildAiCommand({ lock, tts: features.isEnabled('aiTts'), gugu: features.isEnabled('gugu') });
    client.commands.set(aiCommand.data.name, aiCommand);

    reportBootSummary();

    client.on('messageCreate', async message => {
        // 鎖定時群聊歷史以伺服器頻道為單位，私訊不回覆
        if (message.author.bot || (lock && !message.guild)) return;

        const hasAttachment = message.attachments.size > 0;
        const content = message.content?.trim() || '';
        const hasLikelyImageLink = LIKELY_IMAGE_LINK_RE.test(content);
        if (!content && !hasAttachment && !hasLikelyImageLink) return;

        const botId = client.user.id;
        const mentionedRoles = message.mentions.roles;
        // 🐛 預設 has() 會把 @everyone/@here 與「Bot 也有的身分組」都算成 @Bot，公告會觸發完整回覆；
        //    只認直接 @Bot（含回覆 Bot 的訊息）與 Bot 自己的整合身分組
        const isMentioned =
            message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true }) ||
            mentionedRoles.some(r => r.tags?.botId === botId);
        const hasOtherMention =
            message.mentions.users.some(u => u.id !== botId) ||
            mentionedRoles.size > 0;
        const hasReference = !!message.reference?.messageId;

        if (hasOtherMention && !hasReference && !isMentioned) return;

        // 範圍只在這裡解析一次（純記憶體查詢），人格、歷史與訊息紀錄都用同一份，中途被切換也不會前後不一致
        const scope = persona.resolveScope(message.channel, message.guild?.id);

        if (isMentioned) {
            // 將提及轉換為名字，並濾掉機器人自己（頻道停用隨機回覆不影響 @ 提及）
            const rawQuestion = replaceMentions(message, botId);
            await handleMention(message, client, { rawQuestion, hasAttachment, hasLikelyImageLink, scope });
        } else {
            await handleRandomReply(message, client, { hasAttachment, hasReference, scope });
        }
    });

    return true;
}

module.exports = { setupAICommands, isAIEnabled, getGeminiResponse, getGeminiResponseVoice };
