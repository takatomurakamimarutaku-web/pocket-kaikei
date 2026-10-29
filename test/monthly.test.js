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

test('月次推移の試算表：貸借は月末残高、損益は月の発生額。合計の列は残高試算表と一致する', async () => {
  const { monthlyTrialBalance } = await import('../js/monthly.js');
  const { trialBalance } = await import('../js/ledger.js');
  for (const entityType of ['individual', 'corporation']) {
    const { accounts, period, journals, byName } = sample(entityType);
    const m = monthlyTrialBalance({ accounts, period, journals });
    assert.equal(m.columns.length, 14); // 繰越残高＋12か月＋合計
    const tb = trialBalance({ accounts, period, journals });
    for (const r of m.rows) {
      const t = tb.rows.find((x) => x.account.id === r.account.id);
      const bs = ['current_assets', 'current_liabilities', 'equity', 'tangible_fixed_assets', 'owner_drawings', 'fixed_liabilities', 'intangible_fixed_assets', 'investments', 'deferred_assets'].includes(r.account.group);
      assert.equal(r.values[0], t.opening, r.account.name);
      if (bs) assert.equal(r.values.at(-1), t.closing, r.account.name);
    }
    const row = (name) => m.rows.find((r) => r.account.id === byName[name].id).values;
    const col = (key) => m.columns.findIndex((c) => c.key === key);
    // 普通預金：4月末 950,000、5月末 950,000＋220,000−88,000
    assert.equal(row('普通預金')[col('2026-04')], 950000);
    assert.equal(row('普通預金')[col('2026-05')], 1082000);
    // 売上高：4月 220,000、6月 77,000、合計 297,000
    assert.equal(row('売上高')[col('2026-04')], 220000);
    assert.equal(row('売上高')[col('2026-06')], 77000);
    assert.equal(row('売上高').at(-1), 297000);
  }
});

test('月次推移の試算表：四半期・半期の列、範囲の指定、決算整理の列', async () => {
  const { monthlyTrialBalance, isAdjusting } = await import('../js/monthly.js');
  const { accounts, period, journals, byName, j } = sample('corporation'); // 2026/4〜2027/3
  const adj = j('2027-03-31', [['減価償却費', 12000]], [['減価償却累計額', 12000]]);
  adj.source = 'depreciation';
  const manual = j('2027-03-31', [['消耗品費', 500]], [['現金', 500]]);
  manual.adjusting = true;
  const normal = j('2027-03-15', [['消耗品費', 700]], [['現金', 700]]);
  const all = [...journals, adj, manual, normal];
  assert.equal(isAdjusting(adj), true);
  assert.equal(isAdjusting(manual), true);
  assert.equal(isAdjusting(normal), false);
  assert.equal(isAdjusting({ lines: [{ memo: '決算整理 棚卸' }] }), true); // 印の導入前の期末棚卸
  assert.equal(isAdjusting({ source: 'depreciation', adjusting: false, lines: [] }), false); // 振替伝票の指定を優先

  const m = monthlyTrialBalance({ accounts, period, journals: all, quarters: true, halves: true, separateAdjusting: true });
  assert.deepEqual(
    m.columns.map((c) => c.label),
    ['繰越残高', '4月', '5月', '6月', '第1四半期', '7月', '8月', '9月', '第2四半期', '上半期', '10月', '11月', '12月', '第3四半期', '1月', '2月', '3月', '第4四半期', '下半期', '決算整理', '合計'],
  );
  const row = (name) => m.rows.find((r) => r.account.id === byName[name].id).values;
  const at = (label) => m.columns.findIndex((c) => c.label === label);
  // 損益：四半期は3か月の合計、決算整理は別の列、合計に含める
  assert.equal(row('売上高')[at('第1四半期')], 297000);
  assert.equal(row('売上高')[at('上半期')], 297000);
  assert.equal(row('消耗品費')[at('3月')], 700);
  assert.equal(row('消耗品費')[at('決算整理')], 500);
  assert.equal(row('消耗品費').at(-1), 3300 + 1000 + 700 + 500);
  assert.equal(row('減価償却費')[at('3月')], 0);
  assert.equal(row('減価償却費')[at('決算整理')], 12000);
  // 貸借：四半期はその末の残高、決算整理の列は整理後の残高
  assert.equal(row('普通預金')[at('第1四半期')], row('普通預金')[at('6月')]);
  assert.equal(row('減価償却累計額')[at('3月')], 0);
  assert.equal(row('減価償却累計額')[at('決算整理')], 12000);
  // 決算整理を分けなければ3月に入る
  const merged = monthlyTrialBalance({ accounts, period, journals: all });
  assert.equal(merged.rows.find((r) => r.account.id === byName['減価償却費'].id).values[merged.columns.findIndex((c) => c.label === '3月')], 12000);
  // 範囲：5〜7月。繰越残高は4月末まで、四半期は範囲内の月だけ合計する
  const part = monthlyTrialBalance({ accounts, period, journals: all, fromMonth: '2026-05', toMonth: '2026-07', quarters: true });
  assert.deepEqual(part.columns.map((c) => c.label), ['繰越残高', '5月', '6月', '第1四半期', '7月', '合計']);
  const prow = (name) => part.rows.find((r) => r.account.id === byName[name].id).values;
  assert.equal(prow('売上高')[0], 220000); // 4月分は繰越
  assert.equal(prow('売上高')[3], 77000); // 第1四半期は範囲内の5・6月だけ
  assert.equal(prow('普通預金')[0], 950000);
  // 区分の小計：資産の区分は科目の合計（評価勘定は差し引く）
  const fixed = m.groups.find((g) => g.group === 'tangible_fixed_assets');
  assert.equal(fixed.values.at(-1), -12000);
});

test('月次推移の試算表のCSV：区分の行と科目の行、0円の科目は除く', async () => {
  const { monthlyTrialBalance } = await import('../js/monthly.js');
  const { monthlyTrialCsv } = await import('../js/csv.js');
  const { accounts, period, journals } = sample('individual');
  const csv = monthlyTrialCsv(monthlyTrialBalance({ accounts, period, journals, quarters: true }), { entityType: 'individual' });
  const lines = csv.replace(BOM, '').trim().split('\r\n');
  assert.ok(lines[0].startsWith('勘定科目,繰越残高,1月,2月,3月,第1四半期'));
  assert.ok(lines.some((l) => l.startsWith('　売上高,0,0,0,0,0,220000,0,77000,297000')));
  assert.ok(!lines.some((l) => l.startsWith('　受取手形')));
});
