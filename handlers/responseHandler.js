const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const logger = require('../utils/logger');
const fs   = require('fs');
const path = require('path');
const bootSummary = require('../utils/bootSummary');
const { writeJsonAtomic } = require('../utils/jsonStore');
const { isOwner } = require('../utils/config');

// ── 常數 ────────────────────────────────────────────────
const DATA_PATH = path.join(__dirname, '../data/responses.json');

// ── 讀寫 JSON ────────────────────────────────────────────
// 記憶體快取：messageCreate 對「每一則訊息」都會呼叫 loadResponses()，
// 原本每次都同步讀檔＋JSON.parse，會卡住事件迴圈。改成快取，
// 並每 5 秒用 mtime 檢查一次檔案是否被外部手動修改。
const CACHE_CHECK_MS = 5000;
let cache = null;
let cacheMtime = 0;
let lastCheck = 0;

function emptyResponses() {
  return { exact: {}, contains: {} };
}

function loadResponses() {
  const now = Date.now();
  if (cache && now - lastCheck < CACHE_CHECK_MS) return cache;
  lastCheck = now;

  try {
    const mtime = fs.statSync(DATA_PATH).mtimeMs;
    if (cache && mtime === cacheMtime) return cache;
    const parsed = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
    cache = {
      exact: parsed.exact && typeof parsed.exact === 'object' ? parsed.exact : {},
      contains: parsed.contains && typeof parsed.contains === 'object' ? parsed.contains : {},
    };
    cacheMtime = mtime;
  } catch (err) {
    if (err.code === 'ENOENT') {
      cache = cache || emptyResponses();
    } else if (!cache) {
      throw err; // 第一次載入就壞掉：讓啟動摘要回報 warn
    } else {
      logger.warn('Response', 'responses.json 讀取失敗，沿用記憶體中的舊版本:', err.message);
    }
  }
  return cache;
}

// 原子寫入（暫存檔 + rename），避免寫到一半被讀到或程序中斷造成檔案損毀
function saveResponses(data) {
  writeJsonAtomic(DATA_PATH, data);
  cache = data;
  cacheMtime = fs.statSync(DATA_PATH).mtimeMs;
  lastCheck = Date.now();
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// 找出訊息觸發的自訂回應；沒有匹配時回傳 null
// （aiHandler 的隨機回覆也會呼叫，用來避免同一則訊息同時觸發兩種回應）
function findResponse(content) {
  if (!content) return null;
  const responses = loadResponses();

  // 完全匹配（用 hasOwn：避免訊息內容是 "constructor"、"toString" 等原型鏈屬性名時誤觸發）
  if (hasOwn(responses.exact, content)) {
    return { type: 'exact', keyword: content, response: responses.exact[content] };
  }

  // 包含匹配
  for (const [keyword, response] of Object.entries(responses.contains)) {
    if (content.includes(keyword)) return { type: 'contains', keyword, response };
  }
  return null;
}

function hasCustomResponse(content) {
  try {
    return findResponse(content) !== null;
  } catch {
    return false;
  }
}

async function sendResponse(channel, response) {
  const list = Array.isArray(response) ? response : [response];
  for (const msg of list) await channel.send(msg);
}

// ── 管理面板用的讀寫 API ─────────────────────────────────
// 在副本上修改、寫檔成功才換掉快取：寫入失敗時記憶體維持原狀
const RESPONSE_TYPES = ['exact', 'contains'];

/** 整份規則的副本（呼叫端可以隨意修改） */
function listResponses() {
  return structuredClone(loadResponses());
}

/**
 * 新增或更新一條規則；from 與目標不同時視為改名或換類型（刪掉原本那條）。
 * 目標關鍵字已存在、又不是在編輯它本身時，丟出 code = 'EEXIST' 的錯誤（overwrite 為 true 則直接覆蓋）。
 * @param {{ type: string, keyword: string, value: string|string[],
 *           from?: { type: string, keyword: string } | null, overwrite?: boolean }} rule
 * @returns {{ created: boolean }}
 */
function upsertResponse({ type, keyword, value, from = null, overwrite = false }) {
  if (!RESPONSE_TYPES.includes(type)) throw new Error(`未知的匹配類型：${type}`);
  if (!keyword || keyword === '__proto__') throw new Error('關鍵字不可為空，也不能使用保留字');

  const next = listResponses();
  const editingSelf = from && from.type === type && from.keyword === keyword;
  const exists = hasOwn(next[type], keyword);
  if (exists && !editingSelf && !overwrite) {
    throw Object.assign(new Error(`${type === 'exact' ? '完全匹配' : '包含匹配'}已經有「${keyword}」這條規則`), { code: 'EEXIST' });
  }

  if (from && !editingSelf && RESPONSE_TYPES.includes(from.type)) delete next[from.type][from.keyword];
  next[type][keyword] = value;
  saveResponses(next);
  return { created: !exists && !from };
}

/** 刪除一條規則；不存在時回傳 false */
function removeResponse(type, keyword) {
  if (!RESPONSE_TYPES.includes(type)) throw new Error(`未知的匹配類型：${type}`);
  const next = listResponses();
  if (!hasOwn(next[type], keyword)) return false;
  delete next[type][keyword];
  saveResponses(next);
  return true;
}

// ── 權限檢查 ─────────────────────────────────────────────
function isAllowed(userId) {
  return isOwner(userId);
}

// ── 設定 ─────────────────────────────────────────────────
function setupCustomResponses(client) {

  // ── 訊息監聽 ───────────────────────────────────────────
  client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const content = message.content;
    if (!content) return;

    try {
      const match = findResponse(content);
      if (!match) return;

      // 值可能是用 | 分隔產生的陣列，需逐則送出
      await sendResponse(message.channel, match.response);
      logger.info('Response', `🎯 觸發${match.type === 'exact' ? '完全' : '包含'}匹配回應: "${match.keyword}"`);
    } catch (err) {
      logger.error('Response', '自動回應處理失敗:', err.message);
    }
  });

  // ── 註冊 Slash Command ─────────────────────────────────
  const command = new SlashCommandBuilder()
    .setName('response')
    .setDescription('管理自動回應規則')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

    // /response add
    .addSubcommand(sub => sub
      .setName('add')
      .setDescription('新增自動回應規則')
      .addStringOption(opt => opt
        .setName('type')
        .setDescription('匹配類型')
        .setRequired(true)
        .addChoices(
          { name: '完全匹配 (exact)', value: 'exact' },
          { name: '包含匹配 (contains)', value: 'contains' }
        )
      )
      .addStringOption(opt => opt
        .setName('keyword')
        .setDescription('觸發關鍵字')
        .setRequired(true)
      )
      .addStringOption(opt => opt
        .setName('response')
        .setDescription('回應內容，多則訊息用 | 分隔')
        .setRequired(true)
      )
    )

    // /response remove（keyword 改為 autocomplete）
    .addSubcommand(sub => sub
      .setName('remove')
      .setDescription('刪除自動回應規則')
      .addStringOption(opt => opt
        .setName('type')
        .setDescription('匹配類型')
        .setRequired(true)
        .addChoices(
          { name: '完全匹配 (exact)', value: 'exact' },
          { name: '包含匹配 (contains)', value: 'contains' }
        )
      )
      .addStringOption(opt => opt
        .setName('keyword')
        .setDescription('要刪除的關鍵字（輸入可篩選）')
        .setRequired(true)
        .setAutocomplete(true)
      )
    )

    // /response list
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('列出所有自動回應規則')
      .addStringOption(opt => opt
        .setName('type')
        .setDescription('篩選類型（不填則顯示全部）')
        .setRequired(false)
        .addChoices(
          { name: '完全匹配 (exact)', value: 'exact' },
          { name: '包含匹配 (contains)', value: 'contains' }
        )
      )
    );

  client.commands.set(command.name, {
    data: command,

    // ── Autocomplete 處理 ──────────────────────────────
    async autocomplete(interaction) {
      const sub = interaction.options.getSubcommand();
      if (sub !== 'remove') return;

      const type    = interaction.options.getString('type');
      const focused = interaction.options.getFocused().toLowerCase();

      if (!type) return interaction.respond([]);

      const responses = loadResponses();
      const keywords  = Object.keys(responses[type] ?? {});

      // 篩選符合輸入的關鍵字，最多 25 筆
      const filtered = keywords
        .filter(kw => kw.toLowerCase().includes(focused))
        .slice(0, 25)
        .map(kw => ({ name: kw, value: kw }));

      await interaction.respond(filtered);
    },

    async execute(interaction) {
      const sub = interaction.options.getSubcommand();

      // ── /response add & remove 需要權限 ────────────────
      if (sub === 'add' || sub === 'remove') {
        if (!isAllowed(interaction.user.id)) {
          return interaction.reply({
            content: '❌ 你沒有權限使用此指令。',
            flags: MessageFlags.Ephemeral
          });
        }
      }

      const responses = loadResponses();

      // ── add ─────────────────────────────────────────────
      if (sub === 'add') {
        const type    = interaction.options.getString('type');
        const keyword = interaction.options.getString('keyword');
        const rawResp = interaction.options.getString('response');

        if (keyword === '__proto__') {
          return interaction.reply({ content: '❌ 此關鍵字為保留字，無法使用。', flags: MessageFlags.Ephemeral });
        }

        const parts = rawResp.split('|').map(s => s.trim()).filter(s => s.length > 0);
        const value = parts.length === 1 ? parts[0] : parts;

        const isUpdate = hasOwn(responses[type], keyword);
        responses[type][keyword] = value;
        saveResponses(responses);

        const preview = Array.isArray(value)
          ? value.map((v, i) => `\`${i + 1}.\` ${v}`).join('\n')
          : `\`${value}\``;

        return interaction.reply({
          content: [
            `${isUpdate ? '✏️ 已更新' : '✅ 已新增'} **${type}** 規則：`,
            `> 關鍵字：\`${keyword}\``,
            `> 回應：\n${preview}`
          ].join('\n'),
          flags: MessageFlags.Ephemeral
        });
      }

      // ── remove ──────────────────────────────────────────
      if (sub === 'remove') {
        const type    = interaction.options.getString('type');
        const keyword = interaction.options.getString('keyword');

        if (!hasOwn(responses[type], keyword)) {
          return interaction.reply({
            content: `❌ 找不到 **${type}** 中的關鍵字：\`${keyword}\``,
            flags: MessageFlags.Ephemeral
          });
        }

        delete responses[type][keyword];
        saveResponses(responses);

        return interaction.reply({
          content: `🗑️ 已刪除 **${type}** 規則：\`${keyword}\``,
          flags: MessageFlags.Ephemeral
        });
      }

      // ── list ────────────────────────────────────────────
      if (sub === 'list') {
        const filterType = interaction.options.getString('type');
        const types = filterType ? [filterType] : ['exact', 'contains'];

        const lines = [];

        for (const t of types) {
          const entries = Object.entries(responses[t]);
          lines.push(`\n**── ${t === 'exact' ? '完全匹配' : '包含匹配'} (${entries.length} 筆) ──**`);

          if (entries.length === 0) {
            lines.push('> *（無規則）*');
            continue;
          }

          for (const [kw, resp] of entries) {
            const preview = Array.isArray(resp)
              ? `[${resp.length} 則] ${resp[0]}...`
              : resp.length > 30 ? resp.slice(0, 30) + '...' : resp;
            lines.push(`> \`${kw}\` → ${preview}`);
          }
        }

        let content = `📋 **自動回應規則列表**${lines.join('\n')}`;
        if (content.length > 1900) {
          content = content.slice(0, 1900) + '\n\n*...內容過長，已截斷*';
        }

        return interaction.reply({
          content,
          flags: MessageFlags.Ephemeral
        });
      }
    }
  });

  // ── 開機摘要 ─────────────────────────────────────────────
  try {
    const responses = loadResponses();
    const exactCount    = Object.keys(responses.exact ?? {}).length;
    const containsCount = Object.keys(responses.contains ?? {}).length;
    bootSummary.report(
      '自訂回應 (/response)',
      'ok',
      `完全匹配 ${exactCount} 筆、包含匹配 ${containsCount} 筆`
    );
  } catch (err) {
    bootSummary.report('自訂回應 (/response)', 'warn', `讀取 responses.json 失敗: ${err.message}`);
  }
}

module.exports = { setupCustomResponses, hasCustomResponse, listResponses, upsertResponse, removeResponse };