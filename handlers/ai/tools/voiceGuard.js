'use strict';
// 音樂／語音工具共用的語音頻道檢查。
// Bot 目前所在的語音頻道以 guild.members.me.voice 為準（autojoin、/voice join、/play 進來的都算）。

const { fail } = require('./toolError');

function botVoiceChannelId(guild) {
    return guild?.members?.me?.voice?.channelId ?? null;
}

/**
 * 要求發言者在語音頻道裡；Bot 已經在某個頻道時，兩邊必須是同一個。
 * @returns {import('discord.js').VoiceBasedChannel} 發言者所在的語音頻道
 */
function requireUserWithBot(ctx) {
    const userChannel = ctx.member?.voice?.channel;
    if (!userChannel) fail('使用者不在語音頻道裡，要先進語音頻道才能這樣做');
    const botChannelId = botVoiceChannelId(ctx.guild);
    if (botChannelId && botChannelId !== userChannel.id) fail('使用者跟 Bot 不在同一個語音頻道');
    return userChannel;
}

/** 要求 Bot 已在語音頻道、且發言者也在同一個頻道（控制播放、讓 Bot 離開用） */
function requireBotAndUserTogether(ctx) {
    const botChannelId = botVoiceChannelId(ctx.guild);
    if (!botChannelId) fail('Bot 現在不在語音頻道');
    if (ctx.member?.voice?.channelId !== botChannelId) fail('使用者要在 Bot 所在的語音頻道裡才能控制');
}

module.exports = { botVoiceChannelId, requireUserWithBot, requireBotAndUserTogether };
