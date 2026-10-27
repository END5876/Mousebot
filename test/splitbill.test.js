'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  round2, parseMoneyInput, formatMoneyDisplay, toBase, equalSplit,
  validateCustomSplit, validatePayers, calcNetBalances,
} = require('../handlers/splitbill/utils/calculator');
const { simplifyDebts } = require('../handlers/splitbill/utils/settlement');
const { parsePayerField, parseSplitField, extractMentionIds } = require('../handlers/splitbill/utils/parse');

const sum = arr => round2(arr.reduce((s, x) => s + x, 0));

test('round2 修正浮點誤差', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(-2.345), -2.34); // Math.round 對 .5 一律往正方向取整
});

test('parseMoneyInput 只接受合法的千分位格式', () => {
  assert.equal(parseMoneyInput('1000'), 1000);
  assert.equal(parseMoneyInput('1,000'), 1000);
  assert.equal(parseMoneyInput(' 12,345,678.9 '), 12345678.9);
  assert.equal(parseMoneyInput('0.0328'), 0.0328);
  for (const bad of ['1,00', '1,0000', '12,3456', '1e5', '1..2', 'abc', '', '-5', null]) {
    assert.ok(Number.isNaN(parseMoneyInput(bad)), `應拒絕 ${bad}`);
  }
});

test('formatMoneyDisplay 依幣別決定小數位數', () => {
  assert.equal(formatMoneyDisplay(1500, 'JPY'), '1,500');
  assert.equal(formatMoneyDisplay(1500.6, 'krw'), '1,501');
  assert.equal(formatMoneyDisplay(1500, 'TWD'), '1,500.00');
  assert.equal(formatMoneyDisplay(NaN, 'TWD'), null);
  assert.equal(formatMoneyDisplay(null, 'TWD'), null);
});

test('toBase 換算並在缺匯率時丟錯', () => {
  assert.equal(toBase(1000, 'JPY', { JPY: 0.215 }), 215);
  assert.throws(() => toBase(1, 'USD', {}), /找不到幣別 USD/);
  assert.throws(() => toBase(1, 'USD', { USD: 0 }), /找不到幣別 USD/);
});

test('equalSplit 分攤總和必等於原金額（餘數給最後一人）', () => {
  for (const [amount, n] of [[100, 3], [1, 3], [999.99, 7], [0.05, 2], [12345, 11]]) {
    const ids = Array.from({ length: n }, (_, i) => `u${i}`);
    const shares = equalSplit(amount, ids);
    assert.equal(shares.length, n);
    assert.equal(sum(shares.map(s => s.share)), round2(amount), `${amount} / ${n}`);
  }
  assert.throws(() => equalSplit(100, []), /不可為空/);
});

test('validateCustomSplit / validatePayers 容許 0.01 誤差', () => {
  assert.doesNotThrow(() => validateCustomSplit(100, [{ share: 33.33 }, { share: 33.33 }, { share: 33.34 }]));
  assert.throws(() => validateCustomSplit(100, [{ share: 50 }, { share: 49 }]), /不相符/);
  assert.doesNotThrow(() => validatePayers(100, [{ amount: 60 }, { amount: 40 }]));
  assert.throws(() => validatePayers(100, [{ amount: 60 }]), /不相符/);
});

test('calcNetBalances：淨額總和為 0，且含訂金抵銷', () => {
  const trip = {
    members: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
    expenses: [
      // A 付 300 TWD，三人平分
      { amount: 300, amountInBase: 300, payers: [{ userId: 'A', amount: 300 }],
        participants: [{ userId: 'A', share: 100 }, { userId: 'B', share: 100 }, { userId: 'C', share: 100 }] },
      // B 付 1000 JPY（= 215 TWD），A、B 平分
      { amount: 1000, amountInBase: 215, payers: [{ userId: 'B', amount: 1000 }],
        participants: [{ userId: 'A', share: 500 }, { userId: 'B', share: 500 }] },
    ],
    // C 先交 50 給 A 當訂金
    deposits: [{ payerId: 'C', collectorId: 'A', amountInBase: 50 }],
  };
  const net = calcNetBalances(trip);
  assert.equal(net.A, round2(300 - 100 - 107.5 - 50));
  assert.equal(net.B, round2(215 - 100 - 107.5));
  assert.equal(net.C, round2(-100 + 50));
  assert.equal(sum(Object.values(net)), 0);
});

test('simplifyDebts：轉帳後所有人歸零，且抵銷交叉債務', () => {
  // A 欠 B 100、B 欠 C 100 → 淨額 A:-100, B:0, C:+100 → 只需要 A 給 C
  assert.deepEqual(simplifyDebts({ A: -100, B: 0, C: 100 }), [{ from: 'A', to: 'C', amount: 100 }]);

  const net = { A: -120.5, B: -30, C: 80.25, D: 70.25 };
  const txs = simplifyDebts(net);
  const after = { ...net };
  for (const { from, to, amount } of txs) {
    assert.ok(amount > 0);
    after[from] = round2(after[from] + amount);
    after[to] = round2(after[to] - amount);
  }
  for (const v of Object.values(after)) assert.ok(Math.abs(v) <= 0.01);
  assert.ok(txs.length <= Object.keys(net).length - 1);

  assert.deepEqual(simplifyDebts({ A: 0.005, B: -0.005 }), []);
});

test('parse：付款人與分攤欄位', () => {
  assert.deepEqual(extractMentionIds('<@1> <@!2> <@1>'), ['1', '2']);
  assert.deepEqual(parsePayerField('<@1>', 500), [{ userId: '1', amount: 500 }]);
  assert.deepEqual(parsePayerField('<@1>=600,<@2>=400', 1000), [
    { userId: '1', amount: 600 }, { userId: '2', amount: 400 },
  ]);
  assert.throws(() => parsePayerField('<@1> <@2>', 100), /單一代墊者/);

  assert.deepEqual(parseSplitField('equal', ['1', '2']), { mode: 'equal', ids: ['1', '2'] });
  assert.deepEqual(parseSplitField('equal:<@3>,<@4>', ['1']), { mode: 'equal', ids: ['3', '4'] });
  assert.equal(parseSplitField('<@1>=300 <@2>=700', []).mode, 'custom');
  assert.throws(() => parseSplitField('whatever', []), /格式錯誤/);
});

test('tripHelper：移除成員的權限與 splitbill-service 一致', () => {
  const { canRemoveMember } = require('../handlers/splitbill/utils/tripHelper');
  const OWNER = '500000000000000001';
  const BOB = '500000000000000002';
  const CAROL = '500000000000000003';
  const trip = {
    ownerId: OWNER,
    members: [
      { id: 'a', name: 'A', discordId: OWNER },
      { id: 'b', name: 'B', discordId: BOB },
      { id: 'c', name: 'C', discordId: CAROL },
      { id: 'd', name: 'D' },
    ],
  };
  const m = (id) => trip.members.find((x) => x.id === id);
  // 建立者可以移除任何人
  for (const id of ['b', 'c', 'd']) assert.equal(canRemoveMember(trip, m(id), OWNER), true);
  // 一般成員：未連結的、自己可以；其他已連結成員不行
  assert.equal(canRemoveMember(trip, m('d'), BOB), true);
  assert.equal(canRemoveMember(trip, m('b'), BOB), true);
  assert.equal(canRemoveMember(trip, m('c'), BOB), false);
  assert.equal(canRemoveMember(trip, m('a'), BOB), false);
  assert.equal(canRemoveMember(trip, null, OWNER), false);
});

test('tripHelper：幣別格式與 splitbill-service 一致', () => {
  const { isCurrencyCode } = require('../handlers/splitbill/utils/tripHelper');
  for (const ok of ['TWD', 'JPY', 'USDT', 'USDT0', 'AB']) assert.equal(isCurrencyCode(ok), true, ok);
  for (const bad of ['', 'A', '1USD', 'usd', 'ABCDEFGHIJK', 'US D', '<b>', null]) assert.equal(isCurrencyCode(bad), false, String(bad));
});
