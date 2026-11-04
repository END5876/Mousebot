'use strict';
// AI 工具：讓 Bot 進出語音頻道、用 TTS 在語音頻道說一句話。
// 與 /voice join、/voice leave 用同一組函式；voiceHandler 會載入 aiHandler，延遲 require 避免循環依賴。

const { Type } = require('@google/genai');
const { fail } = require('./toolError');
const { botVoiceChannelId, requireBotAndUserTogether } = require('./voiceGuard');

const MAX_SAY_LENGTH = 200;

const voiceHandler = () => require('../../voiceHandler');

async function join(ctx) {
    const target = ctx.member?.voice?.channel;
    if (!target) fail('使用者不在語音頻道裡，Bot 不知道要去哪');
    const current = botVoiceChannelId(ctx.guild);
    if (current === target.id) return `Bot 本來就在「${target.name}」了`;
    if (current) {
        const { isPlaying } = require('../../musicplayer/unifiedQueue');
        if (isPlaying(ctx.guild.id)) fail('Bot 正在別的語音頻道播音樂，不能直接被叫走');
    }
    try {
        await voiceHandler().joinChannel(target);
    } catch {
        fail('加入語音頻道時發生錯誤');
    }
    return `已加入語音頻道「${target.name}」`;
}

async function leave(ctx) {
    requireBotAndUserTogether(ctx);
    if (!voiceHandler().leaveGuild(ctx.guild)) fail('Bot 現在不在語音頻道');
    return '已離開語音頻道（音樂也一起停止了）';
}

async function say(ctx, { text }) {
    text = String(text || '').trim().slice(0, MAX_SAY_LENGTH);
    if (!text) fail('沒有說要唸什麼');
    if (!botVoiceChannelId(ctx.guild)) fail('Bot 不在語音頻道，沒辦法唸出來');
    const { playTTS } = require('../../voice/ttsHandler');
    const result = await playTTS(ctx.guild.id, text);
    if (!result?.success) fail(`語音播放失敗（${result?.reason ?? '未知原因'}）`);
    return `已在語音頻道唸出：「${text}」`;
}

const tools = [
    {
        declaration: {
            name: 'voice_join',
            description: '讓 Bot 加入使用者目前所在的語音頻道。使用者說「進來」「來語音」「過來陪我」時呼叫。',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        label: '加入語音',
        run: join,
    },
    {
        declaration: {
            name: 'voice_leave',
            description: '讓 Bot 離開語音頻道（正在播的音樂會停止）。使用者明確要 Bot 離開語音時才呼叫。',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        label: '離開語音',
        run: leave,
    },
    {
        declaration: {
            name: 'voice_say',
            description: '用 TTS 在語音頻道把一段話唸出來給頻道裡的人聽。使用者要 Bot「幫我跟大家說…」「唸出來」時呼叫。',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    text: { type: Type.STRING, description: `要唸的內容（${MAX_SAY_LENGTH} 字以內）` },
                },
                required: ['text'],
            },
        },
        label: '語音唸出',
        run: say,
        // 語音對話的回覆本來就會用 TTS 唸出來，不需要這個工具
        skipSources: ['voice'],
    },
];

module.exports = { tools };
