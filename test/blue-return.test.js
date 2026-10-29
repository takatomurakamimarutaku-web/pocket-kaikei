import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blueIncomeStatement, monthlySalesPurchases, depreciationTable, blueBalanceSheet } from '../js/blue-return.js';
import { incomeStatement, closingRows } from '../js/statements.js';
import { createAccount } from '../js/models.js';
import { makeBook } from './helpers.js';

function book() {
  const b = makeBook('individual');
  // 期首：現金 50,000・普通預金 500,000・商品 80,000・敷金 100,000・買掛金 30,000 → 元入金 700,000
  b.opening([['現金', 50000], ['普通預金', 500000], ['商品', 80000], ['敷金', 100000], ['買掛金', 30000], ['元入金', 700000]]);
  const extra = createAccount({ code: '624', name: 'ソフト利用料', group: 'sga', normalSide: 'debit' });
  b.accounts.push(extra);
  b.byName['ソフト利用料'] = extra;
  const journals = [
    b.j('2026-01-10', [['普通預金', 330000]], [['売上高', 330000]]),
    b.j('2026-02-10', [['普通預金', 220000]], [['売上高', 220000]]),
    b.j('2026-02-15', [['現金', 5000]], [['雑収入', 5000]]),
    b.j('2026-01-20', [['仕入高', 110000]], [['買掛金', 110000]]),
    b.j('2026-03-01', [['通信費', 8800]], [['普通預金', 8800]]),
    b.j('2026-03-05', [['ソフト利用料', 1100]], [['普通預金', 1100]]),
    b.j('2026-03-06', [['雑費', 500]], [['現金', 500]]),
    b.j('2026-04-01', [['事業主貸', 50000]], [['普通預金', 50000]]),
    b.j('2026-04-02', [['普通預金', 20000]], [['事業主借', 20000]]),
    b.j('2026-05-01', [['専従者給与', 60000]], [['普通預金', 60000]]),
    // 期末棚卸（期首 80,000 → 期末 90,000）
    b.j('2026-12-31', [['期首商品棚卸高', 80000]], [['商品', 80000]]),
    b.j('2026-12-31', [['商品', 90000]], [['期末商品棚卸高', 90000]]),
  ];
  return { b, journals };
}

test('損益計算書：売上原価・経費・専従者給与から ㊸ と青色申告特別控除・所得金額', () => {
  const { b, journals } = book();
  const { lines: L, expenses } = blueIncomeStatement({ accounts: b.accounts, period: b.period, journals, deduction: 650000 });
  assert.equal(L[1], 555000); // 売上 550,000 + 雑収入 5,000
  assert.deepEqual([L[2], L[3], L[4], L[5], L[6], L[7]], [80000, 110000, 190000, 90000, 100000, 455000]);
  assert.equal(L[12], 8800);
  assert.equal(expenses.find((e) => e.no === 25).label, 'ソフト利用料'); // テンプレートにない科目は空欄の行へ
  assert.equal(L[25], 1100);
  assert.equal(L[31], 500);
  assert.equal(L[32], 10400);
  assert.equal(L[33], 444600);
  assert.equal(L[38], 60000);
  assert.equal(L[43], 384600);
  assert.equal(L[44], 384600); // 所得が65万円より少ないので所得まで
  assert.equal(L[45], 0);
  // 決算書の損益計算書と同じ所得になる
  const rows = closingRows({ accounts: b.accounts, period: b.period, journals });
  assert.equal(incomeStatement('individual', rows).netIncome, L[43]);
});

test('青色申告特別控除：所得が多ければ選んだ額', () => {
  const { b, journals } = book();
  journals.push(b.j('2026-06-01', [['売掛金', 2000000]], [['売上高', 2000000]]));
  const { lines: L } = blueIncomeStatement({ accounts: b.accounts, period: b.period, journals, deduction: 550000 });
  assert.equal(L[44], 550000);
  assert.equal(L[45], L[43] - 550000);
});

test('月別売上・仕入：雑収入は別の行、合計は ① と ③ に一致', () => {
  const { b, journals } = book();
  const m = monthlySalesPurchases({ accounts: b.accounts, period: b.period, journals });
  assert.equal(m.months.length, 12);
  assert.deepEqual([m.months[0].sales, m.months[1].sales, m.months[0].purchases], [330000, 220000, 110000]);
  assert.equal(m.misc, 5000);
  const { lines: L } = blueIncomeStatement({ accounts: b.accounts, period: b.period, journals });
  assert.equal(m.salesTotal, L[1]);
  assert.equal(m.purchasesTotal, L[3]);
});

test('減価償却費の計算：償却の基礎・率・月数・事業専用割合・未償却残高', () => {
  const b = makeBook('individual');
  const assets = [
    { id: 'a', name: '軽自動車', category: 'vehicle', accountId: b.byName['車両運搬具'].id, acquiredOn: '2026-07-01', startedOn: '2026-07-01', cost: 1200000, method: 'straight', usefulLife: 4, businessRatio: 70 },
    { id: 'b', name: 'デスク', category: 'tools', accountId: b.byName['工具器具備品'].id, acquiredOn: '2026-05-01', startedOn: '2026-05-01', cost: 150000, method: 'lump3', usefulLife: null, businessRatio: 100 },
  ];
  const t = depreciationTable({ assets, periods: [b.period], period: b.period });
  const car = t.rows.find((r) => r.name === '軽自動車');
  assert.deepEqual([car.base, car.rate, car.months, car.amount, car.ratio, car.business, car.closing], [1200000, '0.250', '6/12', 150000, 70, 105000, 1050000]);
  const desk = t.rows.find((r) => r.name === 'デスク');
  assert.deepEqual([desk.rate, desk.amount, desk.note], ['1/3', 50000, '一括償却資産']);
  assert.equal(t.total.business, 155000);
});

test('貸借対照表：期首・期末とも資産合計＝負債・資本合計（期末は控除前の所得を含む）', () => {
  const { b, journals } = book();
  const { lines: L } = blueIncomeStatement({ accounts: b.accounts, period: b.period, journals });
  const bs = blueBalanceSheet({ accounts: b.accounts, period: b.period, journals, incomeBeforeDeduction: L[43] });
  assert.ok(bs.balanced, JSON.stringify(bs.totals));
  assert.equal(bs.totals.assetsOpening, 730000);
  const label = (list, l) => list.find((x) => x.label === l);
  assert.equal(label(bs.assets, 'その他の預金').closing, 500000 + 330000 + 220000 - 8800 - 1100 - 50000 + 20000 - 60000);
  assert.equal(label(bs.assets, '棚卸資産').closing, 90000);
  assert.equal(label(bs.assets, '敷金').blank, true); // 様式にない科目は空欄の行
  assert.equal(label(bs.assets, '事業主貸').closing, 50000);
  assert.equal(label(bs.liabilities, '元入金').closing, 700000);
  assert.equal(label(bs.liabilities, '事業主借').closing, 20000);
  assert.equal(label(bs.liabilities, '青色申告特別控除前の所得金額').closing, 384600);
});
