import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessOverview, thousand } from '../js/business-overview.js';
import { corporateTaxReturn } from '../js/corporate-tax.js';
import { corporateTaxDoc, businessOverviewBlocks } from '../js/print-tax-forms.js';
import { layoutDocument } from '../js/print-layout.js';
import { buildStatements } from '../js/statements.js';
import { buildSample } from '../js/sample.js';

const sample = () => {
  const s = buildSample('corporation');
  const period = s.periods[0];
  return { s, period, ov: businessOverview({ accounts: s.accounts, period, journals: s.journals, assets: s.assets, periods: s.periods }) };
};

test('千円単位：千円未満を切り捨て、マイナスは絶対値を切り捨て', () => {
  assert.equal(thousand(1234999), 1234);
  assert.equal(thousand(999), 0);
  assert.equal(thousand(-1500), -1);
  assert.equal(thousand(0), 0);
});

test('法人事業概況説明書の主要科目：損益計算書・貸借対照表と合い、資産合計＝負債合計＋純資産合計', () => {
  const { s, period, ov } = sample();
  const { pl, bs } = buildStatements({ entityType: 'corporation', accounts: s.accounts, period, journals: s.journals });
  const it = ov.items;
  assert.equal(it.sales, pl.profits.sales);
  assert.equal(it.gross, pl.profits.gross);
  assert.equal(it.pretax, pl.profits.pretax);
  assert.equal(it.totalAssets, bs.totalAssets);
  assert.equal(it.totalAssets, it.totalLiabilities + it.netAssets);
  assert.ok(it.cash > 0);
  // 月別の売上の計＝売上高
  assert.equal(ov.months.length, 12);
  assert.equal(ov.monthTotal.sales, it.sales);
  assert.equal(ov.months.reduce((t, m) => t + m.sales, 0), it.sales);
});

test('法人事業概況説明書の印刷：表と裏の2枚、主要科目は千円単位、0は空欄', () => {
  const { s, period, ov } = sample();
  const r = corporateTaxReturn({ accounts: s.accounts, period, journals: s.journals, input: { employees: 8 }, enterpriseInput: {} });
  const doc = corporateTaxDoc(r, { head: { company: 'テスト' }, sheets: ['gaikyo'], overview: ov });
  const pages = layoutDocument(doc);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((p) => p.caption), ['法人事業概況説明書', '法人事業概況説明書（裏）']);
  const blocks = businessOverviewBlocks(ov, { employees: 8 });
  const main = blocks.find((b) => b.type === 'table' && b.split === 3);
  const salesRow = main.rows.find((x) => x.cells[0].text === '売上（収入）高');
  assert.equal(salesRow.cells[2].text, thousand(ov.items.sales).toLocaleString('ja-JP'));
  const text = JSON.stringify(blocks);
  assert.match(text, /計 8人/);
  assert.ok(main.rows.some((x) => x.cells[0].text === '特別損失' && x.cells[2].text === ''));
});
