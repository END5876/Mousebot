'use strict';
// admin/api/voice.js — 語音連線（加入／離開、喚醒詞監聽）、音樂播放控制與點歌、閒置自動停止、自動加入語音頻道
//
// 正式版和精簡版共用這份檔案：每一組路由只在對應的模組啟用時註冊（見 utils/features.js），
//   voice → 加入／離開；stt → 喚醒詞（/api/voice 的 wakeWord 欄位）；music → /api/music/*；autojoin → /api/autojoin。
// 選用模組不可以在最上層 require（精簡版沒有 voiceHandler），一律透過 features 在執行時取得。

const { getVoiceConnection } = require('@discordjs/voice');
const { PermissionFlagsBits } = require('discord.js');
const voiceMonitor = require('../../handlers/musicplayer/voiceActivityMonitor');
const features = require('../../utils/features');
const { TEXT_TYPES, VOICE_TYPES, guildSummary, guildChannels } = require('../discordInfo');
const {
  voiceInfo, musicState, idleMonitorState, musicAction, libraryList, onlineSearch, enqueueFromPanel,
} = require('../voiceState');
const { HttpError, bool, snowflake, str, requireReady } = require('../http');

const LOOP_LABEL = { off: '關閉循環', one: '開啟單曲循環', all: '開啟列表循環' };

const STT_UNAVAILABLE_MESSAGE = '語音辨識未啟用（未設定 GROQ_API_KEY 或 FEATURES 未包含 stt）';

/** 自動加入的設定與連線狀態；autojoin 模組停用時回傳 null */
function autoJoinState(client) {
  const autoJoin = features.get('autojoin');
  if (!autoJoin) return null;
  const config = autoJoin.getAutoJoinConfig();
  const channel = config.targetChannelId ? client.channels.cache.get(config.targetChannelId) : null;
  const guildId = channel?.guild?.id ?? config.targetGuildId;
  const connection = guildId ? getVoiceConnection(guildId) : null;
  return {
    enabled: config.enabled,
    targetChannelId: config.targetChannelId,
    targetGuildId: guildId ?? null,
    channelName: channel?.name ?? null,
    guildName: channel?.guild?.name ?? null,
    // Bot 是否真的在目標頻道裡（連線就緒且頻道一致）
    connected: !!connection && connection.state.status === 'ready' && connection.joinConfig.channelId === config.targetChannelId,
  };
}

module.exports = function registerVoice(router, client) {
  // 模組開關在註冊時決定一次（env 執行中不會變）
  const voiceOn = features.isEnabled('voice');
  const sttOn = features.isEnabled('stt');
  const musicOn = features.isEnabled('music');
  const autoJoinOn = features.isEnabled('autojoin');
  const voiceHandler = () => features.get('voice');

  const guildOf = (params) => {
    requireReady(client);
    const guild = client.guilds.cache.get(snowflake(params.guildId, '伺服器'));
    if (!guild) throw new HttpError(404, 'Bot 不在這個伺服器');
    return guild;
  };

  router.get('/api/voice', () => {
    requireReady(client);
    const guilds = [...client.guilds.cache.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
      .map((guild) => ({
        ...guildSummary(guild),
        voice: voiceInfo(guild),
        music: musicState(guild.id),
        idleMonitor: idleMonitorState(guild.id),
        ...(sttOn ? {
          wakeWord: {
            active: voiceHandler().isWakeWordActive(guild.id),
            defaultChannelId: voiceHandler().findTranscriptChannel(guild)?.id ?? null,
          },
        } : {}),
        voiceChannels: guildChannels(guild, VOICE_TYPES),
        textChannels: guildChannels(guild, TEXT_TYPES),
      }));
    // music 沒啟用時 /api/music/* 不存在：多回傳 musicControl:false 讓面板不顯示「點歌」（啟用時不加欄位，回應格式和以前相同）
    return { autoJoin: autoJoinState(client), guilds, ...(musicOn ? {} : { musicControl: false }) };
  });

  // ── 加入／離開語音頻道 ───────────────────────────────────
  if (voiceOn) {
    router.post('/api/voice/:guildId/join', async ({ params, body, audit }) => {
      const guild = guildOf(params);
      const channel = guild.channels.cache.get(snowflake(body.channelId, '語音頻道'));
      if (!channel || !VOICE_TYPES.includes(channel.type)) throw new HttpError(400, '找不到這個語音頻道');
      const me = guild.members.me;
      if (!me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
        throw new HttpError(400, 'Bot 沒有檢視或連線到這個頻道的權限');
      }
      try {
        await voiceHandler().joinChannel(channel);
      } catch (err) {
        throw new HttpError(502, `加入語音頻道失敗：${err.message}`);
      }
      audit(`讓 Bot 加入語音頻道「${guild.name} › ${channel.name}」`);
      return { voice: voiceInfo(guild) };
    });

    router.post('/api/voice/:guildId/leave', ({ params, audit }) => {
      const guild = guildOf(params);
      if (!voiceHandler().leaveGuild(guild)) throw new HttpError(409, 'Bot 不在這個伺服器的語音頻道');
      audit(`讓 Bot 離開「${guild.name}」的語音頻道`);
    });
  }

  // ── 喚醒詞監聽 ─────────────────────────────────────────
  if (sttOn) {
    // body：{ on: boolean, textChannelId?: string }——轉錄與 AI 回覆送到哪個文字頻道（預設「語音轉錄」頻道）
    router.put('/api/voice/:guildId/wake-word', ({ params, body, audit }) => {
      const SEND_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
      const guild = guildOf(params);
      if (!bool(body.on, '喚醒詞監聽')) {
        if (!voiceHandler().stopWakeWord(guild.id)) throw new HttpError(409, '喚醒詞監聽本來就沒有開啟');
        audit(`停止「${guild.name}」的喚醒詞監聽`);
        return { active: false };
      }

      let textChannel = null;
      if (body.textChannelId) {
        textChannel = guild.channels.cache.get(snowflake(body.textChannelId, '轉錄頻道'));
        if (!textChannel || !TEXT_TYPES.includes(textChannel.type)) throw new HttpError(400, '找不到這個文字頻道');
      } else {
        textChannel = voiceHandler().findTranscriptChannel(guild);
      }
      if (!textChannel) throw new HttpError(400, '請選擇轉錄結果要送到哪個文字頻道');
      const me = guild.members.me;
      if (!me || !textChannel.permissionsFor(me)?.has(SEND_PERMISSIONS)) throw new HttpError(400, `Bot 不能在 #${textChannel.name} 發言`);

      const result = voiceHandler().startWakeWord(guild, textChannel);
      if (result === 'unavailable') throw new HttpError(409, STT_UNAVAILABLE_MESSAGE);
      if (result === 'no_connection') throw new HttpError(409, 'Bot 不在這個伺服器的語音頻道，請先讓 Bot 加入');
      if (result === 'already') throw new HttpError(409, '喚醒詞監聽已經在運行中');
      audit(`開始「${guild.name}」的喚醒詞監聽（轉錄到 #${textChannel.name}）`);
      return { active: true };
    });
  }

  // ── 音樂：控制、點歌 ─────────────────────────────────────
  if (musicOn) {
    // body：{ action: 'skip'|'stop'|'loop'|'random'|'clearQueue'|'removeQueue'|'enqueue', mode?, on?, index?, key?, item?, next? }
    router.post('/api/music/:guildId', async ({ params, body, audit }) => {
      const guild = guildOf(params);
      if (body.action === 'enqueue') {
        const { message } = await enqueueFromPanel(client, guild, body);
        audit(`在「${guild.name}」點歌：${message}`);
        return { message, music: musicState(guild.id) };
      }
      const title = musicState(guild.id)?.current?.title;
      const message = await musicAction(guild.id, body);
      const what = {
        skip: `跳過「${title}」`,
        stop: '停止播放',
        loop: LOOP_LABEL[body.mode],
        random: body.on ? '開啟隨機連播' : '關閉隨機連播',
        clearQueue: '清空佇列',
        removeQueue: message.replace(/^已/, ''),
      }[body.action];
      audit(`音樂（${guild.name}）：${what}`);
      return { message, music: musicState(guild.id) };
    });

    router.get('/api/music/library', ({ query }) => libraryList(query.get('q')));

    router.get('/api/music/search', async ({ query }) => {
      const q = str(query.get('q'), '搜尋關鍵字', { max: 200 });
      return { results: await onlineSearch(q) };
    });
  }

  router.put('/api/voice/:guildId/idle', ({ params, body, audit }) => {
    const guildId = snowflake(params.guildId, '伺服器');
    const enabled = bool(body.enabled, '閒置自動停止');
    voiceMonitor.setEnabled(guildId, enabled);
    audit(`${enabled ? '開啟' : '關閉'}「${client.guilds.cache.get(guildId)?.name ?? guildId}」的閒置自動停止`);
    return idleMonitorState(guildId);
  });

  if (autoJoinOn) {
    // body：{ enabled?: boolean, channelId?: string }
    router.put('/api/autojoin', async ({ body, audit }) => {
      requireReady(client);
      const autoJoin = features.get('autojoin');
      if (body.channelId !== undefined) {
        const channelId = snowflake(body.channelId, '語音頻道');
        try {
          await autoJoin.setAutoJoinTarget(client, channelId);
        } catch (err) {
          if (err.code === 'EINVAL') throw new HttpError(400, err.message);
          throw err;
        }
        const state = autoJoinState(client);
        audit(`把自動加入的目標頻道設為「${state.guildName} › ${state.channelName}」`);
      }
      if (body.enabled !== undefined) {
        const enabled = bool(body.enabled, '自動加入');
        autoJoin.setAutoJoinEnabled(client, enabled);
        audit(`${enabled ? '開啟' : '關閉'}自動加入語音頻道`);
      }
      return autoJoinState(client);
    });
  }
};
