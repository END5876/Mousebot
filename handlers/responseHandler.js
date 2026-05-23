const { SlashCommandBuilder } = require('discord.js');
const fs   = require('fs');
const path = require('path');

// ── 常數 ────────────────────────────────────────────────
const ALLOWED_USER_ID = '598054316510806017';
const DATA_PATH = path.join(__dirname, '../data/responses.json');

// ── 讀寫 JSON ────────────────────────────────────────────
function loadResponses() {
  const raw = fs.readFileSync(DATA_PATH, 'utf-8');
  return JSON.parse(raw);
}

function saveResponses(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// ── 權限檢查 ─────────────────────────────────────────────
function isAllowed(userId) {
  return userId === ALLOWED_USER_ID;
}

// ── 設定 ─────────────────────────────────────────────────
function setupCustomResponses(client) {

  // ── 訊息監聽 ───────────────────────────────────────────
  client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const content = message.content;
    const responses = loadResponses();

    // 完全匹配
    if (content in responses.exact) {
      const response = responses.exact[content];
      if (Array.isArray(response)) {
        for (const msg of response) {
          await message.channel.send(msg);
        }
      } else {
        await message.channel.send(response);
      }
      console.log(`🎯 觸發完全匹配回應: "${content}"`);
      return;
    }

    // 包含匹配
    for (const [keyword, response] of Object.entries(responses.contains)) {
      if (content.includes(keyword)) {
        await message.channel.send(response);
        console.log(`🎯 觸發包含匹配回應: "${keyword}"`);
        return;
      }
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
        .setAutocomplete(true)   // ← 改這裡
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
            ephemeral: true
          });
        }
      }

      const responses = loadResponses();

      // ── add ─────────────────────────────────────────────
      if (sub === 'add') {
        const type    = interaction.options.getString('type');
        const keyword = interaction.options.getString('keyword');
        const rawResp = interaction.options.getString('response');

        const parts = rawResp.split('|').map(s => s.trim()).filter(s => s.length > 0);
        const value = parts.length === 1 ? parts[0] : parts;

        const isUpdate = keyword in responses[type];
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
          ephemeral: true
        });
      }

      // ── remove ──────────────────────────────────────────
      if (sub === 'remove') {
        const type    = interaction.options.getString('type');
        const keyword = interaction.options.getString('keyword');

        if (!(keyword in responses[type])) {
          return interaction.reply({
            content: `❌ 找不到 **${type}** 中的關鍵字：\`${keyword}\``,
            ephemeral: true
          });
        }

        delete responses[type][keyword];
        saveResponses(responses);

        return interaction.reply({
          content: `🗑️ 已刪除 **${type}** 規則：\`${keyword}\``,
          ephemeral: true
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

        return interaction.reply({ content, ephemeral: true });
      }
    }
  });
}

module.exports = { setupCustomResponses };