// utils/commandSync.js
// Slash Commands 同步策略。
//
// 過去每次開機都對全域 applicationCommands 做一次 PUT：
//   - 頻繁重啟（uncaughtException → supervisord 重啟）時容易撞到 Discord 的指令註冊 rate limit
//   - 全域指令的變更要一段時間才會在所有客戶端生效，開發時改完看不到效果
//
// 現在：
//   - 把要註冊的指令 JSON 算出 hash，與上次成功註冊的 hash（data/commandHash.json）比對，
//     沒有變動就跳過 PUT
//   - 設定 DEV_GUILD_ID 時改註冊到該伺服器（guild 指令立即生效），適合開發測試
//   - FORCE_COMMAND_SYNC=1 可強制重新註冊（例如懷疑 Discord 端與本機紀錄不一致時）

const crypto = require('crypto');
const path = require('path');
const { REST, Routes } = require('discord.js');
const { readJson, writeJsonAtomic } = require('./jsonStore');

const HASH_PATH = path.join(__dirname, '..', 'data', 'commandHash.json');

/** 物件 key 排序後再序列化，確保相同內容永遠得到相同 hash */
function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort()
            .filter(k => value[k] !== undefined)
            .map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

function hashCommands(commands) {
    const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));
    return crypto.createHash('sha256').update(stableStringify(sorted)).digest('hex');
}

/**
 * @param {object} opts
 * @param {object[]} opts.commands    已 toJSON() 的指令定義
 * @param {string} opts.token
 * @param {string} opts.clientId
 * @param {string} [opts.devGuildId]  有值時註冊為該伺服器的 guild 指令
 * @param {boolean} [opts.force]
 * @returns {Promise<{ skipped: boolean, scope: string, count: number }>}
 */
async function syncCommands({ commands, token, clientId, devGuildId, force = false }) {
    const scope = devGuildId ? `guild:${devGuildId}` : 'global';
    const key = `${clientId}:${scope}`;
    const hash = hashCommands(commands);

    const saved = readJson(HASH_PATH, {}) || {};
    if (!force && saved[key] === hash) {
        return { skipped: true, scope, count: commands.length };
    }

    const rest = new REST({ version: '10' }).setToken(token);
    const route = devGuildId
        ? Routes.applicationGuildCommands(clientId, devGuildId)
        : Routes.applicationCommands(clientId);
    await rest.put(route, { body: commands });

    writeJsonAtomic(HASH_PATH, { ...saved, [key]: hash });
    return { skipped: false, scope, count: commands.length };
}

module.exports = { syncCommands, hashCommands, stableStringify };
