import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backCalc, summarizeTax, TAX_BY_CODE, TAX_CATEGORIES, TAX_GROUPS, signedTaxAmount } from '../js/tax.js';
import { makeBook } from './helpers.js';

test('割り戻し：10%は100/110、うち国税7.8/110。8%は100/108、6.24/108。1円未満切り捨て', () => {
  assert.deepEqual(backCalc(110000, TAX_BY_CODE.sales_10), { gross: 110000, net: 100000, tax: 10000, national: 7800, local: 2200 });
  assert.deepEqual(backCalc(108000, TAX_BY_CODE.sales_8r), { gross: 108000, net: 100000, tax: 8000, national: 6240, local: 1760 });
  // 端数：1,000円（10%）→ 税抜 909.09… → 909、税 91、国税 70.9… → 70
  assert.deepEqual(backCalc(1000, TAX_BY_CODE.purchase_10), { gross: 1000, net: 909, tax: 91, national: 70, local: 21 });
  // 返品などのマイナスは 0 方向に切り捨て（絶対値が対称）
  assert.deepEqual(backCalc(-1000, TAX_BY_CODE.purchase_10), { gross: -1000, net: -909, tax: -91, national: -70, local: -21 });
  assert.deepEqual(backCalc(5000, TAX_BY_CODE.sales_exempt), { gross: 5000, net: 5000, tax: 0, national: 0, local: 0 });
  // 上限付近でも整数で計算できる
  const big = backCalc(999_999_999_999, TAX_BY_CODE.sales_10);
  assert.equal(big.net, 909_090_909_090);
  assert.ok(Number.isSafeInteger(big.national));
});

test('符号：売上系は貸方＋借方−、仕入系は借方＋貸方−', () => {
  assert.equal(signedTaxAmount({ side: 'credit', amount: 100, taxCategory: 'sales_10' }), 100);
  assert.equal(signedTaxAmount({ side: 'debit', amount: 100, taxCategory: 'sales_10' }), -100);
  assert.equal(signedTaxAmount({ side: 'debit', amount: 100, taxCategory: 'purchase_8r' }), 100);
  assert.equal(signedTaxAmount({ side: 'credit', amount: 100, taxCategory: 'purchase_8r' }), -100);
  assert.equal(signedTaxAmount({ side: 'debit', amount: 100, taxCategory: 'none' }), 0);
});

test('税区分別集計：売上・返品・仕入・軽減・非課税、期間の絞り込み', () => {
  const b = makeBook('individual');
  const js = [
    b.j('2026-01-10', [['売掛金', 110000]], [['売上高', 110000]]),
    b.j('2026-01-20', [['売上高', 11000]], [['売掛金', 11000]]), // 返品
    b.j('2026-02-01', [['仕入高', 54000, 'purchase_8r']], [['買掛金', 54000]]),
    b.j('2026-02-03', [['消耗品費', 3300]], [['現金', 3300]]),
    b.j('2026-02-05', [['損害保険料', 20000]], [['普通預金', 20000]]),
    b.j('2026-03-01', [['普通預金', 22000]], [['売上高', 22000]]),
  ];
  const all = summarizeTax(js);
  const row = (code) => all.rows.find((r) => r.code === code);
  assert.equal(row('sales_10').gross, 121000);
  assert.equal(row('sales_10').net, 110000);
  assert.equal(row('sales_10').count, 3);
  assert.equal(row('purchase_8r').tax, 4000);
  assert.equal(row('purchase_10').gross, 3300);
  assert.equal(row('purchase_exempt').gross, 20000);
  assert.equal(row('purchase_exempt').tax, 0);
  const group = (id) => all.groups.find((g) => g.id === id);
  assert.equal(group('sales').total.tax, 11000);
  assert.equal(group('purchase').total.tax, 4300);
  assert.equal(group('other').total.gross, 20000); // 非課税仕入
  assert.equal(all.netTax, 11000 - 4300);
  const jan = summarizeTax(js, { from: '2026-01-01', to: '2026-01-31' });
  assert.equal(jan.rows.find((r) => r.code === 'sales_10').gross, 99000);
});

test('詳しい税区分：返品・貸倒れは借方、仕入の返品は貸方がプラス。輸入の消費税は金額がそのまま税額', () => {
  assert.equal(signedTaxAmount({ side: 'debit', amount: 100, taxCategory: 'sales_return_10' }), 100);
  assert.equal(signedTaxAmount({ side: 'credit', amount: 100, taxCategory: 'sales_return_10' }), -100);
  assert.equal(signedTaxAmount({ side: 'debit', amount: 100, taxCategory: 'sales_baddebt_8r' }), 100);
  assert.equal(signedTaxAmount({ side: 'credit', amount: 100, taxCategory: 'sales_recovered_10' }), 100);
  assert.equal(signedTaxAmount({ side: 'credit', amount: 100, taxCategory: 'purchase_return_10_c' }), 100);
  assert.deepEqual(backCalc(50000, TAX_BY_CODE.import_tax), { gross: 50000, net: 0, tax: 50000, national: 50000, local: 0 });
  assert.deepEqual(backCalc(12000, TAX_BY_CODE.import_local), { gross: 12000, net: 0, tax: 12000, national: 0, local: 12000 });
  // どの税区分にもグループ・役割・プラスの側がある。コードは重複しない
  for (const c of TAX_CATEGORIES) {
    assert.ok(TAX_GROUPS.some((g) => g.id === c.group), c.code);
    assert.ok(['debit', 'credit'].includes(c.plus), c.code);
    assert.ok(c.role, c.code);
  }
  assert.equal(new Set(TAX_CATEGORIES.map((c) => c.code)).size, TAX_CATEGORIES.length);
  // 既存のコードはそのまま使える（保存済みの仕訳・バックアップの互換）
  for (const code of ['none', 'sales_10', 'sales_8r', 'sales_export', 'sales_exempt', 'purchase_10', 'purchase_8r', 'purchase_10_ni', 'purchase_8r_ni', 'purchase_exempt']) assert.ok(TAX_BY_CODE[code], code);
});

test('集計：売上の返品は「売上の返品・値引き・貸倒れ」にプラスで出し、参考の差引税額から引く', () => {
  const b = makeBook('individual');
  const js = [
    b.j('2026-01-10', [['売掛金', 110000]], [['売上高', 110000, 'sales_10']]),
    b.j('2026-01-20', [['売上高', 11000, 'sales_return_10']], [['売掛金', 11000]]),
  ];
  const s = summarizeTax(js);
  const adj = s.groups.find((g) => g.id === 'sales_adj');
  assert.equal(adj.total.gross, 11000);
  assert.equal(adj.total.tax, 1000);
  assert.equal(s.netTax, 10000 - 1000);
});
