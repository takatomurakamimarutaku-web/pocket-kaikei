import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTaxReturn } from '../js/tax-return.js';
import { taxReturnForms } from '../js/tax-forms.js';
import { makeBook } from './helpers.js';
import { consumptionTaxDoc, consumptionSheets, consumptionSheetBlocks } from '../js/print-tax-forms.js';
import { layoutDocument } from '../js/print-layout.js';

const period2026 = { startDate: '2026-01-01', endDate: '2026-12-31' };
const byNo = (rows) => Object.fromEntries(rows.map((r) => [r.no, r]));

// 国税庁 消費税の申告書の作成例（設例5・2割特例）https://www.nta.go.jp/taxes/tetsuzuki/shinsei/shinkoku/shohi/pdf/015.pdf
function ntaExample() {
  const book = makeBook('individual');
  return [
    book.j('2026-03-01', [['売掛金', 1192000]], [['売上高', 1192000, 'sales_8r']]),
    book.j('2026-03-01', [['売掛金', 7516450]], [['売上高', 7516450, 'sales_10']]),
    book.j('2026-04-01', [['売上高', 11300, 'sales_return_8r']], [['売掛金', 11300]]),
    book.j('2026-04-01', [['売上高', 45890, 'sales_return_10']], [['売掛金', 45890]]),
    book.j('2026-05-01', [['貸倒金', 22000, 'sales_baddebt_8r']], [['売掛金', 22000]]),
    book.j('2026-05-01', [['貸倒金', 16000, 'sales_baddebt_10']], [['売掛金', 16000]]),
    book.j('2026-06-01', [['現金', 30000]], [['雑収入', 30000, 'sales_recovered_8r']]),
    book.j('2026-06-01', [['現金', 56000]], [['雑収入', 56000, 'sales_recovered_10']]),
  ];
}

test('付表6（2割特例）：国税庁の設例の各欄と一致する', () => {
  const r = computeTaxReturn({ journals: ntaExample(), period: period2026, entityType: 'individual', method: 'twenty' });
  const f = taxReturnForms(r);
  assert.deepEqual(f.sheets.map((s) => s.id), ['付表6']);
  const s = byNo(f.sheets[0].rows);
  const v = (no) => [s[no].a, s[no].b, s[no].c];
  assert.deepEqual(v('①'), [1103703, 6833136, 7936839]);
  assert.deepEqual(v('②'), [1103000, 6833000, 7936000]);
  assert.deepEqual(v('③'), [68827, 532974, 601801]);
  assert.deepEqual(v('④'), [1733, 3970, 5703]);
  assert.deepEqual(v('⑤'), [652, 3254, 3906]);
  assert.deepEqual(v('⑥'), [69908, 533690, 603598]);
  assert.deepEqual(v('⑦'), [55926, 426952, 482878]);
  assert.deepEqual(v('⑧'), [1271, 1134, 2405]);
  const first = byNo(f.first.rows);
  assert.equal(first['④'].value, 482878);
  assert.equal(first['③'].value, 5703);
  assert.equal(first['⑨'].value, 118300);
  assert.equal(first['⑳'].value, 33300);
  assert.equal(first['㉖'].value, 151600);
  assert.match(f.first.flags.join(), /2割特例/);
  const second = byNo(f.second.rows);
  assert.deepEqual([second['⑤'].value, second['⑥'].value, second['⑦'].value], [1103703, 6833136, 7936839]);
  assert.deepEqual([second['⑮'].value, second['⑯'].value, second['⑰'].value], [68827, 532974, 3906]);
});

test('第一表の欄は計算結果と一致し、合計税額㉖＝⑪＋㉒（中間納付を引いた残り）', () => {
  const book = makeBook('individual');
  const journals = [
    book.j('2026-03-31', [['普通預金', 5500000]], [['売上高', 5500000, 'sales_10']]),
    book.j('2026-04-10', [['仕入高', 2200000, 'purchase_10']], [['普通預金', 2200000]]),
    book.j('2026-06-10', [['外注工賃', 110000, 'purchase_10_ni']], [['普通預金', 110000]]),
  ];
  for (const method of ['general', 'simplified', 'twenty']) {
    const r = computeTaxReturn({ journals, period: period2026, entityType: 'individual', method, interimNational: 10000, interimLocal: 2800 });
    const f = byNo(taxReturnForms(r, { baseSales: 4800000 }).first.rows);
    assert.equal(f['①'].value, r.base10);
    assert.equal(f['④'].value, r.deduction, method);
    assert.equal(f['⑦'].value, r.deductionTotal);
    assert.equal(f['⑨'].value, r.net);
    assert.equal(f['⑪'].value, r.payableNational);
    assert.equal(f['⑳'].value, r.local);
    assert.equal(f['㉒'].value, r.payableLocal);
    assert.equal(f['㉖'].value, r.payable);
    if (method === 'simplified') assert.equal(f['⑯'].value, 4800000);
  }
});

test('付表2-3：課税売上割合95%未満・個別対応方式の欄（⑰⑲⑳㉑㉖）', () => {
  const book = makeBook('corporation');
  const journals = [
    book.j('2026-02-01', [['売掛金', 11000000]], [['売上高', 11000000, 'sales_10']]),
    book.j('2026-02-01', [['普通預金', 2000000]], [['売上高', 2000000, 'sales_exempt']]),
    book.j('2026-04-01', [['仕入高', 3300000, 'purchase_10']], [['普通預金', 3300000]]),
    book.j('2026-04-01', [['地代家賃', 1100000, 'purchase_10_c']], [['普通預金', 1100000]]),
    book.j('2026-04-01', [['仕入高', 108000, 'purchase_8r']], [['普通預金', 108000]]),
  ];
  const r = computeTaxReturn({ journals, period: period2026, entityType: 'corporation', method: 'general', allocation: 'individual' });
  const f = taxReturnForms(r);
  assert.deepEqual(f.sheets.map((s) => s.id), ['付表1-3', '付表2-3']);
  const s = byNo(f.sheets[1].rows);
  assert.equal(s['④'].c, 10000000);
  assert.equal(s['⑦'].c, 12000000);
  assert.equal(s['⑧'].text, '83.33%');
  assert.deepEqual([s['⑰'].a, s['⑰'].b], [6240, 312000]); // 108,000×6.24/108、(3,300,000＋1,100,000)×7.8/110
  assert.equal(s['⑱'].c, null);
  assert.deepEqual([s['⑲'].b, s['⑳'].b], [234000, 78000]);
  assert.equal(s['㉑'].b, 234000 + 65000); // 78,000×10,000,000/12,000,000
  assert.equal(s['㉒'].c, null);
  assert.equal(s['㉖'].c, r.deduction);
  const s13 = byNo(f.sheets[0].rows);
  assert.equal(s13['④'].c, r.deduction);
  assert.equal(s13['⑨'].c, r.net);
});

test('付表5-3（簡易課税）：④×みなし仕入率', () => {
  const r = computeTaxReturn({ journals: ntaExample(), period: period2026, entityType: 'individual', method: 'simplified', businessType: 2 });
  const f = taxReturnForms(r);
  assert.deepEqual(f.sheets.map((s) => s.id), ['付表4-3', '付表5-3']);
  const s = byNo(f.sheets[1].rows);
  assert.deepEqual([s['④'].a, s['④'].b], [69908, 533690]);
  assert.deepEqual([s['⑤'].a, s['⑤'].b, s['⑤'].c], [55926, 426952, 482878]); // 80%
  assert.equal(byNo(f.first.rows)['④'].value, r.deduction);
});

test('印刷：付表は税率6.24%（A）・7.8%（B）・合計（C）の列に並べ、申告書は表ごとに改ページする', () => {
  const r = computeTaxReturn({ journals: ntaExample(), period: period2026, entityType: 'individual', method: 'twenty' });
  const f = taxReturnForms(r);
  const [table] = consumptionSheetBlocks(f.sheets[0]);
  assert.deepEqual(table.columns.map((c) => c.label), ['区　　分', '番号', '税率6.24%適用分\nA', '税率7.8%適用分\nB', '合計 C\n(A＋B)']);
  const row7 = table.rows.find((x) => x.cells[1].text === '⑦');
  assert.deepEqual(row7.cells.slice(2), ['55,926', '426,952', '482,878']);
  assert.deepEqual(consumptionSheets(f).map((s) => s.value), ['first', 'second', '付表6']);
  const doc = consumptionTaxDoc(f, { head: { company: 'テスト' } });
  const pages = layoutDocument(doc);
  assert.deepEqual(pages.map((p) => p.title), ['消費税及び地方消費税の申告書', '課税標準額等の内訳書', '税率別消費税額計算表（2割特例）']);
  assert.deepEqual(pages.map((p) => p.caption), ['第一表（一般用）', '第二表', '付表6']);
  // 第一表の㉖（合計税額）が左右2段の表に入っている
  const texts = pages[0].items.filter((it) => it.t === 'text').map((it) => it.text);
  assert.ok(texts.includes('151,600'));
  assert.equal(layoutDocument(consumptionTaxDoc(f, { head: {}, sheets: ['second'] })).length, 1);
});
