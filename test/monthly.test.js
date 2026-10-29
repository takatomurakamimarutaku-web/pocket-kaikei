import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyIncome, monthlyBalance, isAllZero } from '../js/monthly.js';
import { buildStatements } from '../js/statements.js';
import { monthlyCsv, BOM } from '../js/csv.js';
import { makeBook } from './helpers.js';

function sample(entityType) {
  const corp = entityType === 'corporation';
  const book = makeBook(entityType, corp ? { startDate: '2026-04-01', endDate: '2027-03-31' } : {});
  const { j, opening } = book;
  opening(corp ? [['現金', 50000], ['普通預金', 950000], ['資本金', 1000000]] : [['現金', 50000], ['普通預金', 950000], ['元入金', 1000000]]);
  const y = '2026-';
  book.journals = [
    j(`${y}04-05`, [['売掛金', 220000]], [['売上高', 220000]], '4月売上'),
    j(`${y}04-10`, [['消耗品費', 3300], ['通信費', 5500]], [['現金', 8800]]),
    j(`${y}05-20`, [['普通預金', 220000]], [['売掛金', 220000]]),
    j(`${y}05-25`, [['地代家賃', 88000]], [['普通預金', 88000]]),
    j(`${y}06-30`, [['仕入高', 50000]], [['買掛金', 50000]]),
    j(`${y}06-30`, [['現金', 77000]], [['売上高', 77000]]),
    j(`${y}12-31`, [['消耗品費', 1000]], [['現金', 1000]]),
  ];
  return book;
}

for (const entityType of ['individual', 'corporation']) {
  test(`月次損益（${entityType}）：12か月で、各行の月別合計が決算書と一致する`, () => {
    const { accounts, period, journals } = sample(entityType);
    const m = monthlyIncome({ entityType, accounts, period, journals });
    assert.equal(m.months.length, 12);
    const { pl } = buildStatements({ entityType, accounts, period, journals });
    assert.equal(m.items.length, pl.items.length);
    m.items.forEach((item, i) => {
      const want = pl.items[i];
      assert.equal(item.label, want.label);
      assert.equal(item.total, want.type === 'group' ? want.total : want.amount, item.label);
      item.lines?.forEach((l, k) => assert.equal(l.total, want.lines[k].amount, l.account.name));
    });
    assert.equal(m.netIncome.reduce((s, v) => s + v, 0), pl.netIncome);
    const apr = m.months.indexOf('2026-04');
    assert.equal(m.sales[apr], 220000);
    assert.equal(m.netIncome[apr], 220000 - 8800);
    assert.equal(m.netIncome[m.months.indexOf('2026-05')], -88000);
  });

  test(`月次貸借（${entityType}）：毎月末で資産合計＝負債・純資産合計、最終月は決算書と一致する`, () => {
    const { accounts, period, journals } = sample(entityType);
    const m = monthlyBalance({ entityType, accounts, period, journals });
    assert.ok(m.balanced.every(Boolean));
    const { bs } = buildStatements({ entityType, accounts, period, journals });
    const last = (items) => items.map((x) => x.values.at(-1));
    assert.deepEqual(last(m.assets), bs.assets.map((x) => (x.type === 'group' ? x.total : x.amount)));
    assert.deepEqual(last(m.liabilities), bs.liabilities.map((x) => (x.type === 'group' ? x.total : x.amount)));
    // 月末の現金：4月 50000-8800、6月 +77000
    const cash = m.assets[0].lines.find((l) => l.account.name === '現金');
    assert.equal(cash.values[m.months.indexOf('2026-04')], 41200);
    assert.equal(cash.values[m.months.indexOf('2026-06')], 118200);
  });
}

test('月次推移：仕訳が無くても期首残高だけで集計できる', () => {
  const { accounts, period, opening } = makeBook('individual');
  opening([['現金', 1000], ['元入金', 1000]]);
  const inc = monthlyIncome({ entityType: 'individual', accounts, period, journals: [] });
  assert.ok(inc.netIncome.every((v) => v === 0));
  const bal = monthlyBalance({ entityType: 'individual', accounts, period, journals: [] });
  assert.ok(bal.assets[0].values.every((v) => v === 1000));
  assert.ok(bal.balanced.every(Boolean));
});

test('isAllZero', () => {
  assert.equal(isAllZero([0, 0]), true);
  assert.equal(isAllZero([0, -1]), false);
});

test('monthlyCsv：0円の科目と区分を省き、合計列を付ける。マイナスは -1000 形式', () => {
  const { accounts, period, journals } = sample('individual');
  const m = monthlyIncome({ entityType: 'individual', accounts, period, journals });
  const csv = monthlyCsv(m.items, m.months, { total: true });
  assert.ok(csv.startsWith(BOM));
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines[0], `項目,${m.months.map((x) => x.replace('-', '/')).join(',')},合計`);
  assert.ok(lines.includes('【売上(収入)金額】,0,0,0,220000,0,77000,0,0,0,0,0,0,297000'));
  assert.ok(lines.includes('　売上高,0,0,0,220000,0,77000,0,0,0,0,0,0,297000'));
  assert.ok(!lines.some((l) => l.startsWith('　雑収入')));
  assert.ok(!lines.some((l) => l.startsWith('【専従者給与】')));
  assert.ok(lines.some((l) => l.startsWith('青色申告特別控除前の所得金額,') && l.includes(',-88000,')));
});
