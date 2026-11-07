'use strict';
// AI 工具：分帳（查自己的餘額、用一句話新增一筆平分的花費）。
//
// 🔒 隱私：/splitbill 面板是 ephemeral，只有本人看得到；AI 的回覆卻是公開訊息。
//    所以查詢只回「發言者自己」的淨額與跟他有關的轉帳，不列出其他人之間的帳。
// 🔒 寫入：新增花費不直接寫入，而是在頻道送出一張確認卡，只有發言者本人按「確認」才記帳（5 分鐘內有效）。
//    帳目格式與面板的「全體平分／部分成員平分」完全相同（expenseCompletion.js 的 completeExpenseLogging）。

const { Type } = require('@google/genai');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ComponentType, MessageFlags } = require('discord.js');
const splitbillClient = require('../../splitbill/utils/splitbillClient');
const { calcNetBalances, equalSplit, fetchRealTimeRate, round2 } = require('../../splitbill/utils/calculator');
const { simplifyDebts } = require('../../splitbill/utils/settlement');
const { findMemberByDiscordId, memberDisplay, isCurrencyCode } = require('../../splitbill/utils/tripHelper');
const logger = require('../../../utils/logger');
const { md } = require('../../../utils/markdown');
const { fail } = require('./toolError');

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_DESCRIPTION = 50;
const SELF_WORDS = new Set(['我', '我自己', '自己', 'me', 'myself']);
const ALL_WORDS = new Set(['全部', '全體', '大家', '所有人', 'all', 'everyone']);

/** 發言者目前的作用行程，且必須是成員（Bot 擁有者也一樣：回覆是公開的，不破例） */
async function resolveMyTrip(ctx) {
    if (!splitbillClient.isConfigured()) fail('分帳服務沒有設定，這台 Bot 不能用分帳功能');
    const { trip } = await splitbillClient.resolveTrip(ctx.guild.id, null, ctx.userId);
    if (!trip) fail('使用者還沒有選擇行程，請先用 /splitbill 建立或選一個行程');
    const me = findMemberByDiscordId(trip, ctx.userId);
    if (!me) fail(`使用者不是行程「${trip.name}」的成員（或 Discord 帳號還沒連結到成員）`);
    return { trip, me };
}

const fmt = (n, currency) => `${round2(n)} ${currency}`;

// ════════════════════════════════════════════════════════
//  查詢自己的餘額
// ════════════════════════════════════════════════════════
async function myBalance(ctx) {
    const { trip, me } = await resolveMyTrip(ctx);
    const base = trip.baseCurrency;
    const net = calcNetBalances(trip);
    const mine = net[me.id] ?? 0;
    const transfers = simplifyDebts(net).filter(t => t.from === me.id || t.to === me.id);

    const lines = [`行程「${trip.name}」（基準幣 ${base}，共 ${trip.expenses.length} 筆帳）`];
    if (Math.abs(mine) < 0.01) lines.push('使用者的帳已經平了，不欠人也沒人欠他');
    else if (mine > 0) lines.push(`使用者總共代墊比較多，別人合計還要給他 ${fmt(mine, base)}`);
    else lines.push(`使用者合計還要付出 ${fmt(-mine, base)}`);

    for (const t of transfers) {
        lines.push(t.from === me.id
            ? `建議：使用者轉 ${fmt(t.amount, base)} 給 ${memberDisplay(trip, t.to)}`
            : `建議：${memberDisplay(trip, t.from)} 轉 ${fmt(t.amount, base)} 給使用者`);
    }
    return lines.join('\n');
}

// ════════════════════════════════════════════════════════
//  新增花費（送確認卡）
// ════════════════════════════════════════════════════════
const norm = (s) => String(s || '').trim().toLowerCase().replace(/^@/, '');

/** 用名字找行程成員：行程裡的成員名稱，或已連結成員的 Discord 名稱／暱稱 */
function findMemberByName(trip, guild, name) {
    const q = norm(name);
    if (!q) return null;
    const discordNames = (m) => {
        const gm = m.discordId ? guild.members.cache.get(m.discordId) : null;
        return gm ? [gm.user.username, gm.user.globalName, gm.displayName] : [];
    };
    const candidates = trip.members.map(m => ({ m, names: [m.name, ...discordNames(m)].filter(Boolean).map(norm) }));
    return candidates.find(c => c.names.includes(q))?.m
        ?? candidates.find(c => c.names.some(n => n.includes(q) || q.includes(n)))?.m
        ?? null;
}

function resolvePeople(trip, ctx, me, names) {
    const missing = [];
    const ids = [];
    for (const raw of names) {
        const member = SELF_WORDS.has(norm(raw)) ? me : findMemberByName(trip, ctx.guild, raw);
        if (member) { if (!ids.includes(member.id)) ids.push(member.id); } else missing.push(raw);
    }
    if (missing.length) {
        fail(`行程「${trip.name}」裡找不到：${missing.join('、')}。行程成員有：${trip.members.map(m => m.name).join('、')}`);
    }
    return ids;
}

async function resolveRate(trip, currency) {
    if (currency === trip.baseCurrency) return { rate: 1, source: '基準幣別' };
    const live = await fetchRealTimeRate(currency, trip.baseCurrency).catch(() => null);
    if (typeof live === 'number' && live > 0) return { rate: live, source: '網路即時' };
    const preset = trip.rates?.[currency];
    if (typeof preset === 'number' && preset > 0) return { rate: preset, source: '行程預設' };
    fail(`查不到 ${currency} 對 ${trip.baseCurrency} 的匯率，請改用 /splitbill 手動輸入匯率`);
}

/** 與 completeExpenseLogging 相同：平分有進位差額時補到第一位代墊人，總額跟著調整 */
function buildExpense({ id, description, amount, currency, rate, rateSource, payerId, participantIds, createdBy }) {
    const shares = equalSplit(amount, participantIds);
    const total = shares.reduce((sum, s) => sum + s.share, 0);
    const finalAmount = total > amount ? total : amount;
    return {
        id,
        description,
        amount: finalAmount,
        currency,
        exchangeRate: rate,
        rateSource,
        amountInBase: Math.round((finalAmount * rate + Number.EPSILON) * 100) / 100,
        payers: [{ userId: payerId, amount: finalAmount }],
        participants: shares.map(s => ({ userId: s.userId, amount: s.share })),
        createdAt: Date.now(),
        createdBy,
    };
}

function summarize(trip, exp) {
    const each = exp.participants.map(p => `${memberDisplay(trip, p.userId)} ${fmt(p.amount, exp.currency)}`).join('、');
    const baseNote = exp.currency === trip.baseCurrency ? '' : `（約 ${fmt(exp.amountInBase, trip.baseCurrency)}，匯率 ${exp.exchangeRate}／${exp.rateSource}）`;
    return {
        what: `${exp.description} ${fmt(exp.amount, exp.currency)}${baseNote}`,
        payer: memberDisplay(trip, exp.payers[0].userId),
        each,
    };
}

async function addExpense(ctx, args) {
    if (!ctx.textChannel?.send) fail('這裡沒辦法顯示確認按鈕，請改用 /splitbill 記帳');
    const description = String(args.description || '').trim().slice(0, MAX_DESCRIPTION);
    if (!description) fail('沒有說這筆花費是什麼');
    const amount = round2(Number(args.amount));
    if (!Number.isFinite(amount) || amount <= 0) fail('金額要是大於 0 的數字');

    const { trip, me } = await resolveMyTrip(ctx);
    const currency = String(args.currency || trip.baseCurrency).trim().toUpperCase();
    if (!isCurrencyCode(currency)) fail(`看不懂幣別「${args.currency}」，請用 TWD、JPY 這類三碼代號`);

    const payerId = args.payer ? resolvePeople(trip, ctx, me, [args.payer])[0] : me.id;
    const names = Array.isArray(args.participants) ? args.participants.map(String).filter(s => s.trim()) : [];
    const participantIds = !names.length || names.some(n => ALL_WORDS.has(norm(n)))
        ? trip.members.map(m => m.id)
        : resolvePeople(trip, ctx, me, names);

    const { rate, source } = await resolveRate(trip, currency);
    const draft = buildExpense({
        id: `id_${Date.now().toString(36)}`,
        description, amount, currency, rate, rateSource: source,
        payerId, participantIds, createdBy: ctx.userId,
    });
    const s = summarize(trip, draft);

    const confirmId = `aitool_sb_ok_${draft.id}`;
    const cancelId  = `aitool_sb_no_${draft.id}`;
    const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle('🧾 確認記帳')
        .setDescription(
            `行程：**${md(trip.name)}**\n項目：**${md(s.what)}**\n代墊：**${md(s.payer)}**\n分攤：${md(s.each)}`
        )
        .setFooter({ text: '只有提出的人可以按，5 分鐘內有效' });
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(confirmId).setLabel('確認記帳').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(cancelId).setLabel('取消').setStyle(ButtonStyle.Secondary),
    );
    const card = await ctx.textChannel.send({ content: `<@${ctx.userId}>`, embeds: [embed], components: [row], allowedMentions: { users: [ctx.userId] } });

    const collector = card.createMessageComponentCollector({ componentType: ComponentType.Button, time: CONFIRM_TIMEOUT_MS });
    collector.on('collect', async (i) => {
        if (i.user.id !== ctx.userId) {
            await i.reply({ content: '只有提出這筆帳的人可以確認', flags: MessageFlags.Ephemeral }).catch(() => {});
            return;
        }
        collector.stop('handled');
        if (i.customId === cancelId) {
            await i.update({ content: '已取消這筆記帳', embeds: [embed.setColor(0x95a5a6)], components: [] }).catch(() => {});
            return;
        }
        await i.deferUpdate().catch(() => {});
        try {
            await commitExpense(ctx, trip.id, draft);
            await card.edit({ content: '✅ 記帳成功', embeds: [embed.setColor(0x2ecc71).setTitle('🧾 已記帳').setFooter(null)], components: [] });
        } catch (err) {
            logger.warn('AITool', `AI 記帳寫入失敗：${err.message}`);
            await card.edit({ content: `❌ 記帳失敗：${err.message}`, components: [] }).catch(() => {});
        }
    });
    collector.on('end', (_, reason) => {
        if (reason === 'handled') return;
        card.edit({ content: '⌛ 確認逾時，這筆沒有記帳', components: [] }).catch(() => {});
    });

    return `已送出記帳確認卡：${s.what}，代墊 ${s.payer}，分攤 ${s.each}。使用者按下「確認記帳」才會真的記錄`;
}

/** 按下確認時重新讀取行程：成員可能已被移除，或使用者已經不是成員 */
async function commitExpense(ctx, tripId, draft) {
    const trip = await splitbillClient.resolveTripById(ctx.guild.id, tripId);
    if (!trip) throw new Error('找不到原本的行程（可能已被刪除）');
    if (!findMemberByDiscordId(trip, ctx.userId)) throw new Error('你已經不是這個行程的成員');
    const memberIds = new Set(trip.members.map(m => m.id));
    const involved = [draft.payers[0].userId, ...draft.participants.map(p => p.userId)];
    if (involved.some(id => !memberIds.has(id))) throw new Error('有成員已經不在行程裡，請重新提出');

    trip.expenses.push({ ...draft, createdAt: Date.now() });
    await splitbillClient.saveTrip(ctx.guild.id, trip.id, trip, { actorId: ctx.userId });
}

// ════════════════════════════════════════════════════════
//  宣告
// ════════════════════════════════════════════════════════
const tools = [
    {
        declaration: {
            name: 'splitbill_my_balance',
            description: '查詢使用者自己在目前分帳行程裡的餘額：他還要付多少、別人欠他多少、建議怎麼轉帳。只能查發言者本人。',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        label: '查分帳',
        run: myBalance,
    },
    {
        declaration: {
            name: 'splitbill_add_expense',
            description: '在使用者目前的分帳行程新增一筆「平分」的花費。使用者明確說要記帳、說某人付了一筆錢要大家分時才呼叫。'
                + '不會直接寫入，會先送確認卡給使用者按。',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    description: { type: Type.STRING, description: '花費項目，例如「晚餐」「計程車」' },
                    amount: { type: Type.NUMBER, description: '總金額（數字）' },
                    currency: { type: Type.STRING, description: '三碼幣別代號，例如 TWD、JPY、USD。使用者沒說就省略（用行程的基準幣）。日幣=JPY、台幣/元/塊=省略' },
                    payer: { type: Type.STRING, description: '誰付的錢（名字）。使用者自己付的就省略或填「我」' },
                    participants: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: '要分攤的人的名字，包含付錢的人自己要分的話也要列。全部行程成員一起分就省略',
                    },
                },
                required: ['description', 'amount'],
            },
        },
        label: '記帳',
        run: addExpense,
    },
];

// AI 工具的預篩關鍵字（tools/index.js 的 needsTools 用）：召回率優先，精準度交給判斷階段
const keywords = [
    '分帳', '記帳', '帳', '付', '欠', '還錢', '請客', '花了', '多少錢', '行程',
    '\\d\\s*(元|塊|圓|円|日幣|日圓|美金|台幣|twd|jpy|usd)',
];

module.exports = { tools, keywords, _buildExpense: buildExpense, _findMemberByName: findMemberByName };
