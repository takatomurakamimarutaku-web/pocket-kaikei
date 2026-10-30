// 残高試算表・月次推移試算表を貸借対照表・損益計算書・製造原価の部に分ける様式と、製造原価報告書の様式
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyTrialStatements, monthlyIncome, monthlyManufacturing, manufacturingMonthlyRows } from '../js/monthly.js';
import { manufacturingReport, closingRows } from '../js/statements.js';
import { incomeStatementRows } from '../js/fs-rows.js';
import { monthlyDoc, incomeStatementDoc } from '../js/print-forms.js';
import { layoutDocument } from '../js/print-layout.js';
import { makeBook } from './helpers.js';

const find = (rows, label) => rows.find((r) => r.label === label);

function corpBook() {
  const b = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  b.opening([['現金', 50_000], ['普通預金', 950_000], ['資本金', 1_000_000]]);
  const journals = [
    b.j('2026-04-05', [['売掛金', 220_000]], [['売上高', 220_000]]),
    b.j('2026-04-10', [['消耗品費', 3_300], ['通信費', 5_500]], [['現金', 8_800]]),
    b.j('2026-05-20', [['普通預金', 220_000]], [['売掛金', 220_000]]),
    b.j('2026-05-25', [['地代家賃', 88_000]], [['普通預金', 88_000]]),
    b.j('2026-06-30', [['現金', 77_000]], [['売上高', 77_000]]),
  ];
  return { b, journals };
}

test('月次推移試算表（部に分ける）：貸借対照表は各月末の残高に当期純損益金額を入れ、毎月 資産合計＝負債・純資産合計', () => {
  const { b, journals } = corpBook();
  const st = monthlyTrialStatements({ accounts: b.accounts, period: b.period, journals }, { entityType: 'corporation' });
  // 貸借対照表は合計の列を出さない（最後の月と同じ）。繰越の列は期首から見るので前期繰越
  assert.deepEqual(st.bs.columns.map((c) => c.label), ['前期繰越', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月', '1月', '2月', '3月']);
  const assets = find(st.bs.rows, '資産合計').values;
  const right = st.bs.rows.at(-1);
  assert.equal(right.label, '負債・純資産合計');
  assert.equal(right.grand, true);
  assert.deepEqual(right.values, assets, '各月末で資産合計＝負債・純資産合計');
  // 当期純損益金額は期首からの累計：4月 220,000−8,800、5月 −88,000、6月 ＋77,000
  const income = find(st.bs.rows, '当期純損益金額');
  assert.equal(income.kind, 'income');
  assert.deepEqual(income.values.slice(0, 4), [0, 211_200, 123_200, 200_200]);
  // 損益計算書：各月の発生額と段階利益。当期純損益金額は月次損益（決算書と同じ計算）と一致する
  assert.equal(st.pl.columns[0].label, '4月', '期首から見るときは繰越の列を出さない');
  assert.equal(st.pl.columns.at(-1).label, '合計');
  const net = st.pl.rows.at(-1);
  assert.deepEqual([net.kind, net.label, net.strong], ['profit', '当期純損益金額', true]);
  const monthly = monthlyIncome({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals });
  assert.deepEqual(net.values.slice(0, 12), monthly.netIncome);
  assert.equal(net.values.at(-1), 200_200);
  assert.ok(find(st.pl.rows, '売上総損益金額'));
  // 区分の見出しは金額を持たない。科目が2つ以上の区分は区分の合計の行
  assert.equal(find(st.pl.rows, '販売費及び一般管理費').values, undefined);
  assert.equal(find(st.pl.rows, '販売費及び一般管理費合計').values.at(-1), 96_800);
  assert.equal(st.mfg.rows.length, 0, '製造原価の科目が無ければ製造原価の部は空');
});

test('月次推移試算表（部に分ける）：期の途中から見ると繰越の列、決算整理の列は貸借対照表では決算整理後', () => {
  const { b, journals } = corpBook();
  const adj = b.j('2027-03-31', [['消耗品費', 500]], [['現金', 500]]);
  adj.adjusting = true;
  const st = monthlyTrialStatements({ accounts: b.accounts, period: b.period, journals: [...journals, adj], fromMonth: '2026-05', toMonth: '2027-03', separateAdjusting: true, quarters: true }, { entityType: 'corporation' });
  assert.equal(st.bs.columns[0].label, '前月繰越');
  assert.equal(st.bs.columns.at(-1).label, '決算整理後');
  assert.equal(st.pl.columns[0].label, '前月繰越', '開始月の前日までの損益があれば繰越の列を出す');
  assert.equal(st.pl.rows.find((r) => r.kind === 'line' && r.label === '売上高').values[0], 220_000);
  assert.equal(st.pl.columns.at(-2).label, '決算整理');
  assert.equal(st.pl.rows.at(-1).values.at(-2), -500);
  const assets = find(st.bs.rows, '資産合計').values;
  assert.deepEqual(st.bs.rows.at(-1).values, assets);
  assert.equal(find(st.bs.rows, '当期純損益金額').values.at(-1), 200_200 - 500);
});

test('月次推移試算表（個人）：資本に青色申告特別控除前の所得金額、負債・資本合計', () => {
  const b = makeBook('individual');
  b.opening([['現金', 100_000], ['元入金', 100_000]]);
  const journals = [b.j('2026-02-01', [['現金', 120_000]], [['売上高', 120_000]]), b.j('2026-03-02', [['消耗品費', 20_000]], [['現金', 20_000]])];
  const st = monthlyTrialStatements({ accounts: b.accounts, period: b.period, journals }, { entityType: 'individual' });
  assert.equal(find(st.bs.rows, '青色申告特別控除前の所得金額').values[3], 100_000);
  assert.equal(st.bs.rows.at(-1).label, '負債・資本合計');
  assert.deepEqual(st.bs.rows.at(-1).values, find(st.bs.rows, '資産合計').values);
  assert.equal(st.pl.rows.at(-1).label, '青色申告特別控除前の所得金額');
});

test('月次推移試算表（製造業）：製造原価の部は当期製品製造原価で終わり、損益計算書の売上原価に入る', () => {
  const b = makeBook('corporation', { manufacturing: true });
  const journals = [
    b.j('2026-02-01', [['材料仕入高', 100_000]], [['現金', 100_000]]),
    b.j('2026-02-02', [['賃金', 60_000]], [['現金', 60_000]]),
    b.j('2026-03-03', [['現金', 300_000]], [['売上高', 300_000]]),
  ];
  const st = monthlyTrialStatements({ accounts: b.accounts, period: b.period, journals }, { entityType: 'corporation' });
  const cost = st.mfg.rows.at(-1);
  assert.deepEqual([cost.label, cost.strong, cost.values[1], cost.values.at(-1)], ['当期製品製造原価', true, 160_000, 160_000]);
  assert.equal(find(st.pl.rows, '当期製品製造原価').kind, 'calc');
  assert.deepEqual(find(st.pl.rows, '売上総損益金額').values.slice(0, 3), [0, -160_000, 300_000]);
  assert.equal(find(st.bs.rows, '当期純損益金額').values.at(-1), 140_000);
});

test('推移表の印刷：部ごとに改ページして表題を変え、部ごとに列を変えられる。区分の見出しは金額なし', () => {
  const doc = monthlyDoc({
    title: '月次推移試算表',
    head: {},
    columns: [],
    sections: [
      { title: '月次推移試算表（貸借対照表）', columns: ['前期繰越', '4月'], rows: [{ kind: 'group', label: '流動資産' }, { kind: 'line', label: '現金', values: [100, 0] }, { kind: 'total', label: '資産合計', values: [100, 0] }] },
      { title: '月次推移試算表（損益計算書）', columns: ['4月', '合計'], rows: [{ kind: 'profit', label: '当期純損益金額', values: [5, 5], strong: true }] },
    ],
  });
  const heads = doc.blocks.filter((x) => x.type === 'heading');
  assert.deepEqual(heads.map((x) => [x.caption, x.title]), [[true, '月次推移試算表（貸借対照表）'], [true, '月次推移試算表（損益計算書）']]);
  const [bsT, plT] = doc.blocks.filter((x) => x.type === 'table');
  assert.deepEqual(bsT.columns.map((c) => c.label), ['勘定科目', '前期繰越', '4月']);
  assert.deepEqual(plT.columns.map((c) => c.label), ['勘定科目', '4月', '合計']);
  assert.deepEqual(bsT.rows[0].cells, [{ text: '【流動資産】', span: 3 }]);
  assert.deepEqual(bsT.rows[1].cells.slice(1), ['100', '']);
  assert.equal(bsT.rows[2].kind, 'total');
  assert.equal(plT.rows[0].kind, 'total', '最後の利益は二重線');
  assert.equal(layoutDocument(doc).length, 2);
});

function mfgBook() {
  const b = makeBook('corporation', { manufacturing: true });
  const journals = [
    b.j('2026-01-01', [['期首材料棚卸高', 30_000]], [['原材料', 30_000]]),
    b.j('2026-02-01', [['材料仕入高', 100_000]], [['現金', 100_000]]),
    b.j('2026-02-02', [['賃金', 60_000]], [['現金', 60_000]]),
    b.j('2026-12-31', [['原材料', 20_000]], [['期末材料棚卸高', 20_000]]),
    b.j('2026-12-31', [['仕掛品', 10_000]], [['期末仕掛品棚卸高', 10_000]]),
  ];
  return { b, journals };
}

test('製造原価報告書の様式：材料費・労務費・製造経費の最後に当期材料費などの行（右の列）、科目は左の列', () => {
  const { b, journals } = mfgBook();
  const mfg = manufacturingReport(closingRows({ accounts: b.accounts, period: b.period, journals }));
  const rows = incomeStatementRows(mfg.items, { entityType: 'corporation' });
  const labels = rows.map((r) => r.label);
  assert.deepEqual(labels, ['材料費', '期首材料棚卸高', '材料仕入高', '合計', '期末材料棚卸高', '当期材料費', '労務費', '賃金', '当期労務費', '当期総製造費用', '期末仕掛品棚卸高', '当期製品製造原価']);
  // 期首材料棚卸高＋材料仕入高＝合計、期末材料棚卸高は正の数で差し引き、当期材料費は右の列
  assert.equal(find(rows, '合計').inner, 130_000);
  assert.equal(find(rows, '期末材料棚卸高').inner, 20_000);
  assert.deepEqual([find(rows, '材料仕入高').inner, find(rows, '材料仕入高').outer], [100_000, null]);
  assert.deepEqual([find(rows, '当期材料費').outer, find(rows, '当期材料費').sum], [110_000, true]);
  // 科目が1つの区分も科目は左の列、当期労務費は右の列
  assert.deepEqual([find(rows, '賃金').inner, find(rows, '賃金').outer], [60_000, null]);
  assert.equal(find(rows, '当期労務費').outer, 60_000);
  assert.equal(find(rows, '当期総製造費用').outer, 170_000);
  assert.deepEqual([rows.at(-1).outer, rows.at(-1).rule], [160_000, 'double']);
  // 印刷：決算書の体裁（表題の字間・罫線を使わない表・作成日を出さない）
  const doc = incomeStatementDoc(mfg.items, { head: { company: '株式会社テスト', period: '自 令和8年1月1日　至 令和8年12月31日' }, title: '製造原価報告書', entityType: 'corporation' });
  assert.equal(doc.title, '製 造 原 価 報 告 書');
  assert.equal(doc.formal, true);
  assert.equal(doc.blocks[0].style, 'open');
  const cell = (label) => doc.blocks[0].rows.find((r) => r.cells[0].text === label);
  assert.equal(cell('当期材料費').cells[2].text, '110,000');
  assert.equal(cell('当期製品製造原価').cells[2].rule, 'double');
});

test('製造原価報告書の月次推移：決算書と同じ並び。期末の棚卸高は正の数で差し引き、最後の列は期間の合計', () => {
  const { b, journals } = mfgBook();
  const m = monthlyManufacturing({ accounts: b.accounts, period: b.period, journals });
  const rows = manufacturingMonthlyRows(m.items);
  assert.deepEqual(rows.map((r) => r.label), ['材料費', '期首材料棚卸高', '材料仕入高', '合計', '期末材料棚卸高', '当期材料費', '労務費', '賃金', '当期労務費', '当期総製造費用', '期末仕掛品棚卸高', '当期製品製造原価']);
  assert.equal(find(rows, '当期材料費').kind, 'subtotal');
  assert.equal(find(rows, '期末材料棚卸高').values.at(-1), 20_000);
  assert.equal(find(rows, '期末材料棚卸高').values[11], 20_000, '12月に正の数');
  assert.equal(find(rows, '合計').values.at(-1), 130_000);
  assert.equal(find(rows, '当期材料費').values.at(-1), 110_000);
  assert.equal(find(rows, '期末仕掛品棚卸高').values.at(-1), 10_000);
  const last = rows.at(-1);
  assert.deepEqual([last.kind, last.values.at(-1), last.values.length], ['total', 160_000, 13]);
});
