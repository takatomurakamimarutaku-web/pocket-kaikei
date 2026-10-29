import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatements } from '../js/statements.js';
import { computeOwnerCapital } from '../js/ledger.js';
import { makeBook } from './helpers.js';

const item = (items, label) => items.find((i) => i.label === label);
const lineOf = (section, name) => section.lines.find((l) => l.account.name === name);

function corp() {
  const b = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  b.opening([
    ['普通預金', 1000000],
    ['商品', 200000],
    ['工具器具備品', 500000],
    ['減価償却累計額', 100000],
    ['買掛金', 150000],
    ['長期借入金', 300000],
    ['資本金', 1000000],
    ['繰越利益剰余金', 150000],
  ]);
  const journals = [
    b.j('2026-05-01', [['売掛金', 1650000]], [['売上高', 1650000]]),
    b.j('2026-05-10', [['仕入高', 880000]], [['買掛金', 880000]]),
    b.j('2026-06-01', [['給料手当', 300000], ['地代家賃', 110000], ['消耗品費', 22000]], [['普通預金', 432000]]),
    b.j('2026-07-01', [['普通預金', 1000]], [['受取利息', 1000]]),
    b.j('2026-07-15', [['支払利息', 5000]], [['普通預金', 5000]]),
    b.j('2026-08-01', [['固定資産除却損', 20000], ['減価償却累計額', 30000]], [['工具器具備品', 50000]]),
    // 決算整理（第1弾は手入力）：期首商品の振替・期末商品・減価償却・法人税等
    b.j('2027-03-31', [['期首商品棚卸高', 200000]], [['商品', 200000]]),
    b.j('2027-03-31', [['商品', 250000]], [['期末商品棚卸高', 250000]]),
    b.j('2027-03-31', [['減価償却費', 90000]], [['減価償却累計額', 90000]]),
    b.j('2027-03-31', [['法人税、住民税及び事業税', 70000]], [['未払法人税等', 70000]]),
  ];
  return { ...b, journals, entityType: 'corporation' };
}

test('法人の損益計算書：売上原価（期末棚卸は△）と段階利益', () => {
  const { pl } = buildStatements(corp());
  const cogs = item(pl.items, '売上原価');
  assert.equal(lineOf(cogs, '期末商品棚卸高').amount, -250000, '評価勘定は△');
  assert.equal(cogs.total, 200000 + 880000 - 250000);
  assert.deepEqual(pl.profits, {
    gross: 1650000 - 830000,
    operating: 820000 - (300000 + 110000 + 22000 + 90000),
    ordinary: 298000 + 1000 - 5000,
    pretax: 294000 - 20000,
    net: 274000 - 70000,
  });
  assert.equal(pl.netIncome, 204000);
});

test('法人の貸借対照表：減価償却累計額は△、繰越利益剰余金に当期純利益を含め、資産合計＝負債・純資産合計', () => {
  const { bs, pl } = buildStatements(corp());
  const tangible = item(bs.assets, '有形固定資産');
  assert.equal(lineOf(tangible, '減価償却累計額').amount, -(100000 - 30000 + 90000));
  assert.equal(tangible.total, 450000 - 160000);
  const equity = item(bs.liabilities, '純資産');
  const re = lineOf(equity, '繰越利益剰余金');
  assert.equal(re.amount, 150000 + pl.netIncome);
  assert.deepEqual(re.note, { label: 'うち当期純利益', amount: 204000 });
  assert.equal(bs.balanced, true);
  assert.equal(bs.totalAssets, bs.totalLiabilitiesAndEquity);
  // 普通預金 1,000,000−432,000+1,000−5,000、売掛金 1,650,000、商品 250,000、備品 450,000−累計 160,000
  assert.equal(bs.totalAssets, 564000 + 1650000 + 250000 + 290000);
});

test('法人：赤字のときも一致し、繰越利益剰余金がマイナス（△）になる', () => {
  const b = makeBook('corporation');
  b.opening([['普通預金', 100000], ['資本金', 100000]]);
  const journals = [b.j('2026-02-01', [['地代家賃', 300000]], [['役員借入金', 300000]])];
  const { pl, bs } = buildStatements({ ...b, journals, entityType: 'corporation' });
  assert.equal(pl.netIncome, -300000);
  assert.equal(lineOf(item(bs.liabilities, '純資産'), '繰越利益剰余金').amount, -300000);
  assert.equal(bs.balanced, true);
});

function individual() {
  const b = makeBook('individual', { subs: [['普通預金', '事業用口座']] });
  const opening = [
    ['現金', 50000],
    ['普通預金', 800000, '事業用口座'],
    ['工具器具備品', 300000],
    ['未払金', 40000],
  ];
  b.opening(opening);
  const capital = computeOwnerCapital(b.period.openingBalances, b.accounts);
  b.period.openingBalances.push({ accountId: b.byName['元入金'].id, subAccountId: null, amount: capital });
  const journals = [
    b.j('2026-03-01', [['普通預金', 550000, undefined, '事業用口座']], [['売上高', 550000]]),
    b.j('2026-03-05', [['現金', 3000]], [['雑収入', 3000]]),
    b.j('2026-03-10', [['仕入高', 110000]], [['現金', 50000], ['事業主借', 60000]]),
    b.j('2026-04-01', [['通信費', 8000], ['事業主貸', 2000]], [['普通預金', 10000, undefined, '事業用口座']]),
    b.j('2026-04-25', [['専従者給与', 80000]], [['普通預金', 80000, undefined, '事業用口座']]),
    b.j('2026-05-01', [['事業主貸', 100000]], [['普通預金', 100000, undefined, '事業用口座']]),
    b.j('2026-12-31', [['商品', 30000]], [['期末商品棚卸高', 30000]]),
    b.j('2026-12-31', [['減価償却費', 60000]], [['工具器具備品', 60000]]),
  ];
  return { ...b, journals, entityType: 'individual', capital };
}

test('個人の損益計算書：売上(収入)金額に雑収入を含め、青色申告特別控除前の所得金額まで', () => {
  const { pl } = buildStatements(individual());
  assert.equal(item(pl.items, '売上(収入)金額').total, 553000);
  assert.equal(item(pl.items, '売上原価').total, 110000 - 30000);
  assert.equal(pl.profits.diff1, 473000);
  assert.equal(item(pl.items, '経費').total, 68000);
  assert.equal(pl.profits.diff2, 405000);
  assert.equal(item(pl.items, '専従者給与').total, 80000);
  assert.equal(pl.netIncome, 325000);
  assert.equal(pl.items.at(-1).label, '青色申告特別控除前の所得金額');
});

test('個人の貸借対照表：事業主貸は資産側、事業主借・元入金・所得金額は資本側、資産合計＝負債・資本合計', () => {
  const s = individual();
  const { bs, pl } = buildStatements(s);
  assert.equal(item(bs.assets, '事業主貸').total, 102000);
  const capital = item(bs.liabilities, '資本');
  assert.equal(lineOf(capital, '事業主借').amount, 60000);
  assert.equal(lineOf(capital, '元入金').amount, s.capital);
  assert.equal(s.capital, 1110000);
  assert.equal(item(bs.liabilities, '青色申告特別控除前の所得金額').amount, pl.netIncome);
  assert.equal(item(bs.liabilities, '負債').total, 40000);
  assert.equal(bs.balanced, true);
  assert.equal(bs.totalAssets, bs.totalLiabilitiesAndEquity);
});

test('期首残高が一致していないと BS も一致しない（画面で警告する）', () => {
  const b = makeBook('corporation');
  b.opening([['現金', 1000], ['資本金', 900]]);
  const { bs } = buildStatements({ ...b, journals: [], entityType: 'corporation' });
  assert.equal(bs.balanced, false);
  assert.equal(bs.totalAssets - bs.totalLiabilitiesAndEquity, 100);
});
