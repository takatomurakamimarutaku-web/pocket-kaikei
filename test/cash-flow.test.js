import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cashFlowStatement, cashPlan, cashPlanKeyOf } from '../js/cash-flow.js';
import { journalFromTemplate } from '../js/templates.js';
import { createTemplate } from '../js/models.js';
import { makeBook } from './helpers.js';

const amounts = (cf) => Object.fromEntries(cf.sections.flatMap((s) => [...s.lines, ...(s.after || [])]).map((l) => [l.key, l.amount]));

test('キャッシュフロー計算書（法人・間接法）：各行の合計が資金の増減に一致する', () => {
  const b = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  b.opening([
    ['現金', 1000000],
    ['売掛金', 200000],
    ['商品', 100000],
    ['工具器具備品', 500000],
    ['減価償却累計額', 100000],
    ['買掛金', 150000],
    ['未払法人税等', 50000],
    ['資本金', 1000000],
    ['繰越利益剰余金', 500000],
  ]);
  const journals = [
    b.j('2026-04-10', [['売掛金', 1000000]], [['売上高', 1000000]]),
    b.j('2026-05-10', [['普通預金', 900000]], [['売掛金', 900000]]),
    b.j('2026-04-15', [['仕入高', 600000]], [['買掛金', 600000]]),
    b.j('2026-05-15', [['買掛金', 550000]], [['普通預金', 550000]]),
    b.j('2027-03-31', [['期首商品棚卸高', 100000]], [['商品', 100000]]),
    b.j('2027-03-31', [['商品', 150000]], [['期末商品棚卸高', 150000]]),
    b.j('2027-03-31', [['減価償却費', 100000]], [['減価償却累計額', 100000]]),
    b.j('2026-06-01', [['工具器具備品', 300000]], [['普通預金', 300000]]),
    b.j('2026-06-02', [['普通預金', 200000]], [['短期借入金', 200000]]),
    b.j('2026-06-28', [['繰越利益剰余金', 30000]], [['普通預金', 30000]]),
    b.j('2026-05-31', [['未払法人税等', 50000]], [['普通預金', 50000]]),
    b.j('2027-03-31', [['法人税、住民税及び事業税', 60000]], [['未払法人税等', 60000]]),
    b.j('2026-07-01', [['消耗品費', 40000]], [['現金', 40000]]),
  ];
  const cf = cashFlowStatement({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals });
  assert.deepEqual(amounts(cf), {
    profit: 310000,
    depreciation: 100000,
    gain_loss: 0,
    allowance: 0,
    receivables: -100000,
    inventories: -50000,
    payables: 50000,
    other_assets: 0,
    other_liabilities: 0,
    taxes_paid: -50000, // 未払法人税等の増加1万−法人税等6万
    fixed: -300000, // 取得30万（固定資産の純増20万＋減価償却10万）
    loans: 0,
    investments: 0,
    borrowings: 200000,
    equity: -30000, // 配当
  });
  assert.deepEqual(cf.sections.map((s) => s.total), [260000, -300000, 170000]);
  assert.equal(cf.sections[0].subtotal, 310000);
  assert.deepEqual([cf.opening, cf.closing, cf.net, cf.matches, cf.freeCashFlow], [1000000, 1130000, 130000, true, -40000]);
});

test('キャッシュフロー計算書（個人）：所得から始め、事業主貸・事業主借は財務活動の「事業主との出し入れ」', () => {
  const b = makeBook('individual');
  b.opening([['現金', 300000], ['元入金', 300000]]);
  const journals = [
    b.j('2026-02-01', [['普通預金', 500000]], [['売上高', 500000]]),
    b.j('2026-02-02', [['消耗品費', 50000]], [['現金', 50000]]),
    b.j('2026-02-03', [['事業主貸', 100000]], [['普通預金', 100000]]),
    b.j('2026-02-04', [['普通預金', 20000]], [['事業主借', 20000]]),
    b.j('2026-03-01', [['車両運搬具', 200000]], [['普通預金', 200000]]),
    b.j('2026-12-31', [['減価償却費', 40000]], [['車両運搬具', 40000]]),
    b.j('2026-04-01', [['普通預金', 100000]], [['借入金', 100000]]),
  ];
  const cf = cashFlowStatement({ entityType: 'individual', accounts: b.accounts, period: b.period, journals });
  const a = amounts(cf);
  assert.equal(a.profit, 410000);
  assert.equal(a.depreciation, 40000);
  assert.equal(a.fixed, -200000);
  assert.equal(a.borrowings, 100000);
  assert.equal(a.equity, -80000);
  assert.ok(!('taxes_paid' in a) && !('gain_loss' in a));
  assert.deepEqual([cf.net, cf.closing - cf.opening, cf.matches], [270000, 270000, true]);
});

test('資金繰り表：今月までは実績、来月からは先日付の仕訳と未作成の毎月の定型仕訳で予定を作る', () => {
  const b = makeBook('individual');
  b.opening([['普通預金', 1000000], ['元入金', 1000000]]);
  const rent = createTemplate({
    name: '家賃',
    repeatDay: 25,
    lines: [
      { side: 'debit', accountId: b.byName['地代家賃'].id, subAccountId: null, amount: 80000, taxCategory: 'purchase_10', memo: '' },
      { side: 'credit', accountId: b.byName['普通預金'].id, subAccountId: null, amount: 80000, taxCategory: 'none', memo: '' },
    ],
  });
  const journals = [
    b.j('2026-01-20', [['普通預金', 500000]], [['売掛金', 500000]]),
    b.j('2026-02-05', [['仕入高', 100000]], [['現金', 100000]]),
    b.j('2026-02-10', [['現金', 50000]], [['普通預金', 50000]]), // 口座間の移動は収支にしない
    { ...journalFromTemplate(rent, { periodId: b.period.id, date: '2026-02-25' }), no: 99 },
    b.j('2026-03-05', [['事業主貸', 30000]], [['現金', 30000]]),
    b.j('2026-03-10', [['普通預金', 9780], ['支払手数料', 220]], [['売掛金', 10000]]),
    b.j('2026-03-31', [['売掛金', 1000000]], [['売上高', 1000000]]), // 資金の動かない仕訳は対象外
    { ...journalFromTemplate(rent, { periodId: b.period.id, date: '2026-04-25' }), no: 100 }, // 4月分は先に登録済み
    b.j('2026-05-01', [['普通預金', 300000]], [['借入金', 300000]]),
  ];
  const plan = cashPlan({ accounts: b.accounts, period: b.period, journals, templates: [rent], today: '2026-03-15' });
  const [jan, feb, mar, apr, may] = plan.months;
  assert.equal(plan.opening, 1000000);
  assert.deepEqual([jan.plan, mar.plan, apr.plan], [false, false, true]);
  assert.deepEqual([jan.values.sales_in, jan.closing], [500000, 1500000]);
  assert.deepEqual([feb.values.purchase_out, feb.values.expense_out, feb.outgo, feb.closing], [100000, 80000, 180000, 1320000]);
  assert.deepEqual([mar.values.sales_in, mar.values.expense_out, mar.values.owner, mar.net, mar.closing], [10000, 220, -30000, -20220, 1299780]);
  // 4月：登録済みの家賃だけ（定型仕訳からは重ねない）。5月：借入れと、まだ作っていない家賃
  assert.deepEqual([apr.values.expense_out, apr.closing], [80000, 1219780]);
  assert.deepEqual([may.values.borrow, may.values.expense_out, may.closing], [300000, 80000, 1439780]);
  assert.equal(plan.months.at(-1).closing, 1439780 - 80000 * 7);
  // 3月末の残高は実際の残高（普通預金＋現金）と一致する
  assert.equal(mar.closing, 1000000 + 500000 - 100000 - 80000 - 30000 + 9780);
});

test('資金繰り表の行の分け方：区分と目印で決める', () => {
  const b = makeBook('corporation');
  const key = (name, effect = -1) => cashPlanKeyOf(b.byName[name], effect);
  assert.equal(key('売上高', 1), 'sales_in');
  assert.equal(key('前受金', 1), 'sales_in');
  assert.equal(key('買掛金'), 'purchase_out');
  assert.equal(key('未払金'), 'expense_out');
  assert.equal(key('法人税、住民税及び事業税'), 'tax_out');
  assert.equal(key('未払消費税等'), 'tax_out');
  assert.equal(key('工具器具備品'), 'asset');
  assert.equal(key('長期借入金', 1), 'borrow');
  assert.equal(key('資本金', 1), 'owner');
  assert.equal(key('仮払金'), 'other_out');
  assert.equal(key('預り金', 1), 'other_in');
});
