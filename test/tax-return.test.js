import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTaxReturn, transitionalRate, methodAvailability, taxBuckets } from '../js/tax-return.js';
import { makeBook } from './helpers.js';

const period2026 = { startDate: '2026-01-01', endDate: '2026-12-31' };

function sample() {
  const book = makeBook('individual');
  const journals = [
    book.j('2026-03-31', [['普通預金', 5500000]], [['売上高', 5500000, 'sales_10']]),
    book.j('2026-04-10', [['仕入高', 2200000, 'purchase_10']], [['普通預金', 2200000]]),
    book.j('2026-06-10', [['外注工賃', 110000, 'purchase_10_ni']], [['普通預金', 110000]]),
  ];
  return { book, journals };
}

test('経過措置の控除割合：課税仕入れの日で 100→80→70→50→30→0%（令和8年度改正後）', () => {
  assert.equal(transitionalRate('2023-09-30'), 100);
  assert.equal(transitionalRate('2023-10-01'), 80);
  assert.equal(transitionalRate('2026-09-30'), 80);
  assert.equal(transitionalRate('2026-10-01'), 70);
  assert.equal(transitionalRate('2028-09-30'), 70);
  assert.equal(transitionalRate('2028-10-01'), 50);
  assert.equal(transitionalRate('2030-10-01'), 30);
  assert.equal(transitionalRate('2031-10-01'), 0);
});

test('一般課税：課税標準額は千円未満、差引税額は百円未満を切り捨て、地方消費税は22/78', () => {
  const { journals } = sample();
  const r = computeTaxReturn({ journals, period: period2026, entityType: 'individual', method: 'general' });
  assert.equal(r.base10, 5000000);
  assert.equal(r.salesTax, 390000); // 5,000,000 × 7.8%
  assert.equal(r.purchaseTax10, 156000); // 2,200,000 × 7.8/110
  assert.deepEqual(r.transitional.map((t) => [t.pct, t.tax]), [[80, 6240]]); // 110,000 × 7.8/110 × 80%
  assert.equal(r.deduction, 162240);
  assert.equal(r.net, 227700); // 227,760 → 百円未満切り捨て
  assert.equal(r.local, 64200); // 227,700 × 22/78 = 64,223 → 64,200
  assert.equal(r.payable, 291900);
  assert.deepEqual(r.warnings, []);
});

test('端数：課税標準額の千円未満切り捨て、国の資料の地方消費税の設例（231,200円→65,200円）', () => {
  const book = makeBook('individual');
  const journals = [book.j('2026-05-01', [['現金', 1234567]], [['売上高', 1234567, 'sales_10']])];
  const r = computeTaxReturn({ journals, period: period2026, entityType: 'individual', method: 'general' });
  assert.equal(r.base10, 1122000); // 1,234,567 × 100/110 = 1,122,333 → 1,122,000
  assert.equal(r.salesTax, 87516); // 1,122,000 × 7.8% = 87,516
  // 地方消費税の計算だけを確かめる：差引税額 231,200 のとき
  const r2 = computeTaxReturn({ journals: [book.j('2026-05-01', [['現金', 3260000]], [['売上高', 3260000, 'sales_10']])], period: period2026, entityType: 'individual', method: 'general' });
  assert.equal(r2.net, 231100); // 3,260,000×100/110=2,963,636→2,963,000、×7.8%=231,114→231,100
  assert.equal(Math.floor((231200 * 22) / 78 / 100) * 100, 65200);
});

test('軽減税率：課税標準額は108分の100、税額は6.24%', () => {
  const book = makeBook('individual');
  const journals = [book.j('2026-05-01', [['現金', 1080000]], [['売上高', 1080000, 'sales_8r']]), book.j('2026-05-02', [['仕入高', 540000, 'purchase_8r']], [['現金', 540000]])];
  const r = computeTaxReturn({ journals, period: period2026, entityType: 'individual', method: 'general' });
  assert.equal(r.base8, 1000000);
  assert.equal(r.salesTax8, 62400);
  assert.equal(r.purchaseTax8, 31200);
  assert.equal(r.net, 31200);
});

test('簡易課税・2割特例・3割特例：売上の消費税額×みなし仕入率／80%／70%', () => {
  const { journals } = sample();
  const simp = computeTaxReturn({ journals, period: period2026, entityType: 'individual', method: 'simplified', businessType: 5 });
  assert.deepEqual([simp.deduction, simp.net, simp.local], [195000, 195000, 55000]);
  assert.match(simp.warnings.join(), /一般課税だけ/); // インボイスなしの仕入があっても使わない
  const twenty = computeTaxReturn({ journals, period: period2026, entityType: 'individual', method: 'twenty' });
  assert.deepEqual([twenty.net, twenty.local, twenty.payable], [78000, 22000, 100000]);
  assert.equal(twenty.compare.general.total, 291900);
  assert.equal(twenty.compare.thirty.unavailable, '3割特例は令和9年分・令和10年分だけです');
});

test('使える方法：2割特例は令和8年9月30日を含む期間まで、3割特例は個人の令和9・10年分', () => {
  assert.equal(methodAvailability('twenty', period2026, 'individual'), null);
  assert.equal(methodAvailability('twenty', { startDate: '2026-04-01', endDate: '2027-03-31' }, 'corporation'), null);
  assert.match(methodAvailability('twenty', { startDate: '2026-10-01', endDate: '2027-09-30' }, 'corporation'), /2割特例/);
  assert.equal(methodAvailability('thirty', { startDate: '2027-01-01', endDate: '2027-12-31' }, 'individual'), null);
  assert.match(methodAvailability('thirty', { startDate: '2027-04-01', endDate: '2028-03-31' }, 'corporation'), /個人/);
  assert.match(methodAvailability('thirty', { startDate: '2029-01-01', endDate: '2029-12-31' }, 'individual'), /令和9年/);
});

test('インボイスなしの仕入は日付ごとの割合で分ける（令和8年10月から70%）', () => {
  const book = makeBook('individual');
  const journals = [
    book.j('2026-09-30', [['外注工賃', 110000, 'purchase_10_ni']], [['現金', 110000]]),
    book.j('2026-10-01', [['外注工賃', 110000, 'purchase_10_ni']], [['現金', 110000]]),
  ];
  const b = taxBuckets(journals, { from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(b.transitional.map((t) => [t.pct, t.gross]).sort(), [[70, 110000], [80, 110000]]);
  const r = computeTaxReturn({ journals, period: period2026, entityType: 'individual', method: 'general' });
  assert.deepEqual(r.transitional.map((t) => t.tax).sort(), [5460, 6240]);
  assert.equal(r.net, -11700); // 控除しきれない分は還付（1円単位）
});

test('中間納付を差し引き、返品（売上の借方）は売上から引く', () => {
  const { book, journals } = sample();
  journals.push(book.j('2026-07-01', [['売上高', 110000, 'sales_10']], [['普通預金', 110000]]));
  const r = computeTaxReturn({ journals, period: period2026, entityType: 'individual', method: 'twenty', interimNational: 30000, interimLocal: 8400 });
  assert.equal(r.base10, 4900000);
  assert.equal(r.salesTax, 382200);
  assert.equal(r.net, 76400); // 382,200 × 20% = 76,440 → 76,400
  assert.equal(r.payableNational, 46400);
  assert.equal(r.payableLocal, 21500 - 8400); // 76,400×22/78=21,548→21,500
});

test('課税売上割合が95%未満なら注意する', () => {
  const book = makeBook('individual');
  const journals = [
    book.j('2026-05-01', [['現金', 110000]], [['売上高', 110000, 'sales_10']]),
    book.j('2026-05-01', [['現金', 900000]], [['雑収入', 900000, 'sales_exempt']]),
  ];
  const r = computeTaxReturn({ journals, period: period2026, entityType: 'individual', method: 'general' });
  assert.match(r.warnings.join(), /95%未満/);
});

test('消費税等の仕訳：法人は未払消費税等、個人は未払金。0円以下は作らない', async () => {
  const { consumptionTaxLines } = await import('../js/tax-return.js');
  for (const [entityType, credit] of [['corporation', '未払消費税等'], ['individual', '未払金']]) {
    const { accounts } = makeBook(entityType);
    const { lines, errors } = consumptionTaxLines({ amount: 291900, accounts });
    assert.deepEqual(errors, []);
    assert.deepEqual(lines.map((l) => [l.side, accounts.find((a) => a.id === l.accountId).name, l.amount]), [['debit', '租税公課', 291900], ['credit', credit, 291900]]);
  }
  assert.match(consumptionTaxLines({ amount: 0, accounts: makeBook('individual').accounts }).errors.join(), /不要/);
});
