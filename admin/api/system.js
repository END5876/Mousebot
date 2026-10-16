'use strict';
// admin/api/system.js — Bot 狀態文字、以 Bot 身分發訊息、Slash 指令同步、音樂快取、設定備份、重新啟動、操作紀錄

const fs = require('fs');
const path = require('path');
const { PermissionFlagsBits } = require('discord.js');
const presence = require('../../handlers/presenceHandler');
const { syncCommands, clientSyncOptions, getSyncStatus } = require('../../utils/commandSync');
const { requestShutdown, isSupervised } = require('../../utils/processGuards');
const audit = require('../audit');
const { cacheStats, clearDownloads } = require('../cacheTools');
const { TEXT_TYPES, VOICE_TYPES, guildSummary, guildChannels } = require('../discordInfo');
const { HttpError, FileResponse, oneOf, snowflake, str, requireReady } = require('../http');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SYNC_COOLDOWN_MS = 30 * 1000;
const RESTART_DELAY_MS = 500;
const SUBCOMMAND_TYPES = [1, 2]; // SUB_COMMAND、SUB_COMMAND_GROUP

// 設定備份包含的檔案。不含任何金鑰（admin-session-secret、cookies），也不含暫存或可重建的檔案
const SETTINGS_FILES = [
  'responses.json', 'userModes.json', 'replyChance.json', 'replyChanceDisabled.json', 'autojoin.json',
  'steamchannel.json', 'epicchannel.json', 'timeAnnouncerSettings.json', 'voiceMonitorEnabled.json',
  'presence.json', 'ttsSettings.json', 'aiTTS.json',
];
const STATS_FILES = ['tokenUsage.json', 'musicPlayCount.json', 'steamnotified.json', 'epicnotified.json', 'adminAudit.json'];

const shorten = (text, max = 60) => (text.length > max ? `${text.slice(0, max)}…` : text);

function readDataFile(rel) {
  const file = path.join(DATA_DIR, rel);
  if (!fs.existsSync(file)) return undefined;
  const raw = fs.readFileSync(file, 'utf8');
  if (!rel.endsWith('.json')) return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

function buildBackup(includeStats) {
  const files = {};
  for (const rel of [...SETTINGS_FILES, ...(includeStats ? STATS_FILES : [])]) {
    const value = readDataFile(rel);
    if (value !== undefined) files[rel] = value;
  }
  // AI 人格：共用規則與各模式（不含 .history 版本紀錄）
  for (const rel of ['prompts/_general.md', 'prompts/_voice.md']) {
    const value = readDataFile(rel);
    if (value !== undefined) files[rel] = value;
  }
  const modesDir = path.join(DATA_DIR, 'prompts', 'modes');
  if (fs.existsSync(modesDir)) {
    for (const f of fs.readdirSync(modesDir).filter((name) => name.endsWith('.md')).sort()) {
      files[`prompts/modes/${f}`] = readDataFile(`prompts/modes/${f}`);
    }
  }
  return { app: 'Mousebot', type: 'settings-backup', version: 1, createdAt: new Date().toISOString(), files };
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

module.exports = function registerSystem(router, client) {
  // ── Bot 狀態文字 ─────────────────────────────────────────
  router.get('/api/presence', () => ({
    ...presence.getPresenceConfig(),
    statuses: presence.STATUSES,
    types: presence.ACTIVITY_TYPES,
  }));

  router.put('/api/presence', ({ body, audit: log }) => {
    let next;
    try {
      next = presence.setPresenceConfig(client, {
        status: oneOf(body.status, presence.STATUSES, '狀態'),
        type: oneOf(body.type, presence.ACTIVITY_TYPES, '活動類型'),
        text: str(body.text, '活動文字', { max: 128, allowEmpty: true }),
      });
    } catch (err) {
      if (err.code === 'EINVAL') throw new HttpError(400, err.message);
      throw err;
    }
    log(`更新 Bot 狀態：${next.status}・${next.type === 'none' ? '無活動' : `${next.type}「${next.text}」`}`);
    return next;
  });

  // ── 頻道清單（發訊息、各種下拉選單用）──────────────────────
  router.get('/api/guild-channels', () => {
    requireReady(client);
    return {
      guilds: [...client.guilds.cache.values()]
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
        .map((guild) => ({
          ...guildSummary(guild),
          textChannels: guildChannels(guild, TEXT_TYPES),
          voiceChannels: guildChannels(guild, VOICE_TYPES),
        })),
    };
  });

  // ── 以 Bot 身分發訊息（等同 /say；@everyone / @here / 身分組提及一律不會生效）─────
  router.post('/api/messages', async ({ body, audit: log }) => {
    requireReady(client);
    const channel = await client.channels.fetch(snowflake(body.channelId, '頻道')).catch(() => null);
    if (!channel?.guild || !(TEXT_TYPES.includes(channel.type) || VOICE_TYPES.includes(channel.type))) {
      throw new HttpError(400, '找不到這個頻道');
    }
    const content = str(body.content, '訊息內容', { max: 2000 });
    const me = channel.guild.members.me;
    if (!me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      throw new HttpError(400, `Bot 不能在 #${channel.name} 發言`);
    }
    const message = await channel.send({ content });
    log(`以 Bot 身分在「${channel.guild.name} › #${channel.name}」發送訊息：${shorten(content)}`);
    return { id: message.id, url: message.url };
  });

  // ── Slash 指令 ───────────────────────────────────────────
  router.get('/api/commands', async () => {
    requireReady(client);
    const status = getSyncStatus(client);
    const local = [...client.commands.values()]
      .map((cmd) => cmd.data.toJSON())
      .map((json) => ({
        name: json.name,
        description: json.description,
        subcommands: (json.options || []).filter((o) => SUBCOMMAND_TYPES.includes(o.type)).length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    let remote = null;
    let remoteError = null;
    try {
      const fetched = status.devGuildId
        ? await client.guilds.cache.get(status.devGuildId)?.commands.fetch()
        : await client.application.commands.fetch();
      remote = [...(fetched?.values() ?? [])]
        .map((c) => ({ id: c.id, name: c.name, description: c.description }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      remoteError = err.message;
    }
    return { ...status, local, remote, remoteError };
  });

  let lastSync = 0;
  router.post('/api/commands/sync', async ({ audit: log }) => {
    requireReady(client);
    const wait = lastSync + SYNC_COOLDOWN_MS - Date.now();
    if (wait > 0) throw new HttpError(429, `剛剛才同步過，請 ${Math.ceil(wait / 1000)} 秒後再試`);
    lastSync = Date.now();
    let result;
    try {
      result = await syncCommands({ ...clientSyncOptions(client), force: true });
    } catch (err) {
      throw new HttpError(502, `同步失敗：${err.message}`);
    }
    log(`強制重新同步 Slash 指令（${result.count} 個，${result.scope === 'global' ? '全域' : '測試伺服器'}）`);
    return result;
  });

  // ── 音樂快取 ─────────────────────────────────────────────
  router.get('/api/cache', () => cacheStats());

  router.post('/api/cache/clear', ({ audit: log }) => {
    const result = clearDownloads();
    log(`清除音樂下載快取：刪除 ${result.deleted} 個檔案、釋放 ${result.freedMB} MB${result.skipped ? `（${result.skipped} 個使用中略過）` : ''}`);
    return result;
  });

  // ── 設定備份（下載一個 JSON 檔）──────────────────────────
  router.get('/api/backup', ({ query, audit: log }) => {
    const includeStats = query.get('stats') === '1';
    const backup = buildBackup(includeStats);
    log(`下載設定備份（${Object.keys(backup.files).length} 個檔案${includeStats ? '，含統計資料' : ''}）`);
    return new FileResponse({
      filename: `mousebot-backup-${stamp()}.json`,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(backup, null, 2),
    });
  });

  // ── 重新啟動 ─────────────────────────────────────────────
  router.get('/api/system', () => ({
    supervised: isSupervised(),
    uptimeSec: Math.round(process.uptime()),
    pid: process.pid,
    node: process.version,
  }));

  router.post('/api/restart', ({ audit: log }) => {
    const supervised = isSupervised();
    log(supervised ? '重新啟動 Bot' : '關閉 Bot（不是由 supervisord 管理，不會自動重新啟動）');
    // 先讓這個回應送出去，再走與 SIGTERM 相同的關閉流程（寫出播放快照、用量紀錄、操作紀錄）
    setTimeout(() => requestShutdown('管理面板的重新啟動要求'), RESTART_DELAY_MS);
    return { supervised };
  });

  // ── 操作紀錄 ─────────────────────────────────────────────
  router.get('/api/audit', ({ query }) => {
    const before = Number.parseInt(query.get('before') ?? '', 10);
    const limit = Math.min(200, Math.max(1, Number.parseInt(query.get('limit') ?? '100', 10) || 100));
    return { entries: audit.list({ before: Number.isFinite(before) ? before : Infinity, limit }) };
  });
};
