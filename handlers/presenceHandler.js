// handlers/presenceHandler.js
// Bot 的線上狀態（線上 / 閒置 / 請勿打擾 / 隱身）與活動文字（正在聽…），存在 data/presence.json，
// 由管理面板修改。沒有設定檔時沿用原本寫死在 index.js 的狀態。

const path = require('path');
const { ActivityType } = require('discord.js');
const logger = require('../utils/logger');
const { readJson, writeJsonAtomic } = require('../utils/jsonStore');

const PRESENCE_PATH = path.join(__dirname, '..', 'data', 'presence.json');

const STATUSES = ['online', 'idle', 'dnd', 'invisible'];
// 直播（Streaming）需要 Twitch / YouTube 網址，這裡不提供
const ACTIVITY_TYPES = {
  none: null,
  playing: ActivityType.Playing,
  listening: ActivityType.Listening,
  watching: ActivityType.Watching,
  competing: ActivityType.Competing,
  custom: ActivityType.Custom,
};
const MAX_TEXT = 128;
const DEFAULT_PRESENCE = { status: 'online', type: 'listening', text: '逼逼 機油好難喝' };

function normalize(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  if (!STATUSES.includes(cfg.status) || !(cfg.type in ACTIVITY_TYPES)) return null;
  const text = typeof cfg.text === 'string' ? cfg.text.trim().slice(0, MAX_TEXT) : '';
  return { status: cfg.status, type: cfg.type, text };
}

function getPresenceConfig() {
  return normalize(readJson(PRESENCE_PATH, null)) ?? { ...DEFAULT_PRESENCE };
}

function toDiscordPresence({ status, type, text }) {
  const activityType = ACTIVITY_TYPES[type];
  if (activityType == null || !text) return { status, activities: [] };
  // 自訂狀態的文字放在 state；name 是 Discord 規定的固定值
  if (activityType === ActivityType.Custom) return { status, activities: [{ name: 'Custom Status', state: text, type: activityType }] };
  return { status, activities: [{ name: text, type: activityType }] };
}

/** 套用目前的設定（登入完成時、設定變更後呼叫） */
function applyPresence(client) {
  if (!client.user) return;
  const presence = toDiscordPresence(getPresenceConfig());
  client.user.setPresence(presence);
  // 斷線重新 identify 時沿用最新的狀態
  client.options.presence = presence;
}

/**
 * 儲存並立即套用
 * @param {{ status: string, type: string, text: string }} cfg
 */
function setPresenceConfig(client, cfg) {
  const next = normalize(cfg);
  if (!next) throw Object.assign(new Error('狀態或活動類型不正確'), { code: 'EINVAL' });
  if (next.type !== 'none' && !next.text) throw Object.assign(new Error('請輸入活動文字'), { code: 'EINVAL' });
  writeJsonAtomic(PRESENCE_PATH, next);
  applyPresence(client);
  logger.info('Presence', `已更新 Bot 狀態：${next.status}・${next.type} ${next.text}`);
  return next;
}

module.exports = { applyPresence, getPresenceConfig, setPresenceConfig, STATUSES, ACTIVITY_TYPES: Object.keys(ACTIVITY_TYPES) };
