'use strict';
// admin/api/voice.js — 語音連線、音樂播放控制、閒置自動停止、自動加入語音頻道

const { getVoiceConnection } = require('@discordjs/voice');
const voiceMonitor = require('../../handlers/musicplayer/voiceActivityMonitor');
const autoJoin = require('../../handlers/autoJoinHandler');
const { VOICE_TYPES, guildSummary, guildChannels } = require('../discordInfo');
const { voiceInfo, musicState, idleMonitorState, musicAction } = require('../voiceState');
const { HttpError, bool, snowflake, requireReady } = require('../http');

function autoJoinState(client) {
  const config = autoJoin.getAutoJoinConfig();
  const channel = config.targetChannelId ? client.channels.cache.get(config.targetChannelId) : null;
  const guildId = channel?.guild?.id ?? config.targetGuildId;
  const connection = guildId ? getVoiceConnection(guildId) : null;
  return {
    enabled: config.enabled,
    targetChannelId: config.targetChannelId,
    channelName: channel?.name ?? null,
    guildName: channel?.guild?.name ?? null,
    // Bot 是否真的在目標頻道裡（連線就緒且頻道一致）
    connected: !!connection && connection.state.status === 'ready' && connection.joinConfig.channelId === config.targetChannelId,
  };
}

module.exports = function registerVoice(router, client) {
  router.get('/api/voice', () => {
    requireReady(client);
    const guilds = [...client.guilds.cache.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
      .map((guild) => ({
        ...guildSummary(guild),
        voice: voiceInfo(guild),
        music: musicState(guild.id),
        idleMonitor: idleMonitorState(guild.id),
        voiceChannels: guildChannels(guild, VOICE_TYPES),
      }));
    return { autoJoin: autoJoinState(client), guilds };
  });

  // body：{ action: 'skip'|'stop'|'loop'|'random'|'clearQueue'|'removeQueue', mode?, on?, index?, key? }
  router.post('/api/music/:guildId', async ({ params, body }) => {
    requireReady(client);
    const guildId = snowflake(params.guildId, '伺服器');
    if (!client.guilds.cache.has(guildId)) throw new HttpError(404, 'Bot 不在這個伺服器');
    const message = await musicAction(guildId, body);
    return { message, music: musicState(guildId) };
  });

  router.put('/api/voice/:guildId/idle', ({ params, body }) => {
    const guildId = snowflake(params.guildId, '伺服器');
    voiceMonitor.setEnabled(guildId, bool(body.enabled, '閒置自動停止'));
    return idleMonitorState(guildId);
  });

  // body：{ enabled?: boolean, channelId?: string }
  router.put('/api/autojoin', async ({ body }) => {
    requireReady(client);
    if (body.channelId !== undefined) {
      const channelId = snowflake(body.channelId, '語音頻道');
      try {
        await autoJoin.setAutoJoinTarget(client, channelId);
      } catch (err) {
        if (err.code === 'EINVAL') throw new HttpError(400, err.message);
        throw err;
      }
    }
    if (body.enabled !== undefined) autoJoin.setAutoJoinEnabled(client, bool(body.enabled, '自動加入'));
    return autoJoinState(client);
  });
};
