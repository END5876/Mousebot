const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const bootSummary = require('../utils/bootSummary');
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
      console.warn('⚠️ [Response] responses.json 讀取失敗，沿用記憶體中的舊版本:', err.message);
    }
  }
  return cache;
}

// 原子寫入（暫存檔 + rename），避免寫到一半被讀到或程序中斷造成檔案損毀
function saveResponses(data) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  const tmp = `${DATA_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, DATA_PATH);
  cache = data;
  cacheMtime = fs.statSync(DATA_PATH).mtimeMs;
  lastCheck = Date.now();
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

async function sendResponse(channel, response) {
  const list = Array.isArray(response) ? response : [response];
  for (const msg of list) await channel.send(msg);
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
      const responses = loadResponses();

      // 完全匹配（用 hasOwn：避免訊息內容是 "constructor"、"toString" 等原型鏈屬性名時誤觸發）
      if (hasOwn(responses.exact, content)) {
        await sendResponse(message.channel, responses.exact[content]);
        console.log(`🎯 觸發完全匹配回應: "${content}"`);
        return;
      }

      // 包含匹配（值可能是用 | 分隔產生的陣列，需逐則送出）
      for (const [keyword, response] of Object.entries(responses.contains)) {
        if (content.includes(keyword)) {
          await sendResponse(message.channel, response);
          console.log(`🎯 觸發包含匹配回應: "${keyword}"`);
          return;
        }
      }
    } catch (err) {
      console.error('❌ [Response] 自動回應處理失敗:', err.message);
    }
  });

  // ── 註冊 Slash Command ─────────────────────────────────
  const command = new SlashCommandBuilder()
    .setName('response')
    .setDescription('管理自動回應規則')

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

module.exports = { setupCustomResponses };