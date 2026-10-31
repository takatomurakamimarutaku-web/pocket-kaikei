import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { openDB, ValidationError } from '../js/db.js';
import { templateAccounts } from '../js/accounts.js';
import { whiteIncomeStatement, whiteRealEstateStatement, whiteReturnSet, familyWorkerDeductions, validateWhiteReturnSettings, whiteDetails, isWhite } from '../js/white-return.js';
import { blueIncomeStatement } from '../js/blue-return.js';
import { realEstateIncomeStatement } from '../js/real-estate.js';
import { incomeStatement, balanceSheet, closingRows, incomeBeforeLabel } from '../js/statements.js';
import { computeIncomeTax, validateIncomeTax, DEFAULT_INCOME_TAX } from '../js/income-tax.js';
import { createAccount, createPeriod, createSettings } from '../js/models.js';
import { makeBook } from './helpers.js';

const WHITE = { entityType: 'individual', filing: 'white', realEstate: 'none' };

/** 小売業（白色申告）：売上 3,000,000・雑収入 50,000、棚卸、経費、帳簿に専従者給与・貸倒引当金繰入がある */
function shopBook() {
  const b = makeBook('individual', { subs: [['売上高', 'A商店'], ['売上高', 'B商店'], ['仕入高', 'C問屋'], ['地代家賃', '大家 田中']] });
  b.opening([['普通預金', 2000000], ['商品', 200000], ['元入金', 2200000]]);
  const journals = [
    b.j('2026-03-31', [['普通預金', 1800000]], [['売上高', 1800000, undefined, 'A商店']]),
    b.j('2026-06-30', [['普通預金', 1200000]], [['売上高', 1200000, undefined, 'B商店']]),
    b.j('2026-06-30', [['普通預金', 50000]], [['雑収入', 50000]]),
    b.j('2026-01-01', [['期首商品棚卸高', 200000]], [['商品', 200000]]),
    b.j('2026-05-31', [['仕入高', 1000000, undefined, 'C問屋']], [['普通預金', 1000000]]),
    b.j('2026-12-31', [['商品', 300000]], [['期末商品棚卸高', 300000]]),
    b.j('2026-12-31', [['給料賃金', 400000]], [['普通預金', 400000]]),
    b.j('2026-12-31', [['外注工賃', 100000]], [['普通預金', 100000]]),
    b.j('2026-12-31', [['減価償却費', 120000]], [['工具器具備品', 120000]]),
    b.j('2026-12-31', [['地代家賃', 600000, undefined, '大家 田中']], [['普通預金', 600000]]),
    b.j('2026-12-31', [['利子割引料', 20000]], [['普通預金', 20000]]),
    b.j('2026-12-31', [['租税公課', 30000]], [['普通預金', 30000]]),
    b.j('2026-12-31', [['通信費', 60000]], [['普通預金', 60000]]),
    b.j('2026-12-31', [['消耗品費', 40000]], [['普通預金', 40000]]),
    b.j('2026-12-31', [['支払手数料', 15000]], [['普通預金', 15000]]),
    b.j('2026-12-31', [['車両費', 25000]], [['普通預金', 25000]]),
    b.j('2026-12-31', [['雑費', 5000]], [['普通預金', 5000]]),
    b.j('2026-12-31', [['専従者給与', 300000]], [['普通預金', 300000]]),
    b.j('2026-12-31', [['貸倒引当金繰入額', 10000]], [['貸倒引当金', 10000]]),
  ];
  b.period.openingBalances.push({ accountId: b.byName['工具器具備品'].id, subAccountId: null, amount: 500000 }, { accountId: b.byName['元入金'].id, subAccountId: null, amount: 500000 });
  return { b, journals };
}

/** 不動産所得（アパート）：収入 2,000,000、不動産経費 865,000 */
function reBook() {
  const b = makeBook('individual', { realEstate: true, subs: [['賃貸料', '101号 山田'], ['借入金利子（不動産）', 'X銀行']] });
  b.opening([['普通預金', 1000000], ['元入金', 1000000]]);
  const journals = [
    b.j('2026-03-31', [['普通預金', 2000000]], [['売上高', 2000000]]),
    b.j('2026-03-31', [['通信費', 100000]], [['普通預金', 100000]]),
    b.j('2026-12-31', [['普通預金', 1800000]], [['賃貸料', 1800000, undefined, '101号 山田']]),
    b.j('2026-04-01', [['普通預金', 140000]], [['礼金・権利金・更新料', 140000]]),
    b.j('2026-12-31', [['普通預金', 60000]], [['名義書換料その他', 60000]]),
    b.j('2026-06-30', [['租税公課（不動産）', 120000]], [['普通預金', 120000]]),
    b.j('2026-06-30', [['損害保険料（不動産）', 30000]], [['普通預金', 30000]]),
    b.j('2026-06-30', [['修繕費（不動産）', 50000]], [['普通預金', 50000]]),
    b.j('2026-12-31', [['減価償却費（不動産）', 300000]], [['普通預金', 300000]]),
    b.j('2026-12-31', [['借入金利子（不動産）', 200000, undefined, 'X銀行']], [['普通預金', 200000]]),
    b.j('2026-12-31', [['給料賃金（不動産）', 60000]], [['普通預金', 60000]]),
    b.j('2026-12-31', [['管理費（不動産）', 90000]], [['普通預金', 90000]]),
    b.j('2026-12-31', [['支払手数料（不動産）', 10000]], [['普通預金', 10000]]),
    b.j('2026-12-31', [['その他の経費（不動産）', 5000]], [['普通預金', 5000]]),
  ];
  return { b, journals };
}

test('収支内訳書（一般用）：①〜⑲。雑収入は③、様式に無い科目は空欄の行、専従者給与・引当金は含めない', () => {
  const { b, journals } = shopBook();
  const w = whiteIncomeStatement({ accounts: b.accounts, period: b.period, journals });
  const L = w.lines;
  assert.deepEqual([L[1], L[2], L[3], L[4]], [3000000, 0, 50000, 3050000]);
  assert.deepEqual([L[5], L[6], L[7], L[8], L[9], L[10]], [200000, 1000000, 1200000, 300000, 900000, 2150000]);
  assert.deepEqual([L[11], L[12], L[13], L[14], L[15], L[16]], [400000, 100000, 120000, 0, 600000, 20000]);
  const other = Object.fromEntries(w.others.map((o) => [o.mark, o]));
  assert.equal(other['㋑'].amount, 30000);
  assert.equal(other['㋭'].amount, 60000);
  assert.equal(other['㋦'].amount, 40000);
  assert.equal(other['㋾'].label, '支払手数料'); // テンプレートでも様式に無い科目は空欄の行
  assert.equal(other['㋻'].amount, 25000);
  assert.equal(other['㋹'].amount, 5000);
  assert.equal(L[17], 175000);
  assert.equal(L[18], 1415000);
  assert.equal(L[19], 735000);
  assert.equal(w.familySalary, 300000);
  assert.deepEqual(w.reserves, { reversal: 0, provision: 10000 });
  // 青色申告決算書の差引金額㉝（専従者給与・引当金の前）と一致する
  assert.equal(blueIncomeStatement({ accounts: b.accounts, period: b.period, journals }).lines[33], L[19]);
});

test('収支内訳書（一般用）：空欄の行（5行）に入りきらない科目は㋹雑費に含める', () => {
  const b = makeBook('individual');
  const extra = ['広報費', '研修費', '諸会費', '保守料', '清掃費', '警備費'].map((name, i) => createAccount({ code: `65${i}`, name, group: 'sga', normalSide: 'debit', defaultTaxCategory: 'purchase_10' }));
  const accounts = [...b.accounts, ...extra];
  const byName = Object.fromEntries(accounts.map((a) => [a.name, a]));
  const journals = extra.map((a, i) => ({ id: `j${i}`, periodId: b.period.id, no: i + 1, date: '2026-05-01', lines: [{ side: 'debit', accountId: a.id, amount: 1000, taxCategory: 'purchase_10' }, { side: 'credit', accountId: byName['現金'].id, amount: 1000, taxCategory: 'none' }] }));
  const w = whiteIncomeStatement({ accounts, period: b.period, journals });
  assert.equal(w.others.filter((o) => ['㋾', '㋻', '㋕', '㋵', '㋟'].includes(o.mark) && o.amount).length, 5);
  assert.equal(w.overflow.length, 1);
  assert.equal(w.others.at(-1).amount, 1000); // ㋹
  assert.equal(w.lines[17], 6000);
});

test('収支内訳書（不動産所得用）：⑥〜⑬。目印の無い科目は㋥、入りきらない分は㋭雑費', () => {
  const { b, journals } = reBook();
  const r = whiteRealEstateStatement({ accounts: b.accounts, period: b.period, journals });
  assert.deepEqual(r.incomes.map((x) => x.amount), [1800000, 140000, 60000]);
  assert.equal(r.income, 2000000);
  assert.deepEqual(r.main.map((m) => [m.no, m.amount]), [[6, 60000], [7, 300000], [8, 0], [9, 0], [10, 200000]]);
  assert.deepEqual(r.others.map((o) => [o.mark, o.amount]), [['㋑', 120000], ['㋺', 30000], ['㋩', 50000], ['㋥', 90000], ['㋭', 15000]]);
  assert.equal(r.others[3].label, '管理費（不動産）');
  assert.deepEqual(r.overflow.map((o) => o.name), ['支払手数料（不動産）']);
  assert.equal(r.lines[11], 305000);
  assert.equal(r.lines[12], 865000);
  assert.equal(r.lines[13], 1135000);
  // 青色申告決算書（不動産所得用）の⑲と一致する
  assert.equal(realEstateIncomeStatement({ accounts: b.accounts, period: b.period, journals }).lines[19], r.lines[13]);
});

test('事業専従者控除：86万円（配偶者以外は50万円）と「所得÷（専従者の数＋1）」の少ない方。所得が0以下なら0', () => {
  const two = [
    { name: '花子', spouse: true, work: 'business' },
    { name: '太郎', spouse: false, work: 'business' },
  ];
  assert.deepEqual(familyWorkerDeductions(two, 735000).map((w) => w.amount), [245000, 245000]);
  assert.deepEqual(familyWorkerDeductions(two, 6000000).map((w) => w.amount), [860000, 500000]);
  assert.deepEqual(familyWorkerDeductions(two, 1000001).map((w) => w.amount), [333333, 333333]); // 1円未満切捨て
  assert.deepEqual(familyWorkerDeductions(two, -100).map((w) => w.amount), [0, 0]);
  assert.deepEqual(familyWorkerDeductions([], 1000000), []);
});

test('whiteReturnSet：専従者控除を⑳・⑭に入れる。事業所得等の金額は事業所得と事業的規模の不動産所得の合計', () => {
  const { b, journals } = reBook();
  const settings = { ...WHITE, realEstate: 'both' };
  const workers = [
    { name: '花子', spouse: true, work: 'business' },
    { name: '太郎', spouse: false, work: 'realEstate' },
  ];
  const big = whiteReturnSet({ settings, accounts: b.accounts, period: b.period, journals, overrides: { workers, scale: 'business' } });
  // 一般用⑲ 1,900,000 ＋ 不動産⑬ 1,135,000 ＝ 3,035,000 → ÷3 ＝ 1,011,666
  assert.equal(big.general.lines[19], 1900000);
  assert.equal(big.base, 3035000);
  assert.deepEqual(big.workers.map((w) => [w.work, w.amount]), [['business', 860000], ['realEstate', 500000]]);
  assert.equal(big.general.lines[20], 860000);
  assert.equal(big.general.lines[21], 1040000);
  assert.equal(big.realEstate.lines[14], 500000);
  assert.equal(big.realEstate.lines[15], 635000);
  assert.equal(big.familyTotal, 1360000);
  assert.equal(big.workersNotAllowed, false);

  // 事業的規模でない貸付け：不動産所得は事業所得等の金額に入れず、専従者は事業所得の方にする
  const small = whiteReturnSet({ settings, accounts: b.accounts, period: b.period, journals, overrides: { workers, scale: 'small' } });
  assert.equal(small.base, 1900000);
  assert.deepEqual(small.workers.map((w) => [w.work, w.amount]), [['business', 633333], ['business', 500000]]);
  assert.equal(small.realEstate.lines[14], 0);
  assert.equal(small.realEstate.lines[15], 1135000);

  // 不動産所得だけで事業的規模でない：専従者控除は受けられない
  const only = whiteReturnSet({ settings: { ...WHITE, realEstate: 'only' }, accounts: b.accounts, period: b.period, journals, overrides: { workers, scale: 'small' } });
  assert.equal(only.general, null);
  assert.equal(only.workersNotAllowed, true);
  assert.equal(only.familyTotal, 0);
  const onlyBig = whiteReturnSet({ settings: { ...WHITE, realEstate: 'only' }, accounts: b.accounts, period: b.period, journals, overrides: { workers, scale: 'business' } });
  assert.deepEqual(onlyBig.workers.map((w) => w.work), ['realEstate', 'realEstate']);
  assert.equal(onlyBig.realEstate.lines[14], 378333 + 378333); // 1,135,000÷3
});

test('収支内訳書の内訳：売上先・仕入先・地代家賃（補助科目ごと）', () => {
  const { b, journals } = shopBook();
  const d = whiteDetails({ accounts: b.accounts, subAccounts: b.subAccounts, period: b.period, journals });
  // 様式の明細：多い順に4つまでと「上記以外」。雑収入は入れない
  assert.deepEqual(d.sales, { rows: [{ name: 'A商店', amount: 1800000 }, { name: 'B商店', amount: 1200000 }], others: 0, total: 3000000 });
  assert.deepEqual(d.purchases, { rows: [{ name: 'C問屋', amount: 1000000 }], others: 0, total: 1000000 });
  assert.deepEqual(d.rent, [{ name: '大家 田中', amount: 600000 }]);
  assert.deepEqual(d.wages, [{ name: '給料賃金', amount: 400000 }]);
});

test('設定の検証：申告の種類と収支内訳書の設定', () => {
  assert.equal(isWhite(WHITE), true);
  assert.equal(isWhite({ entityType: 'individual' }), false);
  assert.equal(isWhite({ entityType: 'corporation', filing: 'white' }), false);
  assert.deepEqual(validateWhiteReturnSettings({ workers: [{ name: '花子', spouse: true, work: 'business' }], scale: 'small', landInterest: 0 }), []);
  assert.equal(validateWhiteReturnSettings({ workers: [{ name: '', spouse: 1, work: 'x' }] }).length, 3);
  assert.deepEqual(validateWhiteReturnSettings({ workers: [{ name: 'a', spouse: true, work: 'business' }, { name: 'b', spouse: true, work: 'business' }] }), ['配偶者は1人だけです']);
  assert.equal(validateWhiteReturnSettings({ workers: Array.from({ length: 11 }, (_, i) => ({ name: `${i}`, spouse: false, work: 'business' })) }).length, 1);
  assert.equal(validateWhiteReturnSettings({ scale: 'big', landInterest: -1 }).length, 2);
});

test('損益計算書・貸借対照表：白色申告は「専従者控除前の所得金額」と呼ぶ', () => {
  const { b, journals } = shopBook();
  const rows = closingRows({ accounts: b.accounts, period: b.period, journals });
  const blue = incomeStatement('individual', rows);
  const white = incomeStatement('individual', rows, { white: true });
  assert.equal(blue.items.at(-1).label, '青色申告特別控除前の所得金額');
  assert.equal(white.items.at(-1).label, '専従者控除前の所得金額');
  assert.equal(white.netIncome, blue.netIncome);
  const bs = balanceSheet('individual', rows, white.netIncome, { white: true });
  assert.ok(bs.liabilities.some((x) => x.label === incomeBeforeLabel(true).full));
  assert.equal(bs.balanced, true);
});

test('第四表：本年の純損失は青色なら繰り越し、白色は繰り越さない', () => {
  const business = { revenue: 1000000, income: -1000000, familySalary: 0, blueDeduction: 0 };
  const blue = computeIncomeTax({ year: 2026, business, input: {} });
  assert.equal(blue.lines[12], 0);
  assert.equal(blue.loss.needed, true);
  assert.equal(blue.loss.ordinary, -1000000);
  assert.equal(blue.loss.netLoss, 1000000);
  assert.equal(blue.loss.carryForward, 1000000);
  assert.deepEqual(blue.loss.next, { y3: 0, y2: 0, y1: 1000000 });
  const white = computeIncomeTax({ year: 2026, business, input: {}, white: true });
  assert.equal(white.loss.carryForward, 0);
  assert.deepEqual(white.loss.next, { y3: 0, y2: 0, y1: 0 });
  // 給与所得と損益通算した後の損失
  const mixed = computeIncomeTax({ year: 2026, business, input: { salaryRevenue: 2000000 } });
  assert.equal(mixed.lines[6], 1260000);
  assert.equal(mixed.loss.netLoss, 0);
  assert.equal(mixed.lines[12], 260000);
  assert.equal(mixed.loss.needed, false);
});

test('第四表：繰越損失は古い年分から差し引く。合計所得金額（基礎控除の判定）は差し引く前、⑫・医療費控除は差し引いた後', () => {
  const business = { revenue: 9000000, income: 3000000, familySalary: 0, blueDeduction: 650000 };
  const r = computeIncomeTax({ year: 2026, business, input: { lossCarry: { y3: 500000, y2: 2000000, y1: 1000000 } } });
  assert.deepEqual(r.loss.carry.map((c) => [c.year, c.available, c.used, c.remaining]), [[2023, 500000, 500000, 0], [2024, 2000000, 2000000, 0], [2025, 1000000, 500000, 500000]]);
  assert.equal(r.loss.carried, 3000000);
  assert.equal(r.lines[12], 0);
  assert.equal(r.totalIncome, 3000000);
  assert.equal(r.lines[25], 1040000); // 合計所得金額 300万円で判定
  assert.deepEqual(r.loss.next, { y3: 0, y2: 500000, y1: 0 });
  assert.equal(r.loss.expired, 0);
  assert.equal(r.lines[52], 0);

  // 医療費控除の足切り（総所得金額等の5%）は繰越控除の後の金額で計算する
  const medical = [{ name: '本人', payee: 'A病院', kind: 'treatment', paid: 50000, reimbursed: 0 }];
  const after = computeIncomeTax({ year: 2026, business, input: { medical, lossCarry: { y3: 0, y2: 0, y1: 2800000 } } });
  assert.equal(after.lines[12], 200000);
  assert.equal(after.medical.threshold, 10000);
  assert.equal(after.lines[28], 40000);
  assert.equal(computeIncomeTax({ year: 2026, business, input: { medical } }).lines[28], 0);

  // 3年前の分の残りは繰越期限切れ
  const small = computeIncomeTax({ year: 2026, business: { ...business, income: 100000 }, input: { lossCarry: { y3: 300000, y2: 0, y1: 0 } } });
  assert.equal(small.loss.expired, 200000);
  assert.deepEqual(small.loss.next, { y3: 0, y2: 0, y1: 0 });
});

test('事業専従者は配偶者控除・扶養控除の対象にしない', () => {
  const business = { revenue: 9000000, income: 4000000, familySalary: 860000, blueDeduction: 0 };
  const spouse = { name: '花子', birthDate: '1980-05-01', income: 0 };
  const child = { name: '太郎', relation: '子', birthDate: '2000-05-01', income: 0, livingWithParent: false };
  const normal = computeIncomeTax({ year: 2026, business, input: { spouse, dependents: [child] } });
  assert.equal(normal.lines[21], 380000);
  assert.equal(normal.lines[23], 380000);
  const worker = computeIncomeTax({ year: 2026, business, input: { spouse: { ...spouse, familyWorker: true }, dependents: [{ ...child, familyWorker: true }] } });
  assert.equal(worker.lines[21], 0);
  assert.equal(worker.lines[23], 0);
  assert.equal(worker.dependents[0].kind, 'family_worker');
  assert.deepEqual(validateIncomeTax({ ...DEFAULT_INCOME_TAX, spouse: { ...spouse, familyWorker: true } }), []);
  assert.ok(validateIncomeTax({ ...DEFAULT_INCOME_TAX, spouse: { ...spouse, familyWorker: 'yes' } }).length);
  assert.ok(validateIncomeTax({ ...DEFAULT_INCOME_TAX, lossCarry: { y3: -1, y2: 0, y1: 0 } }).length);
});

test('リポジトリ：申告の種類を保存し、収支内訳書の設定（専従者・規模・土地等の負債利子）を期間に保存する', async () => {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const period = createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' });
  await repo.setup({ settings: createSettings({ businessName: '山田商店', entityType: 'individual' }), period, accounts: templateAccounts('individual').map((a) => createAccount(a)) });
  assert.equal((await repo.updateSettings({ filing: 'white' })).filing, 'white');
  await assert.rejects(repo.updateSettings({ filing: 'red' }), ValidationError);
  await repo.saveWhiteReturnSettings(period.id, { workers: [{ name: ' 花子 ', spouse: true, work: 'business', extra: 1 }] });
  await repo.saveWhiteReturnSettings(period.id, { scale: 'business', landInterest: 50000 });
  assert.deepEqual((await repo.listPeriods())[0].whiteReturn, { workers: [{ name: '花子', spouse: true, work: 'business' }], scale: 'business', landInterest: 50000 });
  await assert.rejects(repo.saveWhiteReturnSettings(period.id, { workers: [{ name: '', spouse: false, work: 'business' }] }), ValidationError);
  // 確定申告書の繰越損失も保存できる
  const saved = await repo.saveIncomeTaxReturn(period.id, { ...DEFAULT_INCOME_TAX, lossCarry: { y3: 0, y2: 100000, y1: 200000 } });
  assert.deepEqual(saved.incomeTaxReturn.lossCarry, { y3: 0, y2: 100000, y1: 200000 });
  repo.close();

  const corp = await openDB({ indexedDB: new IDBFactory() });
  await corp.setup({ settings: createSettings({ businessName: '株式会社', entityType: 'corporation' }), period: createPeriod({ startDate: '2026-04-01', endDate: '2027-03-31' }), accounts: templateAccounts('corporation').map((a) => createAccount(a)) });
  await assert.rejects(corp.updateSettings({ filing: 'white' }), ValidationError);
  corp.close();
});
