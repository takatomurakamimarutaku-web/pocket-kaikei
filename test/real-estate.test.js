import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { openDB, ValidationError } from '../js/db.js';
import { templateAccounts, realEstateAccounts, validateAccount, GROUP_BY_ID, RE_GROUPS } from '../js/accounts.js';
import { realEstateIncomeStatement, blueReturnSet, allocateBlueDeduction, realEstateForFirstTable, realEstateDetails, realEstateBalanceSheet, RE_BS_ASSET_LINES, isRealEstateAsset, hasRealEstate, deductionLimited, validateBlueReturnSettings } from '../js/real-estate.js';
import { blueIncomeStatement, depreciationTable, blueBalanceSheet, blueDeductionOptions } from '../js/blue-return.js';
import { incomeStatement, balanceSheet, closingRows } from '../js/statements.js';
import { computeIncomeTax, DEFAULT_INCOME_TAX } from '../js/income-tax.js';
import { householdEligible } from '../js/household.js';
import { cashPlanKeyOf } from '../js/cash-flow.js';
import { createAccount, createAsset, createPeriod, createSettings } from '../js/models.js';
import { makeBook } from './helpers.js';

const BOTH = { entityType: 'individual', realEstate: 'both' };
const ONLY = { entityType: 'individual', realEstate: 'only' };

/** 事業所得（売上 2,000,000・通信費 100,000）とアパート2室の不動産所得 */
function book() {
  const b = makeBook('individual', {
    realEstate: true,
    subs: [
      ['賃貸料', '101号 山田'],
      ['賃貸料', '102号 佐藤'],
      ['礼金・権利金・更新料', '102号 佐藤'],
      ['給料賃金（不動産）', '清掃 鈴木'],
    ],
  });
  b.opening([['普通預金', 1000000], ['元入金', 1000000]]);
  const journals = [
    b.j('2026-03-31', [['普通預金', 2000000]], [['売上高', 2000000]]),
    b.j('2026-03-31', [['通信費', 100000]], [['普通預金', 100000]]),
    b.j('2026-12-31', [['普通預金', 960000]], [['賃貸料', 960000, undefined, '101号 山田']]),
    b.j('2026-12-31', [['普通預金', 840000]], [['賃貸料', 840000, undefined, '102号 佐藤']]),
    b.j('2026-04-01', [['普通預金', 140000]], [['礼金・権利金・更新料', 140000, undefined, '102号 佐藤']]),
    b.j('2026-04-01', [['普通預金', 160000]], [['預り敷金・保証金', 160000]]),
    b.j('2026-12-31', [['普通預金', 60000]], [['名義書換料その他', 60000]]),
    b.j('2026-06-30', [['租税公課（不動産）', 120000]], [['普通預金', 120000]]),
    b.j('2026-06-30', [['損害保険料（不動産）', 30000]], [['普通預金', 30000]]),
    b.j('2026-06-30', [['修繕費（不動産）', 50000]], [['普通預金', 50000]]),
    b.j('2026-12-31', [['減価償却費（不動産）', 300000]], [['建物', 300000]]),
    b.j('2026-12-31', [['借入金利子（不動産）', 200000]], [['普通預金', 200000]]),
    b.j('2026-12-31', [['給料賃金（不動産）', 60000, undefined, '清掃 鈴木']], [['普通預金', 60000]]),
    b.j('2026-12-31', [['管理費（不動産）', 90000]], [['普通預金', 90000]]),
    b.j('2026-12-31', [['支払手数料（不動産）', 10000]], [['普通預金', 10000]]),
    b.j('2026-12-31', [['その他の経費（不動産）', 5000]], [['普通預金', 5000]]),
    b.j('2026-12-31', [['専従者給与（不動産）', 100000]], [['普通預金', 100000]]),
  ];
  // 建物（期首 0 から償却した分だけ減る：期首残高に入れずに簡略化）
  b.period.openingBalances.push({ accountId: b.byName['建物'].id, subAccountId: null, amount: 3000000 }, { accountId: b.byName['借入金'].id, subAccountId: null, amount: 3000000 });
  return { b, journals };
}

test('不動産所得の科目：個人のテンプレートには無く、設定で追加する。同じ目印があれば追加せず、コードが重なれば次の番号', () => {
  const base = templateAccounts('individual');
  assert.ok(!base.some((a) => RE_GROUPS.includes(a.group)));
  const added = realEstateAccounts(base);
  assert.equal(added.length, 15);
  assert.ok(added.every((a) => a.template === false));
  assert.equal(added.find((a) => a.hint === 're_rent_income').defaultTaxCategory, 'sales_exempt'); // 住宅の家賃は非課税
  assert.equal(added.find((a) => a.hint === 're_deposits').group, 'current_liabilities');
  // 2回目は追加しない
  assert.equal(realEstateAccounts([...base, ...added]).length, 0);
  // コード 550 が使われていれば 551 以降の空き番号
  const taken = [...base, createAccount({ code: '550', name: '受取家賃', group: 'sales', normalSide: 'credit' })];
  const again = realEstateAccounts(taken);
  assert.deepEqual(['re_rent_income', 're_key_money', 're_other_income'].map((hint) => again.find((a) => a.hint === hint).code), ['551', '552', '553']);
  // 区分は個人だけ
  for (const g of RE_GROUPS) assert.equal(GROUP_BY_ID[g].entity, 'individual');
});

test('不動産所得用の損益計算書：①〜④は目印で、⑤〜⑪と⑰は目印、自分で足した経費は⑫〜⑯、⑱〜㉑', () => {
  const { b, journals } = book();
  const { lines: L, expenses } = realEstateIncomeStatement({ accounts: b.accounts, period: b.period, journals });
  assert.deepEqual([L[1], L[2], L[3], L[4]], [1800000, 140000, 60000, 2000000]);
  assert.deepEqual([L[5], L[6], L[7], L[8], L[9], L[10], L[11]], [120000, 30000, 50000, 300000, 200000, 0, 60000]);
  assert.equal(expenses.find((e) => e.no === 12).label, '管理費（不動産）');
  assert.equal(L[12], 90000);
  assert.equal(L[13], 10000);
  assert.equal(L[14], 0);
  assert.equal(L[17], 5000);
  assert.equal(L[18], 865000);
  assert.equal(L[19], 1135000);
  assert.equal(L[20], 100000);
  assert.equal(L[21], 1035000);
});

test('一般用の損益計算書には不動産所得の科目を入れない', () => {
  const { b, journals } = book();
  const { lines: L } = blueIncomeStatement({ accounts: b.accounts, period: b.period, journals, deduction: 0 });
  assert.equal(L[1], 2000000);
  assert.equal(L[32], 100000);
  assert.equal(L[38], 0);
  assert.equal(L[43], 1900000);
});

test('空欄の行（⑫〜⑯）に入りきらない不動産経費は⑰その他の経費に含める', () => {
  const { b, journals } = book();
  for (let i = 0; i < 4; i += 1) {
    const a = createAccount({ code: String(670 + i), name: `経費${i + 1}`, group: 're_expenses', normalSide: 'debit', sortOrder: 670 + i });
    b.accounts.push(a);
    b.byName[a.name] = a;
    journals.push(b.j('2026-12-31', [[a.name, 1000 * (i + 1)]], [['普通預金', 1000 * (i + 1)]]));
  }
  const r = realEstateIncomeStatement({ accounts: b.accounts, period: b.period, journals });
  assert.deepEqual([12, 13, 14, 15, 16].map((n) => r.expenses.find((e) => e.no === n).label), ['管理費（不動産）', '支払手数料（不動産）', '経費1', '経費2', '経費3']);
  assert.deepEqual(r.overflow, [{ name: '経費4', amount: 4000 }]);
  assert.equal(r.lines[17], 5000 + 4000);
  assert.equal(r.lines[18], 865000 + 10000);
});

test('青色申告特別控除：不動産所得から先に引き、残りを事業所得から引く（どちらも所得金額が限度）', () => {
  assert.deepEqual(allocateBlueDeduction({ selected: 650000, realEstateIncome: 1035000, businessIncome: 1900000 }), { realEstate: 650000, business: 0 });
  assert.deepEqual(allocateBlueDeduction({ selected: 650000, realEstateIncome: 300000, businessIncome: 1900000 }), { realEstate: 300000, business: 350000 });
  assert.deepEqual(allocateBlueDeduction({ selected: 650000, realEstateIncome: 300000, businessIncome: 100000 }), { realEstate: 300000, business: 100000 });
  // 不動産所得が赤字なら全額を事業所得から
  assert.deepEqual(allocateBlueDeduction({ selected: 650000, realEstateIncome: -200000, businessIncome: 1900000 }), { realEstate: 0, business: 650000 });

  const { b, journals } = book();
  const period = { ...b.period, blueReturn: { deduction: 650000, scale: 'business' } };
  const set = blueReturnSet({ settings: BOTH, accounts: b.accounts, period, journals });
  assert.equal(set.selected, 650000);
  assert.equal(set.realEstate.lines[22], 650000);
  assert.equal(set.realEstate.lines[23], 385000);
  assert.equal(set.business.lines[44], 0);
  assert.equal(set.business.lines[45], 1900000);
  assert.equal(set.incomeBeforeDeduction, 1900000 + 1035000);
  assert.equal(set.familySalaryNotAllowed, false);
  // 不動産所得が無い設定なら一般用だけ（従来どおり）
  const plain = blueReturnSet({ settings: { entityType: 'individual' }, accounts: b.accounts, period, journals });
  assert.equal(plain.realEstate, null);
  assert.equal(plain.business.lines[44], 650000);
});

test('事業的規模でない貸付け：不動産所得だけなら控除は10万円まで、事業所得があれば65万円。専従者給与は経費にならない', () => {
  const { b, journals } = book();
  const small = { ...b.period, blueReturn: { deduction: 650000, scale: 'small' } };
  assert.equal(deductionLimited(ONLY, 'small'), true);
  assert.equal(deductionLimited(ONLY, 'business'), false);
  assert.equal(deductionLimited(BOTH, 'small'), false);
  assert.deepEqual(blueDeductionOptions(2026, { limited: true }).map((o) => o.value), [100000, 0]);
  const only = blueReturnSet({ settings: ONLY, accounts: b.accounts, period: small, journals });
  assert.equal(only.limited, true);
  assert.equal(only.selected, 100000); // 保存した65万円は使えないので10万円
  assert.equal(only.realEstate.lines[22], 100000);
  assert.equal(only.familySalaryNotAllowed, true);
  const both = blueReturnSet({ settings: BOTH, accounts: b.accounts, period: small, journals });
  assert.equal(both.selected, 650000);
  assert.equal(both.familySalaryNotAllowed, true);
  // 規模を画面で変えた（未保存）ときは overrides で計算する
  const scaled = blueReturnSet({ settings: ONLY, accounts: b.accounts, period: small, journals, overrides: { scale: 'business', deduction: 650000 } });
  assert.equal(scaled.selected, 650000);
});

test('第一表の不動産③：赤字のうち土地等を取得するための負債の利子の分は除く', () => {
  assert.equal(realEstateForFirstTable(385000, 200000), 385000);
  assert.equal(realEstateForFirstTable(-150000, 200000), 0); // 赤字が利子以下なら0
  assert.equal(realEstateForFirstTable(-300000, 200000), -100000); // 差額を△で
  assert.equal(realEstateForFirstTable(-300000), -300000);
});

test('確定申告書：㋒と③を入れ、不動産所得の赤字も損益通算する', () => {
  const business = { revenue: 2000000, income: 1900000, familySalary: 100000, blueDeduction: 650000 };
  const r = computeIncomeTax({ year: 2026, business, realEstate: { revenue: 2000000, income: 385000 }, input: DEFAULT_INCOME_TAX });
  assert.equal(r.rev.c, 2000000);
  assert.equal(r.lines[3], 385000);
  assert.equal(r.lines[12], 1900000 + 385000);
  const loss = computeIncomeTax({ year: 2026, business: { ...business, income: 500000 }, realEstate: { revenue: 100000, income: -200000 }, input: DEFAULT_INCOME_TAX });
  assert.equal(loss.lines[12], 300000);
  // 不動産所得が無ければ③は0
  const none = computeIncomeTax({ year: 2026, business, input: DEFAULT_INCOME_TAX });
  assert.equal(none.lines[3], 0);
  assert.equal(none.lines[12], 1900000);
});

test('決算書（損益計算書・貸借対照表）：事業所得と不動産所得を分けて出し、合計で貸借が一致する', () => {
  const { b, journals } = book();
  const rows = closingRows({ accounts: b.accounts, period: b.period, journals });
  const pl = incomeStatement('individual', rows);
  assert.equal(pl.netIncome, 1900000 + 1035000);
  assert.equal(pl.profits.businessIncome, 1900000);
  assert.equal(pl.profits.realEstateIncome, 1035000);
  assert.ok(pl.items.some((i) => i.type === 'subtotal' && i.label === '不動産所得（青色申告特別控除前）' && i.amount === 1035000));
  const bs = balanceSheet('individual', rows, pl.netIncome);
  assert.equal(bs.balanced, true);
  // 青色申告決算書の貸借対照表（合算）も一致する
  const set = blueReturnSet({ settings: BOTH, accounts: b.accounts, period: b.period, journals });
  const blue = blueBalanceSheet({ accounts: b.accounts, period: b.period, journals, incomeBeforeDeduction: set.incomeBeforeDeduction });
  assert.equal(blue.balanced, true);
  // 様式に無い預り敷金・保証金は空欄の行に入る
  assert.ok(blue.liabilities.some((x) => x.label === '預り敷金・保証金' && x.blank && x.closing === 160000));
  // 不動産所得用の様式の行：預り敷金・保証金は「保証金・敷金」の行に入り、合計は同じ
  const re = realEstateBalanceSheet({ accounts: b.accounts, period: b.period, journals, incomeBeforeDeduction: set.incomeBeforeDeduction });
  assert.equal(re.balanced, true);
  assert.deepEqual(re.totals, blue.totals);
  assert.deepEqual(re.liabilities.find((x) => x.label === '保証金・敷金'), { label: '保証金・敷金', name: '預り敷金・保証金', opening: 0, closing: 160000 });
  assert.equal(re.liabilities.some((x) => x.blank && x.label === '預り敷金・保証金'), false);
  assert.deepEqual(re.assets.filter((x) => !x.blank).map((x) => x.label), RE_BS_ASSET_LINES.filter(([c]) => c !== null).map(([, l]) => l));
  assert.equal(re.assets.find((x) => x.label === '借地権').closing, 0);
  // 空欄の行は様式の行数まで埋める（資産5行・負債18行。どちらも24行）
  assert.equal(re.assets.length, 24);
  assert.equal(re.liabilities.length, 3 + 18 + 3);
  assert.equal(re.assets.at(-1).label, '事業主貸');
  assert.equal(re.liabilities.at(-1).label, '青色申告特別控除前の所得金額');
});

test('収入の内訳：賃借人（補助科目）ごとに賃貸料・礼金等をまとめる。給料賃金・専従者給与の内訳', () => {
  const { b, journals } = book();
  const d = realEstateDetails({ accounts: b.accounts, subAccounts: b.subAccounts, period: b.period, journals });
  assert.deepEqual(d.tenants, [
    { name: '101号 山田', rent: 960000, key: 0, other: 0, total: 960000 },
    { name: '102号 佐藤', rent: 840000, key: 140000, other: 0, total: 980000 },
    { name: '（補助科目なし）', rent: 0, key: 0, other: 60000, total: 60000 },
  ]);
  assert.deepEqual(d.wages, [{ name: '清掃 鈴木', amount: 60000 }]);
  assert.deepEqual(d.family, [{ name: '専従者給与（不動産）', amount: 100000 }]);
  assert.deepEqual(d.interest, [{ name: '借入金利子（不動産）', amount: 200000 }]);
  assert.deepEqual(d.rent, []);
  assert.deepEqual(d.repairs, [{ name: '修繕費（不動産）', amount: 50000 }]);
});

test('減価償却費の計算：償却費の科目が不動産経費の資産は不動産所得用、それ以外は一般用', () => {
  const { b } = book();
  const accountById = new Map(b.accounts.map((a) => [a.id, a]));
  const apartment = createAsset({ name: 'アパート', category: 'building', accountId: b.byName['建物'].id, acquiredOn: '2026-01-01', startedOn: '2026-01-01', cost: 3000000, method: 'straight', usefulLife: 22, businessRatio: 100, expenseAccountId: b.byName['減価償却費（不動産）'].id });
  const pc = createAsset({ name: 'パソコン', category: 'tools', accountId: b.byName['工具器具備品'].id, acquiredOn: '2026-01-01', startedOn: '2026-01-01', cost: 300000, method: 'straight', usefulLife: 4, businessRatio: 100 });
  assert.equal(isRealEstateAsset(apartment, accountById), true);
  assert.equal(isRealEstateAsset(pc, accountById), false);
  const p = { assets: [apartment, pc], periods: [b.period], period: b.period };
  assert.deepEqual(depreciationTable({ ...p, filter: (a) => isRealEstateAsset(a, accountById) }).rows.map((r) => r.name), ['アパート']);
  assert.deepEqual(depreciationTable({ ...p, filter: (a) => !isRealEstateAsset(a, accountById) }).rows.map((r) => r.name), ['パソコン']);
  assert.equal(depreciationTable(p).rows.length, 2);
});

test('家事按分・資金繰り・設定の判定で不動産所得の区分を扱う', () => {
  const { b } = book();
  assert.equal(householdEligible(b.byName['管理費（不動産）']), true);
  assert.equal(householdEligible(b.byName['減価償却費（不動産）']), false);
  assert.deepEqual(validateAccount({ ...b.byName['租税公課（不動産）'], businessRatio: 60 }, b.accounts, { entityType: 'individual' }), {});
  assert.equal(cashPlanKeyOf(b.byName['賃貸料'], 1), 'sales_in');
  assert.equal(cashPlanKeyOf(b.byName['修繕費（不動産）'], -1), 'expense_out');
  assert.equal(cashPlanKeyOf(b.byName['租税公課（不動産）'], -1), 'tax_out');
  assert.equal(hasRealEstate(BOTH), true);
  assert.equal(hasRealEstate({ entityType: 'individual', realEstate: 'none' }), false);
  assert.equal(hasRealEstate({ entityType: 'corporation', realEstate: 'both' }), false);
  assert.deepEqual(validateBlueReturnSettings({ deduction: 650000, scale: 'business', landInterest: 0 }), []);
  assert.equal(validateBlueReturnSettings({ scale: 'x', landInterest: -1, deduction: 1 }).length, 3);
});

test('リポジトリ：不動産所得の設定で科目を追加し、決算書の設定（控除・規模・土地等の負債利子）を期間に保存する', async () => {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('individual').map((a) => createAccount(a));
  const period = createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' });
  await repo.setup({ settings: createSettings({ businessName: '山田不動産', entityType: 'individual' }), period, accounts });
  const r = await repo.setRealEstate('both');
  assert.equal(r.settings.realEstate, 'both');
  assert.equal(r.added.length, 15);
  assert.equal((await repo.setRealEstate('only')).added.length, 0);
  await repo.setRealEstate('none');
  assert.equal((await repo.listAccounts()).length, accounts.length + 15); // なしにしても科目は残る
  await assert.rejects(repo.setRealEstate('x'), ValidationError);

  await repo.saveBlueReturnSettings(period.id, { deduction: 650000 });
  await repo.saveBlueReturnSettings(period.id, { scale: 'business', landInterest: 120000 });
  const saved = (await repo.listPeriods())[0].blueReturn;
  assert.deepEqual(saved, { deduction: 650000, scale: 'business', landInterest: 120000 });
  await assert.rejects(repo.saveBlueReturnSettings(period.id, { landInterest: 1.5 }), ValidationError);
  await assert.rejects(repo.saveBlueReturnSettings(period.id, { scale: 'large' }), ValidationError);
  repo.close();

  const corp = await openDB({ indexedDB: new IDBFactory() });
  await corp.setup({ settings: createSettings({ businessName: '株式会社', entityType: 'corporation' }), period: createPeriod({ startDate: '2026-04-01', endDate: '2027-03-31' }), accounts: templateAccounts('corporation').map((a) => createAccount(a)) });
  await assert.rejects(corp.setRealEstate('both'), ValidationError);
  corp.close();
});
