'use strict';
// AI 工具：名單上的使用者辱罵 Bot 時，把他禁言（Discord timeout）一分鐘，人格再嗆回去。
//
// 預設關閉：只有手動加進名單（環境變數 AI_TIMEOUT_USERS 或管理面板，見 timeoutList.js）的使用者才可能被禁言。
//
// 防濫用：
//   - 對象固定是發言者本人（ctx.member），模型不能指定別人，所以「幫我禁言某某」不會生效
//   - 發言者不在名單上時不宣告這個工具，判斷 prompt 也不附禁言規則
//   - 只在使用者主動找 Bot 時（@提及、/ai ask）才有機會觸發；隨機插話不帶工具
//   - 語音對話不提供（語音辨識可能聽錯，誤禁言代價太高）
//   - Bot 沒有「禁言成員」權限時不宣告；權限比 Bot 高的人（管理員等）禁言不了
//

const { Type } = require('@google/genai');
const { PermissionFlagsBits } = require('discord.js');
const { fail } = require('./toolError');
const timeoutList = require('./timeoutList');

const TIMEOUT_MS = 60_000;
const MAX_REASON_LENGTH = 100;

const COMEBACK_HINT = '回覆時用一句話嗆回去，簡短有力，不要說教、不要道歉。';

const hasList = () => !timeoutList.isEmpty();
const isListed = (userId) => timeoutList.has(userId);

async function timeoutInsulter(ctx, { reason }) {
    const member = ctx.member;
    reason = String(reason || '').trim().slice(0, MAX_REASON_LENGTH) || '辱罵 Bot';
    // 宣告時已經檢查過，這裡再擋一次，避免名單外的人被禁言
    if (!isListed(ctx.userId)) fail(`對方不在可以禁言的名單上。${COMEBACK_HINT}`);
    if (member.isCommunicationDisabled?.()) fail(`對方本來就在禁言中。${COMEBACK_HINT}`);
    if (!member.moderatable) fail(`對方權限比 Bot 高（例如管理員），禁言不了。${COMEBACK_HINT}`);
    try {
        await member.timeout(TIMEOUT_MS, `AI 判定辱罵 Bot：${reason}`);
    } catch {
        fail(`禁言時發生錯誤，沒有禁言成功。${COMEBACK_HINT}`);
    }
    return `已把 ${member.displayName ?? '對方'} 禁言 1 分鐘（原因：${reason}）。${COMEBACK_HINT}`;
}

const tools = [
    {
        declaration: {
            name: 'timeout_insulter',
            description: '把正在辱罵機器人的發言者本人禁言 1 分鐘。只能處罰發言者自己，不能指定別人。',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    reason: { type: Type.STRING, description: `禁言原因，簡短描述對方罵了什麼（${MAX_REASON_LENGTH} 字以內）` },
                },
                required: ['reason'],
            },
        },
        label: '禁言辱罵者',
        run: timeoutInsulter,
        isAvailable: (ctx) => isListed(ctx?.userId)
            && !!ctx?.guild?.members?.me?.permissions?.has?.(PermissionFlagsBits.ModerateMembers),
        skipSources: ['voice'],
        // 這個工具不是「使用者要求 Bot 做事」，判斷階段需要額外的規則；只在宣告這個工具時附上
        routerRule: '例外：最新訊息是在認真辱罵、羞辱機器人本身（用髒話罵機器人、人身攻擊、叫它去死）時，呼叫 timeout_insulter。'
            + '朋友間的吐槽或開玩笑（「你好笨喔哈哈」「爛 bot 笑死」）、罵別人或罵其他東西、引用或轉述別人的話、自嘲、單純說髒話抒發情緒，都不要呼叫。',
    },
];

// 預篩關鍵字：召回率優先，是不是真的在罵 Bot 交給判斷階段
const keywords = [
    '幹(?!嘛|麼|啥)', '靠北', '靠杯', '白[癡痴]', '智障', '垃圾', '廢物', '廢柴', '去死', '死開', '閉嘴', '滾',
    '腦殘', '低能', '北七', '[機雞]掰', '媽的', '三小', '操你', '賤', '欠揍', '欠幹',
    'fuck', 'shit', 'stfu', 'idiot', 'bitch', 'stupid', 'trash', 'retard',
];

module.exports = { tools, keywords, hasList, TIMEOUT_MS };
