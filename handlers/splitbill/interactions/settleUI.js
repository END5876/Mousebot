'use strict';

const C = require('../../../utils/embedColors'); // embed 色票（utils/embedColors.js）
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const splitbillClient = require('../utils/splitbillClient');
const { calcNetBalances, calcNetBalancesByCurrency, listTransfersByMember, getUsedCurrencies, fetchRealTimeRate, round2 } = require('../utils/calculator');
const { simplifyDebts } = require('../utils/settlement');
const { showMainMenu } = require('../commands/splitbill');
const { memberMention } = require('../utils/tripHelper');
const { addDeposit } = require('../utils/deposit');

const memberNameOf = (trip, id) => (trip.members.find((m) => m.id === id) || {}).name || '已移除的成員';

// 建議轉帳清單：每列「A ➡️ B：金額」，下面的選單「我已經付了…」選一列就能標記已付（跟網頁一樣新增一筆轉帳）
function renderTransferList(interaction, trip, alertMsg) {
  const transactions = simplifyDebts(calcNetBalances(trip));
  const base = trip.baseCurrency;
  const embed = new EmbedBuilder()
    .setColor(C.SPLITBILL)
    .setTitle(`🚀 「${trip.name}」建議轉帳（以 ${base} 計）`)
    .setDescription(transactions.length
      ? transactions.map((t, idx) => `**${idx + 1}.** ${memberMention(trip, t.from)} ➡️ ${memberMention(trip, t.to)}：**${round2(t.amount)} ${base}**`).join('\n')
      : '🎉 大家都結清了，不用再轉帳！');

  const components = [];
  if (transactions.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`set_select_paid::${trip.id}`)
        .setPlaceholder('我已經付了…')
        .addOptions(transactions.slice(0, 25).map((t) => ({
          label: `${memberNameOf(trip, t.from)} 付給 ${memberNameOf(trip, t.to)} ${round2(t.amount)} ${base}`.slice(0, 100),
          value: `${t.from}|${t.to}`,
        })))
    ));
  }
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('set_btn_transfer_live').setLabel('💱 換算成其他幣別').setStyle(ButtonStyle.Primary).setDisabled(!transactions.length),
    new ButtonBuilder().setCustomId('set_nav').setLabel('⬅️ 返回結算').setStyle(ButtonStyle.Secondary)
  ));
  return interaction.update({ content: alertMsg || '', embeds: [embed], components });
}

/**
 * 🆕【收支帳模式 v3】每人淨額明細呈現
 *
 * 設計原則：
 * 1. 每一行都用 ➕/➖ 明確標示「這筆讓淨額增加還是減少」，使用者可以
 *    自行驗算：淨額 = 所有➕ − 所有➖（換算成基準幣後）。
 * 2. 外幣金額一律附上換算成基準幣別後的等值（約 xx TWD），使用者不用
 *    自己查匯率，就能對照標題的數字是怎麼算出來的。
 * 3. 轉帳不再彙總成一個數字——彙總會讓「轉給了誰」這個關鍵資訊消失，
 *    交叉轉帳甚至可能互相抵銷、被誤讀成沒事發生。改成逐筆列出對象，
 *    見 formatTransferLines。
 * 4. 🆕 同一分類若同時有多個幣別（例如同時墊了 JPY／TWD／USD），不再用
 *    「、」串成一整行導致爆版，改成該分類展開成子項目，一個幣別一行。
 *
 * bucketsByCurrency 格式：{ [currency]: { paid, paidBase, share, shareBase, ... } }
 */
function formatExpenseSections(bucketsByCurrency, trip) {
  const categories = [
    { field: 'paid',  prefix: '➕', label: '幫大家先墊的錢' },
    { field: 'share', prefix: '➖', label: '自己該分攤的支出' },
  ];

  const sections = [];
  for (const { field, prefix, label } of categories) {
    const items = Object.entries(bucketsByCurrency || {})
      .filter(([, b]) => Math.abs(b[field] || 0) >= 0.01)
      .sort(([, a], [, b]) => (b[field] || 0) - (a[field] || 0))
      .map(([currency, b]) => {
        const amountText = `${round2(b[field])} ${currency}`;
        if (currency === trip.baseCurrency) return amountText;
        return `${amountText}（約 ${round2(b[`${field}Base`])} ${trip.baseCurrency}）`;
      });
    if (items.length) sections.push({ title: `${prefix} ${label}`, items });
  }
  return sections;
}

/**
 * 🆕 逐筆列出轉帳對象，取代舊版「轉帳給他人／收到他人轉帳」的彙總數字。
 */
function formatTransferLines(transfers, trip) {
  if (!transfers || !transfers.length) return [];
  return transfers.map(t => {
    const arrow = t.direction === 'out' ? '➕ 轉給' : '➖ 收到';
    const amountText = `${round2(t.amount)} ${t.currency}`;
    const baseText = t.currency === trip.baseCurrency ? '' : `（約 ${round2(t.amountInBase)} ${trip.baseCurrency}）`;
    // 🆕 備註改成獨立一行並縮排，而不是接在同一行尾端——手機寬度不夠時，
    // 原本接在句尾的備註很容易把整行撐到很晚才換行，閱讀起來斷得很突兀。
    const noteText = t.note ? `\n　　📝 ${t.note}` : '';
    return `${arrow} ${memberMention(trip, t.counterpartId)}：${amountText}${baseText}${noteText}`;
  });
}

/**
 * 🆕 把「分類區塊（sections，可能含多幣別子項）」與「轉帳明細（flatLines，單行字串）」
 * 混合組成樹狀結構（├/└）。
 *
 * - 分類若只有 1 個幣別 → 顯示成單行「標題：金額」
 * - 分類若有多個幣別 → 標題獨立一行，各幣別展開成子項目（避免單行過長）
 * - 只有 0～1 行且該行沒有子項目時，視為資訊量等同標題本身，省略以保持畫面乾淨
 */
function toTreeBlock(sections, flatLines) {
  const nodes = [
    ...sections.map(s => ({
      text: s.items.length === 1 ? `${s.title}：${s.items[0]}` : s.title,
      children: s.items.length > 1 ? s.items : null,
    })),
    ...flatLines.map(text => ({ text, children: null })),
  ];

  if (nodes.length === 0) return null;
  if (nodes.length === 1 && !nodes[0].children) return null;

  return nodes.map((node, idx) => {
    const isLast = idx === nodes.length - 1;
    const branch = isLast ? '└' : '├';
    let out = `　${branch} ${node.text}`;

    if (node.children) {
      const childIndent = isLast ? '　　' : '　│';
      out += '\n' + node.children.map((c, cidx) => {
        const cIsLast = cidx === node.children.length - 1;
        const cBranch = cIsLast ? '└' : '├';
        return `${childIndent}  ${cBranch} ${c}`;
      }).join('\n');
    }

    return out;
  }).join('\n');
}

// Embed 的 description 最多 4096 字：成員多、轉帳備註多的大行程整份淨額報表會超過，
// builder 直接丟錯整個畫面打不開，所以超過時以成員為單位分頁
const BALANCE_PAGE_MAX = 4000;
const BALANCE_SEPARATOR = '━━━━━━━━━━━━━━';

function cutText(text, max) {
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

function paginateBlocks(blocks, max) {
  const pages = [];
  let cur = [];
  let len = 0;
  for (const raw of blocks) {
    // 單一成員的明細本身就超過一頁時只能截斷
    const block = cutText(raw, max);
    if (cur.length && len + 2 + block.length > max) {
      pages.push(cur);
      cur = [];
      len = 0;
    }
    // 分隔線不放在頁首
    if (!cur.length && block === BALANCE_SEPARATOR) continue;
    len = cur.length ? len + 2 + block.length : block.length;
    cur.push(block);
  }
  if (cur.length) pages.push(cur);
  return pages.map(p => {
    // 也不放在頁尾
    while (p.length > 1 && p[p.length - 1] === BALANCE_SEPARATOR) p.pop();
    return p.join('\n\n');
  });
}

module.exports = {
  async handleButton(interaction, cache) {
    const { customId, guildId, user } = interaction;
    const { trip } = await splitbillClient.resolveTrip(guildId, null, user.id);
    if (customId === 'nav_main') {
      return showMainMenu(interaction);
    }

    if (customId === 'set_nav') {
      const embed = new EmbedBuilder()
        .setColor(C.SPLITBILL)
        .setTitle('📊 結算')
        .setDescription(`目前行程：**${trip.name}**\n要看什麼？`);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_btn_balance').setLabel('🟢 每個人要付或可拿回多少').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('set_btn_transfer').setLabel('🚀 建議轉帳').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('exp_btn_ledger_last__set').setLabel('📒 查看帳目清單').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('nav_main').setLabel('⬅️ 返回主選單').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    // 1. 每人收支淨額分佈（收支帳模式 v3：分組排序 + 附換算金額 + 多幣別自動換行 + 轉帳逐筆列出對象）
    if (customId === 'set_btn_balance' || customId.startsWith('set_btn_balance_p_')) {
      const net = calcNetBalances(trip);
      const netByCurrency = calcNetBalancesByCurrency(trip);
      const transfersByMember = listTransfersByMember(trip);

      const owing = [];
      const receiving = [];
      const settled = [];

      for (const m of (trip.members || [])) {
        const val = round2(net[m.id] || 0);
        if (Math.abs(val) < 0.01) settled.push(m);
        else if (val > 0) receiving.push({ m, val });
        else owing.push({ m, val });
      }

      // 依欠款/可收金額大小排序，最需要處理的人排最前面
      receiving.sort((a, b) => b.val - a.val);
      owing.sort((a, b) => a.val - b.val);

      const renderMember = ({ m, val }) => {
        const statusIcon = val > 0 ? '🟢' : '🔴';
        const actionText = val > 0 ? '可拿回' : '要付';
        const titleLine = `**${statusIcon} ${memberMention(trip, m.id)} ${actionText} ${round2(Math.abs(val))} ${trip.baseCurrency}**`;

        const sections = formatExpenseSections(netByCurrency[m.id], trip);
        const transferLines = formatTransferLines(transfersByMember[m.id], trip);
        const block = toTreeBlock(sections, transferLines);
        return block ? `${titleLine}\n${block}` : titleLine;
      };

      // 以「每位成員一塊」為單位組內容，太長時才能整塊分頁，不會把某個人的明細切成兩半
      const groups = [];
      if (owing.length) {
        const [first, ...rest] = owing.map(renderMember);
        groups.push([`**🔴 要付錢的人**\n\n${first}`, ...rest]);
      }
      if (receiving.length) {
        const [first, ...rest] = receiving.map(renderMember);
        groups.push([`**🟢 可以拿回錢的人**\n\n${first}`, ...rest]);
      }
      if (settled.length) {
        groups.push([`**⚪ 已結清**\n${settled.map(m => memberMention(trip, m.id)).join('、')} 不用付也不用拿回。`]);
      }

      // 金額其實是行程的基準幣別，不一定是 TWD
      const tip = `💡 金額都已依記帳當下的匯率換算成 ${trip.baseCurrency}。想知道誰該轉給誰？到「建議轉帳」看最省事的轉法。`;
      const blocks = [];
      groups.forEach((g, idx) => {
        if (idx > 0) blocks.push(BALANCE_SEPARATOR);
        blocks.push(...g);
      });
      if (blocks.length) blocks.push(tip);

      const pages = blocks.length ? paginateBlocks(blocks, BALANCE_PAGE_MAX) : ['還沒有成員。'];
      const pageMatch = /^set_btn_balance_p_(\d+)$/.exec(customId);
      const page = Math.min(pageMatch ? Number(pageMatch[1]) : 0, pages.length - 1);

      const embed = new EmbedBuilder()
        .setColor(C.SPLITBILL)
        .setTitle(`🟢 「${trip.name}」每個人要付或可拿回多少`)
        .setDescription(pages[page]);
      if (pages.length > 1) embed.setFooter({ text: `第 ${page + 1} / ${pages.length} 頁` });

      const row = new ActionRowBuilder();
      if (pages.length > 1) {
        row.addComponents(
          new ButtonBuilder().setCustomId(`set_btn_balance_p_${page - 1}`).setLabel('◀️ 上一頁').setStyle(ButtonStyle.Primary).setDisabled(page === 0),
          new ButtonBuilder().setCustomId(`set_btn_balance_p_${page + 1}`).setLabel('▶️ 下一頁').setStyle(ButtonStyle.Primary).setDisabled(page >= pages.length - 1)
        );
      }
      row.addComponents(
        new ButtonBuilder().setCustomId('set_nav').setLabel('⬅️ 返回結算選單').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [row] });
    }

    // 2. 建議轉帳清單（未變動）
    // set_btn_transfer::<tripId>：從「我已經付了…」的確認畫面按「還沒付」回來，用當時鎖定的行程
    if (customId === 'set_btn_transfer' || customId.startsWith('set_btn_transfer::')) {
      const target = customId.includes('::') ? await splitbillClient.resolveTripById(guildId, customId.split('::')[1]) : trip;
      if (!target) return interaction.reply({ content: '⚠️ 找不到行程（可能已被刪除）。', flags: MessageFlags.Ephemeral });
      return renderTransferList(interaction, target);
    }

    // 「我已經付了…」確認後：重新算一次建議轉帳（確認期間帳目可能變了），新增一筆轉帳
    if (customId.startsWith('set_paid_yes::')) {
      const [, tripId, fromId, toId] = customId.split('::');
      const pinned = await splitbillClient.resolveTripById(guildId, tripId);
      if (!pinned) return interaction.reply({ content: '⚠️ 找不到行程（可能已被刪除）。', flags: MessageFlags.Ephemeral });
      const t = simplifyDebts(calcNetBalances(pinned)).find((x) => x.from === fromId && x.to === toId);
      if (!t) return renderTransferList(interaction, pinned, 'ℹ️ 這筆已經結清，或金額剛剛變了，請看最新的建議轉帳。');
      const amount = round2(t.amount);
      addDeposit(pinned, { collectorId: toId, payerId: fromId, amount, currency: pinned.baseCurrency, note: '結算轉帳' });
      try {
        await splitbillClient.saveTrip(guildId, pinned.id, pinned, { actorId: user.id });
      } catch (err) {
        // 同時有人改了行程（例如連按兩下、或別人也剛好標記）：存檔被擋下，不會記兩次
        if (err.status !== 409) throw err;
        const fresh = await splitbillClient.resolveTripById(guildId, pinned.id);
        if (!fresh) return interaction.reply({ content: '⚠️ 找不到行程（可能已被刪除）。', flags: MessageFlags.Ephemeral });
        return renderTransferList(interaction, fresh, 'ℹ️ 行程剛剛被其他人更新了，這次沒有記錄。請看最新的建議轉帳，需要的話再標記一次。');
      }
      return renderTransferList(interaction, pinned, `✅ 已標記已付：${memberNameOf(pinned, fromId)}付給${memberNameOf(pinned, toId)} ${amount} ${pinned.baseCurrency}`);
    }

    // 2a. 選擇目標幣別（未變動）
    if (customId === 'set_btn_transfer_live') {
      const currencies = getUsedCurrencies(trip);

      if (!currencies.length) {
        return interaction.reply({ content: '📭 還沒有任何帳目，不需要換算。', flags: MessageFlags.Ephemeral });
      }

      const embed = new EmbedBuilder()
        .setColor(C.SPLITBILL)
        .setTitle('💱 選擇最終結算的統一幣別')
        .setDescription(
          `此行程目前使用過的幣別有：**${currencies.join('、')}**\n` +
          `要換算成哪一種幣別？\n\n` +
          `*💡 依今天的匯率換算，僅供參考，記好的帳目不會變。*`
        );

      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('set_select_convert_target')
          .setPlaceholder('選擇結算的目標幣別...')
          .addOptions(currencies.map(c => ({ label: c, value: c })))
      );

      const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_btn_transfer').setLabel('⬅️ 返回').setStyle(ButtonStyle.Secondary)
      );

      return interaction.update({ embeds: [embed], components: [selectRow, navRow] });
    }
  },

  async handleSelectMenu(interaction) {
    const { customId, guildId, values, user } = interaction;
    const { trip } = await splitbillClient.resolveTrip(guildId, null, user.id);

    // 「我已經付了…」：先確認（文字跟網頁的「標記已付」一樣）
    if (customId.startsWith('set_select_paid')) {
      const pinned = await splitbillClient.resolveTripById(guildId, customId.split('::')[1]);
      if (!pinned) return interaction.reply({ content: '⚠️ 找不到行程（可能已被刪除）。', flags: MessageFlags.Ephemeral });
      const [fromId, toId] = String(values[0] || '').split('|');
      const t = simplifyDebts(calcNetBalances(pinned)).find((x) => x.from === fromId && x.to === toId);
      if (!t) return renderTransferList(interaction, pinned, 'ℹ️ 這筆已經結清，或金額剛剛變了，請看最新的建議轉帳。');
      const embed = new EmbedBuilder().setColor(C.SPLITBILL)
        .setTitle(`${memberNameOf(pinned, fromId)}已經付給${memberNameOf(pinned, toId)} ${round2(t.amount)} ${pinned.baseCurrency} 了嗎？`)
        .setDescription('會新增一筆轉帳，結算結果也會跟著更新。');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`set_paid_yes::${pinned.id}::${fromId}::${toId}`).setLabel('標記已付').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`set_btn_transfer::${pinned.id}`).setLabel('還沒付').setStyle(ButtonStyle.Secondary)
      );
      return interaction.update({ content: '', embeds: [embed], components: [row] });
    }

    if (customId === 'set_select_convert_target') {
      const targetCurrency = values[0];
      await interaction.deferUpdate();

      // 跟網頁的結算頁同一套算法：先用基準幣別算出最精簡的轉帳，再整串乘上同一個匯率。
      // 匯率先查今天的即時匯率，查不到才用行程設定的匯率；兩邊都查不到就維持基準幣別
      const base = trip.baseCurrency;
      const baseTransactions = simplifyDebts(calcNetBalances(trip));
      let rate = 1;
      let rateNote = '';
      if (targetCurrency !== base) {
        const live = await fetchRealTimeRate(base, targetCurrency).catch(() => null);
        const tripRate = trip.rates && trip.rates[targetCurrency]; // 1 target = tripRate 基準幣
        if (live > 0) {
          rate = live;
          rateNote = `依今天的匯率 1 ${base} ≈ ${Number(live.toPrecision(4))} ${targetCurrency} 換算，僅供參考。`;
        } else if (tripRate > 0) {
          rate = 1 / tripRate;
          rateNote = `查不到今天的匯率，改用行程設定的匯率 1 ${targetCurrency} = ${tripRate} ${base} 換算，僅供參考。`;
        } else {
          rate = null;
          rateNote = `⚠️ 查不到 ${targetCurrency} 的匯率，下面仍以 ${base} 顯示。`;
        }
      }
      const shownCurrency = rate ? targetCurrency : base;
      const transactions = baseTransactions.map((t) => ({ ...t, amount: rate ? round2(t.amount * rate) : t.amount }));

      const embed = new EmbedBuilder()
        .setColor(C.SPLITBILL)
        .setTitle(`💱 「${trip.name}」轉帳建議（換算成 ${shownCurrency}，依今天匯率，僅供參考）`)
        .setDescription(
          (rateNote ? `${rateNote}\n\n` : '') +
          (transactions.length
            ? `**最精簡轉帳路線：**\n${transactions.map((t, idx) => `${idx + 1}. ${memberMention(trip, t.from)} ➡️ ${memberMention(trip, t.to)}：**${t.amount} ${shownCurrency}**`).join('\n')}`
            : '🎉 大家都結清了，不用再轉帳！')
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('set_btn_transfer_live').setLabel('🔄 重新選擇幣別').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('set_btn_transfer').setLabel('⬅️ 返回').setStyle(ButtonStyle.Secondary)
      );

      return interaction.editReply({ embeds: [embed], components: [row] });
    }
  }
};