import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trialBalance, generalLedger, counterpartName, computeOwnerCapital, openingDiff, carriedLabel } from '../js/ledger.js';
import { makeBook } from './helpers.js';

function sample() {
  const b = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31', subs: [['普通預金', 'A銀行'], ['普通預金', 'B銀行']] });
  b.opening([
    ['現金', 50000],
    ['普通預金', 300000, 'A銀行'],
    ['普通預金', 100000, 'B銀行'],
    ['資本金', 400000],
    ['繰越利益剰余金', 50000],
  ]);
  const js = [
    b.j('2026-04-05', [['普通預金', 220000, undefined, 'A銀行']], [['売上高', 220000]], '4月売上'),
    b.j('2026-04-10', [['消耗品費', 3300], ['通信費', 5500]], [['現金', 8800]], '諸経費'),
    b.j('2026-05-01', [['地代家賃', 110000]], [['普通預金', 110000, undefined, 'B銀行']], '5月家賃'),
    b.j('2026-05-20', [['現金', 30000]], [['普通預金', 30000, undefined, 'A銀行']], '引出し'),
  ];
  return { ...b, journals: js };
}

test('試算表：繰越・借方・貸方・残高、借方合計＝貸方合計、残高の貸借も一致', () => {
  const b = sample();
  const tb = trialBalance(b);
  const row = (name) => tb.rows.find((r) => r.account.name === name);
  assert.deepEqual(
    (({ opening, debit, credit, closing }) => ({ opening, debit, credit, closing }))(row('現金')),
    { opening: 50000, debit: 30000, credit: 8800, closing: 71200 },
  );
  assert.equal(row('普通預金').opening, 400000);
  assert.equal(row('普通預金').closing, 400000 + 220000 - 110000 - 30000);
  assert.equal(row('売上高').closing, 220000, '貸方残の科目は貸方をプラスで表示');
  assert.equal(row('売上高').opening, 0);
  assert.equal(tb.totals.debit, tb.totals.credit);
  assert.equal(tb.totals.closingDebit, tb.totals.closingCredit);
  assert.equal(tb.openingDiff, 0);
  // 補助科目の内訳
  const subs = row('普通預金').subs;
  assert.deepEqual(subs.map((s) => [s.subAccount.name, s.closing]), [['A銀行', 490000], ['B銀行', -10000]]);
});

test('試算表：月範囲を指定すると、それより前の増減が繰越残高に入る（PL科目も期首からの累計）', () => {
  const b = sample();
  const tb = trialBalance({ ...b, from: '2026-05-01', to: '2026-05-31' });
  const row = (name) => tb.rows.find((r) => r.account.name === name);
  assert.equal(row('現金').opening, 41200);
  assert.equal(row('現金').debit, 30000);
  assert.equal(row('売上高').opening, 220000);
  assert.equal(row('売上高').credit, 0);
  assert.equal(row('地代家賃').debit, 110000);
  assert.equal(tb.totals.debit, 140000);
  assert.equal(tb.totals.debit, tb.totals.credit);
});

test('元帳：繰越・相手科目（1つなら科目名、複数なら諸口）・残高推移', () => {
  const b = sample();
  const cash = generalLedger({ ...b, accountId: b.byName['現金'].id });
  assert.equal(cash.carried, 50000);
  assert.deepEqual(cash.rows.map((r) => [r.date, r.counterpart, r.debit, r.credit, r.balance]), [
    ['2026-04-10', '諸口', 0, 8800, 41200],
    ['2026-05-20', '普通預金（A銀行）', 30000, 0, 71200],
  ]);
  assert.equal(cash.closing, 71200);
  const fee = generalLedger({ ...b, accountId: b.byName['消耗品費'].id });
  assert.equal(fee.rows[0].counterpart, '現金');
  // 月範囲：5月から
  const may = generalLedger({ ...b, accountId: b.byName['現金'].id, from: '2026-05-01' });
  assert.equal(may.carried, 41200);
  assert.equal(may.rows.length, 1);
  assert.equal(carriedLabel(b.period, '2026-05-01'), '前月繰越');
  assert.equal(carriedLabel(b.period, '2026-04-01'), '前期繰越');
});

test('補助元帳：補助科目ごとの繰越と残高', () => {
  const b = sample();
  const a = generalLedger({ ...b, accountId: b.byName['普通預金'].id, subAccountId: b.subAccounts[0].id });
  assert.equal(a.carried, 300000);
  assert.deepEqual(a.rows.map((r) => r.balance), [520000, 490000]);
  assert.equal(a.rows[0].counterpart, '売上高');
  const bb = generalLedger({ ...b, accountId: b.byName['普通預金'].id, subAccountId: b.subAccounts[1].id });
  assert.equal(bb.closing, -10000);
});

test('相手科目：反対側が同じ科目・同じ補助の複数行なら諸口にしない', () => {
  const b = sample();
  const jn = b.j('2026-06-01', [['消耗品費', 100], ['消耗品費', 200]], [['現金', 300]]);
  const accountById = new Map(b.accounts.map((a) => [a.id, a]));
  assert.equal(counterpartName(jn, jn.lines[2], accountById, new Map()), '消耗品費');
});

test('個人の元入金＝期首の資産−負債。期首残高は必ず一致する', () => {
  const b = makeBook('individual');
  b.opening([
    ['現金', 30000],
    ['普通預金', 500000],
    ['売掛金', 120000],
    ['買掛金', 80000],
    ['借入金', 200000],
  ]);
  const capital = computeOwnerCapital(b.period.openingBalances, b.accounts);
  assert.equal(capital, 370000);
  b.period.openingBalances.push({ accountId: b.byName['元入金'].id, subAccountId: null, amount: capital });
  assert.equal(openingDiff(b.period, b.accounts), 0);
});

test('法人の期首残高の差額', () => {
  const b = makeBook('corporation');
  b.opening([['現金', 1000], ['資本金', 900]]);
  assert.equal(openingDiff(b.period, b.accounts), 100);
});
