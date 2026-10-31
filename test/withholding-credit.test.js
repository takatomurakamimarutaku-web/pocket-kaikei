import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withholdingCredit, validateWithholdingRows, holdingRatio } from '../js/withholding-credit.js';
import { corporateTaxReturn } from '../js/corporate-tax.js';
import { schedule61Blocks, corporateTaxDoc } from '../js/print-tax-forms.js';
import { layoutDocument } from '../js/print-layout.js';
import { buildSample } from '../js/sample.js';

const row = (kind, payer, income, tax, extra = {}) => ({ kind, payer, address: '', date: '', income, tax, periodMonths: null, heldMonths: null, ...extra });

test('別表六(一)：区分ごとに①②③を集計し、計(6)を出す。利子・その他は全額を控除', () => {
  const w = withholdingCredit([row(1, 'ポケット銀行', 10000, 1531), row(1, 'みどり信金', 2000, 306), row(5, '某社', 50000, 5105, { address: '東京都', date: '2026-06-30' })]);
  assert.equal(w.kinds[0].income, 12000);
  assert.equal(w.kinds[0].tax, 1837);
  assert.equal(w.kinds[0].credit, 1837);
  assert.equal(w.kinds[4].credit, 5105);
  assert.deepEqual(w.total, { income: 62000, tax: 6942, credit: 6942 });
  assert.equal(w.others.length, 1);
  assert.equal(w.entered, true);
});

test('別表六(一)の個別法：所有期間割合は小数点以下3位未満を切り上げ、(12)＝(8)×(11)', () => {
  // 計算期間12月のうち5月所有：5/12＝0.41666… → 0.417
  assert.equal(holdingRatio(12, 5), 417);
  assert.equal(holdingRatio(12, 12), 1000);
  assert.equal(holdingRatio(6, 4), 667);
  const w = withholdingCredit([row(2, 'A株式会社', 100000, 20420, { periodMonths: 12, heldMonths: 5 }), row(2, 'B株式会社', 30000, 6126)]);
  const a = w.prorated.find((x) => x.payer === 'A株式会社');
  assert.equal(a.credit, Math.floor((20420 * 417) / 1000));
  // 期間を入れない行は全額
  assert.equal(w.prorated.find((x) => x.payer === 'B株式会社').credit, 6126);
  assert.equal(w.kinds[1].credit, a.credit + 6126);
  assert.equal(w.kinds[1].tax, 26546);
});

test('別表六(一)の入力の検証：所得税額が収入金額を超えない、所有期間は計算期間以下、期間は両方入れる', () => {
  assert.deepEqual(validateWithholdingRows([row(1, '銀行', 100, 15)]), []);
  assert.ok(validateWithholdingRows([row(1, '', 100, 15)]).length);
  assert.ok(validateWithholdingRows([row(9, '銀行', 100, 15)]).length);
  assert.ok(validateWithholdingRows([row(1, '銀行', 100, 150)]).some((e) => /超え/.test(e)));
  assert.ok(validateWithholdingRows([row(2, '株', 100, 15, { periodMonths: 6, heldMonths: 7 })]).length);
  assert.ok(validateWithholdingRows([row(2, '株', 100, 15, { periodMonths: 6 })]).length);
});

test('法人税の計算：明細があれば、控除される所得税額は明細の③の計（別表四の加算・別表一の控除税額）', () => {
  const s = buildSample('corporation');
  const period = s.periods[0];
  const base = { ...(period.corporateTax || {}) };
  const rows = [row(1, 'ポケット銀行', 10000, 1531), row(2, 'A株式会社', 100000, 20420, { periodMonths: 12, heldMonths: 6 })];
  const r = corporateTaxReturn({ accounts: s.accounts, period, journals: s.journals, input: { ...base, withholding: 99999, withholdingRows: rows }, enterpriseInput: period.enterpriseTax || {} });
  const expected = 1531 + Math.floor((20420 * 500) / 1000);
  assert.equal(r.schedule61.credit, expected);
  assert.equal(r.schedule4.withholding, expected);
  assert.equal(r.corp.withholdingUsed + r.corp.refundWithholding, expected);
  // 明細が無ければ入力した額のまま
  const r2 = corporateTaxReturn({ accounts: s.accounts, period, journals: s.journals, input: { ...base, withholding: 3000 }, enterpriseInput: period.enterpriseTax || {} });
  assert.equal(r2.schedule4.withholding, 3000);
  assert.equal(r2.schedule61.entered, false);
  // 印刷：1枚に収まり、計(6)の③は控除額
  const doc = corporateTaxDoc(r, { head: { company: 'テスト' }, sheets: ['s61'] });
  const pages = layoutDocument(doc);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].caption, '別表六(一)');
  const blocks = schedule61Blocks(r.schedule61);
  const totalRow = blocks[0].rows.at(-1);
  assert.equal(totalRow.cells[4], expected.toLocaleString('ja-JP'));
  // 明細が無いときは入力額を計の③に出す
  assert.equal(schedule61Blocks(r2.schedule61, 3000)[0].rows.at(-1).cells[4], '3,000');
});
