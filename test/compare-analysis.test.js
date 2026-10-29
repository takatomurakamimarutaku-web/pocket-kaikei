import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatements, balanceSheet, closingRows } from '../js/statements.js';
import { compareStatement, hideZeroRows, openingRows, changeRate, formatPermille } from '../js/compare.js';
import { bsFigures, plFigures, indicators, breakEven, formatMonths } from '../js/analysis.js';
import { templateAccounts, fillHints } from '../js/accounts.js';
import { createAccount, createPeriod } from '../js/models.js';
import { makeBook } from './helpers.js';

const pick = (list, key) => list.flatMap((s) => s.items).find((i) => i.key === key).value;

test('増減率は前期の絶対値で割った千分率（四捨五入）。前期0は null', () => {
  assert.equal(changeRate(1200, 1000), 200);
  assert.equal(changeRate(800, 1000), -200);
  assert.equal(changeRate(-500, -1000), 500); // 赤字が縮んだらプラス
  assert.equal(changeRate(100, 0), null);
  assert.equal(changeRate(1, 3), -667);
  assert.deepEqual([200, -200, 1234, 12345, 0, null].map(formatPermille), ['20.0%', '△20.0%', '123.4%', '1,234.5%', '0.0%', '—']);
  assert.deepEqual([90, 3, -15, null].map(formatMonths), ['9.0か月', '0.3か月', '△1.5か月', '—']);
});

test('損益計算書の前期比較：同じ科目・区分・段階利益で突き合わせる（個人の「差引金額」2つも別の行）', () => {
  const b = makeBook('individual');
  const prevPeriod = createPeriod({ startDate: '2025-01-01', endDate: '2025-12-31' });
  const prevJournals = [b.j('2025-03-01', [['現金', 1000000]], [['売上高', 1000000]]), b.j('2025-03-02', [['消耗品費', 100000]], [['現金', 100000]])];
  const journals = [b.j('2026-03-01', [['現金', 1200000]], [['売上高', 1200000]]), b.j('2026-03-02', [['消耗品費', 50000]], [['現金', 50000]])];
  const cur = buildStatements({ entityType: 'individual', accounts: b.accounts, period: b.period, journals }).pl;
  const prev = buildStatements({ entityType: 'individual', accounts: b.accounts, period: prevPeriod, journals: prevJournals }).pl;
  const rows = compareStatement(cur.items, prev.items);
  const sales = rows.find((r) => r.kind === 'line' && r.label === '売上高');
  assert.deepEqual([sales.current, sales.previous, sales.diff, sales.rate], [1200000, 1000000, 200000, 200]);
  const supplies = rows.find((r) => r.kind === 'line' && r.label === '消耗品費');
  assert.deepEqual([supplies.diff, supplies.rate], [-50000, -500]);
  const diffs = rows.filter((r) => r.label === '差引金額');
  assert.equal(diffs.length, 2);
  assert.deepEqual(diffs.map((r) => [r.current, r.previous]), [[1200000, 1000000], [1150000, 900000]]);
  const income = rows.find((r) => r.label === '青色申告特別控除前の所得金額');
  assert.deepEqual([income.current, income.previous, income.diff], [1150000, 900000, 250000]);
  // 前期が無いときは前期の列が null
  assert.ok(compareStatement(cur.items, null).every((r) => r.previous === null && r.diff === null));
  // 0円の科目は当期・前期とも0なら隠し、中身が全部0の区分も隠す
  const shown = hideZeroRows(rows);
  assert.ok(!shown.some((r) => r.label === '通信費'));
  assert.ok(!shown.some((r) => r.kind === 'group' && r.label === '専従者給与'));
  assert.ok(shown.some((r) => r.kind === 'group' && r.label === '経費'));
});

test('貸借対照表の前期比較は期首残高から作り、期首の貸借も一致する。注記（うち当期純利益）は前期を比べない', () => {
  const b = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  b.opening([['現金', 500000], ['資本金', 300000], ['繰越利益剰余金', 200000]]);
  const journals = [b.j('2026-05-01', [['現金', 200000]], [['売上高', 200000]])];
  const { bs } = buildStatements({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals });
  const prevBs = balanceSheet('corporation', openingRows({ accounts: b.accounts, period: b.period }), 0);
  assert.equal(prevBs.balanced, true);
  assert.equal(prevBs.totalAssets, 500000);
  const assets = compareStatement(bs.assets, prevBs.assets, { skipPreviousNotes: true });
  const cash = assets.find((r) => r.label === '現金');
  assert.deepEqual([cash.current, cash.previous, cash.diff, cash.rate], [700000, 500000, 200000, 400]);
  const total = assets.find((r) => r.label === '資産合計');
  assert.deepEqual([total.current, total.previous], [700000, 500000]);
  const right = compareStatement(bs.liabilities, prevBs.liabilities, { skipPreviousNotes: true });
  const re = right.find((r) => r.label === '繰越利益剰余金');
  assert.deepEqual([re.current, re.previous], [400000, 200000]);
  const note = right.find((r) => r.kind === 'note');
  assert.deepEqual([note.current, note.previous], [200000, null]);
});

test('経営分析（法人）：収益性・安全性・効率性・損益分岐点を整数で計算する', () => {
  const b = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  b.opening([['現金', 1000000], ['資本金', 1000000]]);
  const journals = [
    b.j('2026-04-10', [['売掛金', 1200000]], [['売上高', 1200000]]),
    b.j('2026-04-11', [['仕入高', 720000]], [['買掛金', 720000]]),
    b.j('2026-04-12', [['消耗品費', 300000]], [['現金', 300000]]),
    b.j('2026-05-10', [['現金', 300000]], [['売掛金', 300000]]),
    b.j('2026-05-11', [['買掛金', 400000]], [['現金', 400000]]),
    b.j('2026-05-12', [['普通預金', 500000]], [['短期借入金', 500000]]),
    b.j('2026-05-13', [['工具器具備品', 200000]], [['現金', 200000]]),
    b.j('2026-06-30', [['支払利息', 10000]], [['現金', 10000]]),
  ];
  const { pl } = buildStatements({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals });
  const plf = plFigures('corporation', pl.profits);
  assert.deepEqual(plf, { sales: 1200000, cogs: 720000, gross: 480000, operating: 180000, ordinary: 170000, income: null, profit: 170000 });
  const bsf = bsFigures(closingRows({ accounts: b.accounts, period: b.period, journals }));
  assert.deepEqual(
    [bsf.currentAssets, bsf.quickAssets, bsf.receivables, bsf.payables, bsf.fixedAssets, bsf.totalAssets, bsf.currentLiabilities, bsf.netAssets],
    [1790000, 1790000, 900000, 320000, 200000, 1990000, 820000, 1170000],
  );
  const list = indicators({ entityType: 'corporation', pl: plf, bs: bsf, months: 12 });
  const expected = {
    gross_margin: 400,
    operating_margin: 150,
    ordinary_margin: 142,
    current_ratio: 2183,
    quick_ratio: 2183,
    equity_ratio: 588,
    fixed_ratio: 171,
    receivable_months: 90,
    inventory_months: 0,
    payable_months: 32,
    working_capital: 580000,
    working_capital_months: 58,
    variable: 720000,
    fixed: 310000,
    marginal_rate: 400,
    break_even: 775000,
    break_even_ratio: 646,
    safety_margin: 354,
  };
  for (const [key, v] of Object.entries(expected)) assert.equal(pick(list, key), v, key);
  // 前期の列：前期の帳簿が無いときは期首残高から求められるものだけ
  const prior = indicators({ entityType: 'corporation', pl: null, bs: bsFigures(openingRows({ accounts: b.accounts, period: b.period })), months: 12 });
  assert.equal(pick(prior, 'equity_ratio'), 1000);
  assert.equal(pick(prior, 'current_ratio'), null); // 流動負債0
  assert.equal(pick(prior, 'gross_margin'), null);
  assert.equal(pick(prior, 'break_even'), null);
});

test('経営分析（個人）：総資産と自己資本から事業主貸を除き、所得率と損益分岐点を出す', () => {
  const b = makeBook('individual');
  b.opening([['現金', 1000000], ['元入金', 1000000]]);
  const journals = [
    b.j('2026-02-01', [['現金', 500000]], [['売上高', 500000]]),
    b.j('2026-02-02', [['事業主貸', 200000]], [['現金', 200000]]),
    b.j('2026-02-03', [['消耗品費', 100000]], [['現金', 100000]]),
  ];
  const { pl } = buildStatements({ entityType: 'individual', accounts: b.accounts, period: b.period, journals });
  const bsf = bsFigures(closingRows({ accounts: b.accounts, period: b.period, journals }));
  assert.deepEqual([bsf.totalAssets, bsf.netAssets], [1200000, 1200000]); // 元入金100万−事業主貸20万＋所得40万
  const list = indicators({ entityType: 'individual', pl: plFigures('individual', pl.profits), bs: bsf, months: 12 });
  assert.equal(pick(list, 'income_ratio'), 800);
  assert.equal(pick(list, 'equity_ratio'), 1000);
  assert.deepEqual([pick(list, 'fixed'), pick(list, 'break_even'), pick(list, 'break_even_ratio'), pick(list, 'safety_margin')], [100000, 100000, 200, 800]);
  assert.ok(!list.flatMap((s) => s.items).some((i) => i.key === 'operating_margin'));
  // 赤字・売上なし
  assert.equal(breakEven({ sales: 0, cogs: 0, profit: -1 }), null);
  assert.deepEqual(breakEven({ sales: 100, cogs: 120, profit: -50 }).point, null);
});

test('個人の受取手形・有価証券・支払手形に目印を補う（既存の帳簿は起動時に補われる）', () => {
  const accounts = templateAccounts('individual').map((a) => createAccount(a)).map((a) => (['120', '130', '300'].includes(a.code) ? { ...a, hint: null } : a));
  const changed = fillHints('individual', accounts);
  assert.deepEqual(changed.map((a) => [a.code, a.hint]).sort(), [['120', 'notes_receivable'], ['130', 'securities'], ['300', 'notes_payable']]);
});
