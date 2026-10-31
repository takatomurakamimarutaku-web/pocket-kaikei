import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applicationRows, validateApplicationRows } from '../js/application-statement.js';
import { corporateTaxReturn } from '../js/corporate-tax.js';
import { corporateTaxDoc } from '../js/print-tax-forms.js';
import { layoutDocument } from '../js/print-layout.js';
import { filerOf } from '../js/filer.js';
import { buildSample } from '../js/sample.js';

const corp = (income, low, rate = 15000) => ({ income, tiers: [{ label: '年800万円相当額以下の金額', amount: low, rate, tax: 0 }, { label: '年800万円相当額を超える金額', amount: Math.max(0, income - low), rate: 23200, tax: 0 }] });

test('適用額明細書：中小法人の軽減税率は 第42条の３の２第１項の表の第１号・00380・年800万円以下の金額（千円未満切捨て）', () => {
  const rows = applicationRows({ corp: corp(12345000, 8000000), sme: true });
  assert.deepEqual(rows.map((x) => [x.article, x.code, x.amount]), [['第42条の３の２第１項の表の第１号', '00380', 8000000]]);
  // 所得が0以下・中小法人でない・本則の19%（適用除外事業者など）は書かない
  assert.equal(applicationRows({ corp: corp(0, 0), sme: true }).length, 0);
  assert.equal(applicationRows({ corp: corp(5000000, 5000000), sme: false }).length, 0);
  assert.equal(applicationRows({ corp: corp(5000000, 5000000, 19000), sme: true }).length, 0);
});

test('適用額明細書：少額減価償却資産の特例は 第67条の５第１項・00277・取得価額の合計（上限まで）。利用者の行はそのあと', () => {
  const rows = applicationRows({ corp: corp(1000000, 1000000), sme: true, smeAssets: { total: 3500000, limit: 3000000 }, rows: [{ article: ' 第42条の12の５第２項 ', code: '００７００', amount: 120000 }] });
  assert.deepEqual(rows.map((x) => [x.code, x.amount, x.auto]), [['00380', 1000000, true], ['00277', 3000000, true], ['00700', 120000, false]]);
  assert.equal(rows[2].article, '第42条の12の５第２項');
  assert.deepEqual(validateApplicationRows([{ article: '第42条', code: '00700', amount: 1 }]), []);
  assert.ok(validateApplicationRows([{ article: '', code: '00700', amount: 1 }]).length);
  assert.ok(validateApplicationRows([{ article: '第42条', code: '700', amount: 1 }]).length);
  assert.ok(validateApplicationRows([{ article: '第42条', code: '00700', amount: -1 }]).length);
});

test('適用額明細書の印刷：頭書き（資本金・所得金額）と20行の表が1枚に収まる', () => {
  const s = buildSample('corporation');
  const period = s.periods[0];
  const r = corporateTaxReturn({ accounts: s.accounts, period, journals: s.journals, input: period.corporateTax || {}, enterpriseInput: period.enterpriseTax || {} });
  const filer = filerOf({ businessName: 'サンプル製作所株式会社', entityType: 'corporation', filer: { taxOffice: '麹町', corporateNumber: '8700110005901' } });
  const doc = corporateTaxDoc(r, { head: { company: 'x' }, filer, sheets: ['tekiyo'], smeAssets: { total: 250000, limit: 3000000 } });
  const pages = layoutDocument(doc);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].caption, '適用額明細書');
  const table = doc.blocks.find((b) => b.type === 'table' && b.columns[1]?.label === '区分番号');
  assert.equal(table.rows.length, 20);
  assert.ok(table.rows.some((x) => x.cells[1].text === '00277'));
  const head = doc.blocks[1].rows.flatMap((x) => x.cells.map((c) => (typeof c === 'object' ? c.text : c))).join('|');
  assert.match(head, /所得金額又は欠損金額/);
  assert.match(head, /麹町税務署長殿/);
});
