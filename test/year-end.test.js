import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  salaryIncomeAfterDeduction,
  ageAtYearEnd,
  basicDeductionYE,
  spouseDeduction,
  specificRelativeDeduction,
  dependentClass,
  lifeInsuranceDeduction,
  earthquakeDeduction,
  calculatedIncomeTax,
  annualTaxWithSurtax,
  yearPayTotals,
  yearEndCalc,
  yearEndDraft,
  yearEndSnapshot,
  snapshotChanges,
  familyDraft,
  validateYearEnd,
  yearEndCsvRows,
  supportedYearEndYears,
} from '../js/year-end.js';
import { payrollTotals, payrollJournal, payrollDraft, copyPayroll, validatePayroll, withholdingSummary, resolvePayrollSettings } from '../js/payroll.js';
import { validateJournal } from '../js/journal.js';
import { templateAccounts } from '../js/accounts.js';
import { openDB, DB_NAME, DB_VERSION, migrate, ValidationError } from '../js/db.js';
import { createBackup, parseBackup, BACKUP_VERSION } from '../js/backup.js';
import { createSettings, createAccount, createPeriod } from '../js/models.js';
import { makeBook } from './helpers.js';

const EMP = { id: 'e1', name: '山田 花子', kana: '', kind: 'employee', taxColumn: 'kou', dependents: 2, earnings: [{ name: '基本給', amount: 300000 }], commute: 0, health: 15000, pension: 27000, employmentRate: null, residentTax: 0, deductions: [], note: '', active: true };

/** 計算に使う給与（payrollTotals に要る項目だけ） */
const pay = (fields) => ({ employeeId: 'e1', kind: 'salary', payDate: '2026-06-25', taxColumn: 'kou', earnings: [], commute: 0, health: 0, pension: 0, employment: 0, incomeTax: 0, residentTax: 0, deductions: [], journalId: 'j', ...fields });

/** 国税庁「令和8年分 年末調整のしかた」の設例（通常の税額計算を行う方法）と同じ金額の1年分 */
const NTA_PAYROLLS = [pay({ earnings: [{ name: '給与', amount: 3_690_000 }], health: 641_525, incomeTax: 40_000 }), pay({ kind: 'bonus', payDate: '2026-12-10', earnings: [{ name: '賞与', amount: 700_000 }], incomeTax: 11_845 })];

function ntaInput() {
  const ye = yearEndDraft({ id: 'e1' }, 2026);
  ye.spouse = { ...familyDraft(), name: '配偶者', birthDate: '1985-05-05', income: 0 };
  ye.dependents = [{ ...familyDraft(), name: '長男', relation: '子', birthDate: '2009-04-01', income: 0 }];
  Object.assign(ye.insurance, { lifeOld: 50_200, pensionNew: 56_000, earthquake: 45_000 });
  return ye;
}

test('給与所得控除後の給与等の金額：令和8年分の年末調整等のための表（最低額74万円・4,000円刻み・660万円以上は算式）', () => {
  const f = (x) => salaryIncomeAfterDeduction(x, 2026);
  assert.equal(f(740_999), 0);
  assert.equal(f(741_000), 1_000);
  assert.equal(f(2_190_999), 1_450_999);
  assert.equal(f(2_191_000), 1_451_000);
  assert.equal(f(2_193_000), 1_453_000);
  assert.equal(f(2_199_999), 1_456_000);
  assert.equal(f(2_200_000), 1_460_000);
  assert.equal(f(2_203_999), 1_460_000);
  assert.equal(f(3_600_000), 2_440_000);
  assert.equal(f(4_390_000), 3_070_400);
  assert.equal(f(6_599_999), 4_836_800);
  assert.equal(f(6_600_000), 4_840_000);
  assert.equal(f(7_654_321), 5_788_888); // 国税庁の例：×90%−1,100,000円（1円未満切捨て）
  assert.equal(f(8_500_000), 6_550_000);
  assert.equal(f(10_000_000), 8_050_000);
  assert.equal(salaryIncomeAfterDeduction(3_000_000, 2025), null);
  assert.deepEqual(supportedYearEndYears(), [2026]);
});

test('12月31日現在の年齢：1月1日生まれは前年の12月31日に年をとる', () => {
  assert.equal(ageAtYearEnd('2011-01-01', 2026), 16);
  assert.equal(ageAtYearEnd('2011-01-02', 2026), 15);
  assert.equal(ageAtYearEnd('2004-01-02', 2026), 22);
  assert.equal(ageAtYearEnd('2004-01-01', 2026), 23);
  assert.equal(ageAtYearEnd('1957-01-01', 2026), 70);
  assert.equal(ageAtYearEnd('1957-01-02', 2026), 69);
  assert.equal(ageAtYearEnd('', 2026), null);
});

test('基礎控除：令和8年分（489万円以下104万円・655万円以下67万円・2,350万円以下62万円…）', () => {
  const b = (x) => basicDeductionYE(x, 2026);
  assert.equal(b(0), 1_040_000);
  assert.equal(b(4_890_000), 1_040_000);
  assert.equal(b(4_890_001), 670_000);
  assert.equal(b(6_550_000), 670_000);
  assert.equal(b(6_550_001), 620_000);
  assert.equal(b(23_500_000), 620_000);
  assert.equal(b(23_500_001), 480_000);
  assert.equal(b(24_000_001), 320_000);
  assert.equal(b(24_500_001), 160_000);
  assert.equal(b(25_000_001), 0);
});

test('配偶者控除・配偶者特別控除：所得要件62万円・本人の所得の3区分・老人控除対象配偶者', () => {
  const sp = (own, income, birthDate = '1980-01-01') => spouseDeduction(own, { income, birthDate }, 2026);
  assert.deepEqual(sp(3_000_000, 620_000), { kind: 'spouse', amount: 380_000, elderly: false, sameLiving: true });
  assert.equal(sp(9_000_001, 0).amount, 260_000);
  assert.equal(sp(9_500_001, 0).amount, 130_000);
  assert.equal(sp(3_000_000, 0, '1957-01-01').amount, 480_000);
  assert.equal(sp(9_500_000, 0, '1957-01-01').amount, 320_000);
  assert.deepEqual(sp(3_000_000, 620_001), { kind: 'special', amount: 380_000, elderly: false, sameLiving: false });
  assert.equal(sp(3_000_000, 950_001).amount, 360_000);
  assert.equal(sp(9_200_000, 1_100_000).amount, 180_000);
  assert.equal(sp(3_000_000, 1_330_000).amount, 30_000);
  assert.equal(sp(9_800_000, 1_330_000).amount, 10_000);
  assert.deepEqual(sp(3_000_000, 1_330_001), { kind: null, amount: 0, elderly: false, sameLiving: false });
  // 本人の所得が1,000万円超：控除は無いが同一生計配偶者
  assert.deepEqual(sp(10_000_001, 0), { kind: null, amount: 0, elderly: false, sameLiving: true });
  assert.equal(spouseDeduction(3_000_000, null, 2026).amount, 0);
});

test('扶養親族の区分と特定親族特別控除（19歳以上23歳未満・所得62万円超123万円以下）', () => {
  const c = (birthDate, income = 0, more = {}) => dependentClass({ birthDate, income, ...more }, 2026);
  assert.equal(c('2011-01-02'), 'young');
  assert.equal(c('2011-01-01'), 'general');
  assert.equal(c('2008-01-02'), 'general');
  assert.equal(c('2008-01-01'), 'specific');
  assert.equal(c('2004-01-02'), 'specific');
  assert.equal(c('2004-01-01'), 'general');
  assert.equal(c('1957-01-01'), 'elderly');
  assert.equal(c('1957-01-01', 0, { parentCohabiting: true }), 'elderly_cohabiting');
  assert.equal(c('2005-05-05', 620_001), 'specific_relative');
  assert.equal(c('2005-05-05', 1_230_001), 'over');
  assert.equal(c('1990-05-05', 620_001), 'over');
  assert.equal(c('2015-05-05', 0, { claimedByOther: true }), 'other');
  const s = (x) => specificRelativeDeduction(x, 2026);
  assert.deepEqual([620_000, 620_001, 850_000, 850_001, 900_001, 950_001, 1_000_001, 1_050_001, 1_100_001, 1_150_001, 1_200_001, 1_230_000, 1_230_001].map(s), [0, 630_000, 630_000, 610_000, 510_000, 410_000, 310_000, 210_000, 110_000, 60_000, 30_000, 30_000, 0]);
});

test('生命保険料控除：新契約・旧契約・両方・23歳未満の扶養親族がいるとき（上限6万円）・合計12万円', () => {
  assert.equal(lifeInsuranceDeduction({ lifeNew: 20_000 }).general, 20_000);
  assert.equal(lifeInsuranceDeduction({ lifeNew: 30_001 }).general, 25_001); // 15,000.5 → 切上げ 15,001 + 10,000
  assert.equal(lifeInsuranceDeduction({ lifeNew: 100_000 }).general, 40_000);
  assert.equal(lifeInsuranceDeduction({ lifeNew: 100_000 }, { under23: true }).general, 55_000);
  assert.equal(lifeInsuranceDeduction({ lifeNew: 200_000 }, { under23: true }).general, 60_000);
  assert.equal(lifeInsuranceDeduction({ lifeOld: 50_200 }).general, 37_550);
  // 新旧の両方：合計（上限4万円・特例は6万円）か旧契約だけの額の大きい方
  assert.equal(lifeInsuranceDeduction({ lifeNew: 100_000, lifeOld: 100_000 }).general, 50_000);
  assert.equal(lifeInsuranceDeduction({ lifeNew: 100_000, lifeOld: 100_000 }, { under23: true }).general, 60_000);
  assert.equal(lifeInsuranceDeduction({ lifeNew: 10_000, lifeOld: 20_000 }).general, 30_000);
  assert.equal(lifeInsuranceDeduction({ pensionNew: 56_000 }).pension, 34_000);
  assert.equal(lifeInsuranceDeduction({ lifeNew: 1e6, lifeOld: 1e6, care: 1e6, pensionNew: 1e6, pensionOld: 1e6 }, { under23: true }).total, 120_000);
});

test('地震保険料控除：地震保険料（上限5万円）＋旧長期損害保険料、合わせて上限5万円', () => {
  assert.equal(earthquakeDeduction({ earthquake: 45_000 }), 45_000);
  assert.equal(earthquakeDeduction({ earthquake: 80_000 }), 50_000);
  assert.equal(earthquakeDeduction({ oldLongTerm: 15_001 }), 12_501);
  assert.equal(earthquakeDeduction({ oldLongTerm: 30_000 }), 15_000);
  assert.equal(earthquakeDeduction({ earthquake: 45_000, oldLongTerm: 15_000 }), 50_000);
});

test('算出所得税額（年末調整のための速算表）と年調年税額（×102.1%、100円未満切捨て）', () => {
  assert.equal(calculatedIncomeTax(512_000), 25_600);
  assert.equal(calculatedIncomeTax(2_696_000), 172_100); // 国税庁の例
  assert.equal(calculatedIncomeTax(1_950_000), 97_500);
  assert.equal(calculatedIncomeTax(3_300_000), 232_500);
  assert.equal(calculatedIncomeTax(6_950_000), 962_500);
  assert.equal(calculatedIncomeTax(9_000_000), 1_434_000);
  assert.equal(calculatedIncomeTax(18_000_000), 4_404_000);
  assert.equal(calculatedIncomeTax(18_050_000), 4_424_000);
  assert.equal(calculatedIncomeTax(18_051_000), null);
  assert.equal(annualTaxWithSurtax(25_600), 26_100);
  assert.equal(annualTaxWithSurtax(0), 0);
  assert.equal(annualTaxWithSurtax(172_100), 175_700);
});

test('年末調整：国税庁の設例と同じ金額になる（年調年税額26,100円・超過額25,745円）', () => {
  const r = yearEndCalc(ntaInput(), { payrolls: NTA_PAYROLLS, employee: EMP });
  assert.equal(r.eligible, true);
  assert.equal(r.pay, 4_390_000);
  assert.equal(r.withheld, 51_845);
  assert.equal(r.afterAdjust, 3_070_400);
  assert.equal(r.lines.social, 641_525);
  assert.equal(r.lines.life, 71_550);
  assert.equal(r.lines.earthquake, 45_000);
  assert.equal(r.lines.spouse, 380_000);
  assert.equal(r.lines.dependents, 380_000);
  assert.equal(r.lines.basic, 1_040_000);
  assert.equal(r.totalDeductions, 2_558_075);
  assert.equal(r.taxable, 512_000);
  assert.equal(r.calculated, 25_600);
  assert.equal(r.annualTax, 26_100);
  assert.equal(r.diff, -25_745);
  assert.equal(r.counts.general, 1);
  assert.deepEqual(r.warnings, []);
});

test('年末調整：所得金額調整控除・障害者控除・寡婦／ひとり親・勤労学生・住宅ローン控除・前職分', () => {
  const base = { payrolls: [pay({ earnings: [{ name: '給与', amount: 9_000_000 }], incomeTax: 500_000 })], employee: EMP };
  const ye = yearEndDraft({ id: 'e1' }, 2026);
  // 23歳未満の扶養親族（16歳未満でもよい、他の人の扶養控除の対象でもよい）がいると所得金額調整控除
  ye.dependents = [{ ...familyDraft(), name: '子', birthDate: '2016-04-01', claimedByOther: true }];
  let r = yearEndCalc(ye, base);
  assert.equal(r.adjustment, 50_000);
  assert.equal(r.afterAdjust, 9_000_000 - 1_950_000 - 50_000);
  assert.equal(r.lines.dependents, 0);
  assert.equal(r.counts.young, 0); // 他の人の扶養控除の対象は数えない
  assert.equal(yearEndCalc({ ...ye, dependents: [] }, base).adjustment, 0);
  assert.equal(yearEndCalc(ye, { ...base, payrolls: [pay({ earnings: [{ name: '給与', amount: 12_000_000 }] })] }).adjustment, 150_000);
  // 障害者控除：16歳未満の扶養親族・同居特別障害者の配偶者
  ye.dependents = [{ ...familyDraft(), name: '子', birthDate: '2016-04-01', disability: 'general' }];
  ye.spouse = { ...familyDraft(), name: '配偶者', birthDate: '1980-01-01', disability: 'special_cohabiting' };
  r = yearEndCalc(ye, base);
  assert.equal(r.lines.disability, 270_000 + 750_000);
  assert.equal(r.counts.young, 1);
  assert.equal(r.counts.disabledSpecialCohabiting, 1);
  assert.equal(r.counts.disabledOther, 1);
  // ひとり親：本人の合計所得金額が500万円を超えると受けられない
  ye.person = { ...ye.person, widow: 'single_parent' };
  r = yearEndCalc(ye, base);
  assert.equal(r.lines.widow, 0);
  assert.ok(r.warnings.some((w) => /500万円/.test(w)));
  const small = { payrolls: [pay({ earnings: [{ name: '給与', amount: 1_500_000 }], incomeTax: 20_000 })], employee: EMP };
  assert.equal(yearEndCalc(ye, small).lines.widow, 350_000);
  // 勤労学生：合計所得金額89万円以下
  const st = { ...yearEndDraft({ id: 'e1' }, 2026), person: { disability: 'none', widow: 'none', student: true, otherIncome: 0 } };
  assert.equal(yearEndCalc(st, { payrolls: [pay({ earnings: [{ name: '給与', amount: 1_630_000 }] })], employee: EMP }).lines.student, 270_000);
  assert.equal(yearEndCalc(st, { payrolls: [pay({ earnings: [{ name: '給与', amount: 1_640_000 }] })], employee: EMP }).lines.student, 0);
  // 住宅借入金等特別控除：引ききれない額は切捨て
  const loan = { ...ntaInput(), housingLoan: 300_000 };
  r = yearEndCalc(loan, { payrolls: NTA_PAYROLLS, employee: EMP });
  assert.deepEqual([r.housing, r.incomeTax, r.annualTax, r.diff], [25_600, 0, 0, -51_845]);
  // 前職分
  const moved = { ...ntaInput(), previous: { name: '前の会社', pay: 1_000_000, social: 150_000, tax: 20_000, retiredOn: '2026-03-31' } };
  r = yearEndCalc(moved, { payrolls: NTA_PAYROLLS, employee: EMP });
  assert.equal(r.pay, 5_390_000);
  assert.equal(r.withheld, 71_845);
  assert.equal(r.lines.social, 791_525);
});

test('年末調整をしない人：乙欄・2,000万円超・給与なし・対応していない年分。注意：退職した人・未登録の給与', () => {
  const ye = yearEndDraft({ id: 'e1' }, 2026);
  assert.equal(yearEndCalc(ye, { payrolls: NTA_PAYROLLS, employee: { ...EMP, taxColumn: 'otsu' } }).eligible, false);
  assert.match(yearEndCalc(ye, { payrolls: [pay({ earnings: [{ name: '給与', amount: 20_000_001 }] })], employee: EMP }).reasons.join(), /2,000万円/);
  assert.match(yearEndCalc(ye, { payrolls: [], employee: EMP }).reasons.join(), /給与がありません/);
  assert.equal(yearEndCalc({ ...ye, year: 2027 }, { payrolls: NTA_PAYROLLS, employee: EMP }).eligible, false);
  const r = yearEndCalc(ye, { payrolls: [...NTA_PAYROLLS, pay({ journalId: null, earnings: [{ name: '給与', amount: 1 }] })], employee: { ...EMP, active: false } });
  assert.equal(r.eligible, true);
  assert.ok(r.warnings.some((w) => /仕訳を登録していない給与が1件/.test(w)));
  assert.ok(r.warnings.some((w) => /退職/.test(w)));
  // ほかの人・ほかの年の給与は数えない
  assert.equal(yearPayTotals([...NTA_PAYROLLS, pay({ employeeId: 'x', earnings: [{ name: 'a', amount: 5 }] }), pay({ payDate: '2025-12-25', earnings: [{ name: 'a', amount: 5 }] })], 'e1', 2026).pay, 4_390_000);
});

test('確定の結果と、給与が変わったときの違い・CSV', () => {
  const r = yearEndCalc(ntaInput(), { payrolls: NTA_PAYROLLS, employee: EMP });
  const snap = yearEndSnapshot(r);
  assert.equal(snap.annualTax, 26_100);
  assert.equal(snap.sum, undefined);
  assert.deepEqual(snapshotChanges(snap, r), []);
  const changed = yearEndCalc(ntaInput(), { payrolls: [...NTA_PAYROLLS, pay({ earnings: [{ name: '手当', amount: 10_000 }] })], employee: EMP });
  assert.deepEqual(snapshotChanges(snap, changed).map((c) => c.key), ['pay', 'totalDeductions', 'annualTax'].filter((k) => snap[k] !== changed[k]));
  assert.ok(snapshotChanges(snap, changed).some((c) => c.key === 'pay' && c.before === 4_390_000 && c.after === 4_400_000));
  const rows = yearEndCsvRows([{ ye: { year: 2026, status: 'fixed' }, name: '山田 花子', result: snap }]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].slice(0, 4), [2026, '山田 花子', '確定', 4_390_000]);
  assert.equal(rows[1][rows[1].length - 1], -25_745);
});

test('検証：年末調整の入力', () => {
  const ok = { ...ntaInput(), id: 'y1' };
  assert.deepEqual(validateYearEnd(ok), []);
  assert.match(validateYearEnd({ ...ok, dependents: [{ ...familyDraft(), name: '', birthDate: '' }] }).join(), /氏名.*生年月日|生年月日/);
  assert.match(validateYearEnd({ ...ok, insurance: { ...ok.insurance, lifeNew: -1 } }).join(), /一般の生命保険料（新）/);
  assert.match(validateYearEnd({ ...ok, person: { ...ok.person, widow: 'x' } }).join(), /寡婦/);
  assert.match(validateYearEnd({ ...ok, status: 'fixed' }).join(), /計算の結果がありません/);
  assert.match(validateYearEnd({ ...ok, dependents: Array.from({ length: 21 }, () => ({ ...familyDraft(), name: 'a', birthDate: '2000-01-01' })) }).join(), /20人まで/);
  assert.match(validateYearEnd({ ...ok, previous: { ...ok.previous, retiredOn: '2026-02-30' } }).join(), /前職を辞めた日/);
  // 前の年の内容を引き継ぐ（保険料は引き継がない）
  const next = yearEndDraft({ id: 'e1' }, 2027, ok);
  assert.equal(next.dependents.length, 1);
  assert.equal(next.spouse.name, '配偶者');
  assert.equal(next.insurance.lifeOld, 0);
  assert.equal(next.status, 'draft');
});

test('給与の過不足：控除・差引支給額・仕訳（不足額は預り金、還付は預り金を借方）・納付の集計', () => {
  const { accounts, period } = makeBook('corporation');
  const settings = { payroll: null };
  const ctx = { accounts, subAccounts: [], period };
  const cfg = resolvePayrollSettings(null, accounts);
  const base = pay({ id: 'p1', name: '山田 花子', employeeKind: 'employee', earnings: [{ name: '基本給', amount: 300_000 }], health: 15_000, pension: 27_000, incomeTax: 6_000, payDate: '2026-12-25', dependents: 0, title: '12月分' });
  const refund = { ...base, yearEndTax: -25_745, yearEndId: 'y1' };
  const t = payrollTotals(refund);
  assert.equal(t.yearEnd, -25_745);
  assert.equal(t.net, 300_000 - 15_000 - 27_000 - 6_000 + 25_745);
  const j = payrollJournal(refund, { accounts, settings, periodId: period.id });
  assert.deepEqual(validateJournal(j, ctx), []);
  const debitDeposit = j.lines.find((l) => l.side === 'debit' && l.accountId === cfg.accounts.deposit);
  assert.equal(debitDeposit.amount, 25_745);
  assert.match(debitDeposit.memo, /年末調整 還付/);
  const short = { ...base, yearEndTax: 3_000, yearEndId: 'y1' };
  const j2 = payrollJournal(short, { accounts, settings, periodId: period.id });
  assert.deepEqual(validateJournal(j2, ctx), []);
  assert.ok(j2.lines.some((l) => l.side === 'credit' && l.amount === 3_000 && /不足額/.test(l.memo)));
  assert.equal(payrollTotals(short).net, 300_000 - 15_000 - 27_000 - 6_000 - 3_000);
  // 検証：年末調整の記録が無い過不足は不可
  assert.match(validatePayroll({ ...base, title: 'x', yearEndTax: 100 }).join(), /年末調整の記録がありません/);
  // 納付の集計：12月は超過額を引ききれない → 繰越し（毎月）。納期の特例は半年分から引く
  const nov = { ...base, id: 'p0', payDate: '2026-11-25', yearEndTax: 0 };
  const months = withholdingSummary([nov, refund], { year: 2026, special: false });
  const dec = months[11];
  assert.deepEqual([dec.tax, dec.excess, dec.payable, dec.carry], [6_000, 25_745, 0, 19_745]);
  assert.equal(months[10].payable, 6_000);
  assert.equal(months[10].due, '2026-12-10');
  const [, h2] = withholdingSummary([nov, refund, { ...short, id: 'p2', employeeId: 'e2', yearEndTax: 3_000 }], { year: 2026, special: true });
  assert.deepEqual([h2.tax, h2.shortage, h2.excess, h2.payable, h2.carry], [18_000, 3_000, 25_745, 0, 4_745]);
  // 繰越しはその年の後の納付から引く
  const carried = withholdingSummary([{ ...refund, payDate: '2026-10-25' }, { ...base, id: 'p3', payDate: '2026-11-25' }, { ...base, id: 'p4', payDate: '2026-12-25' }], { year: 2026, special: false });
  assert.deepEqual(carried.slice(9).map((m) => [m.carryIn, m.payable, m.carry]), [[0, 0, 19_745], [19_745, 0, 13_745], [13_745, 0, 7_745]]);
  // 年をまたいで翌年の納付から引く
  const next = withholdingSummary([{ ...refund, payDate: '2026-10-25' }, { ...base, id: 'p3', payDate: '2026-11-25' }, { ...base, id: 'p4', payDate: '2026-12-25' }, { ...base, id: 'p5', payDate: '2027-01-25' }, { ...base, id: 'p6', payDate: '2027-02-25' }], { year: 2027, special: false });
  assert.deepEqual(next.slice(0, 3).map((m) => [m.carryIn, m.payable, m.carry]), [[7_745, 0, 1_745], [1_745, 4_255, 0], [0, 0, 0]]);
});

test('複製と下書き：年末調整の過不足は引き継がない', () => {
  const src = { ...payrollDraft({ ...EMP }, { payDate: '2026-12-25' }), id: 'p1', yearEndTax: -1000, yearEndId: 'y1' };
  const copy = copyPayroll(src, { payDate: '2027-01-25' });
  assert.equal(copy.yearEndTax, undefined);
  assert.equal(copy.yearEndId, undefined);
});

// ---- Repository ----

async function setupRepo() {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('corporation').map((a) => createAccount(a));
  const period = createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト株式会社', entityType: 'corporation', taxStatus: 'taxable' }), period, accounts });
  const emp = await repo.saveEmployee({ ...EMP, id: undefined });
  const draft = (payDate, kind = 'salary') => payrollDraft(emp, { payDate, kind });
  const list = await repo.createPayrolls(['2026-01-25', '2026-02-25', '2026-03-25', '2026-04-25', '2026-05-25', '2026-06-25', '2026-07-25', '2026-08-25', '2026-09-25', '2026-10-25', '2026-11-25', '2026-12-25'].map((d) => draft(d)));
  return { repo, emp, list, period };
}

test('Repository：年末調整の保存（1人1年分）・確定・精算（給与の控除に過不足）・外す・取消・削除', async () => {
  const { repo, emp, list } = await setupRepo();
  const input = { ...yearEndDraft(emp, 2026), dependents: [{ ...familyDraft(), name: '長男', relation: '子', birthDate: '2009-04-01' }] };
  const saved = await repo.saveYearEnd(input);
  assert.equal(saved.status, 'draft');
  await assert.rejects(repo.saveYearEnd({ ...input }), /2026年分の年末調整はもうあります/);
  await assert.rejects(repo.saveYearEnd({ ...saved, year: 2025 }), /変えられません/);
  await assert.rejects(repo.saveYearEnd({ ...saved, dependents: [{ ...familyDraft(), name: '' }] }), ValidationError);
  // 確定：結果を残す。確定した後は変更できない
  const fixed = await repo.fixYearEnd(saved.id);
  assert.equal(fixed.status, 'fixed');
  const expect = yearEndCalc(saved, { payrolls: await repo.listPayrolls(), employee: emp });
  assert.equal(fixed.result.annualTax, expect.annualTax);
  assert.equal(fixed.result.diff, expect.diff);
  assert.notEqual(fixed.result.diff, 0);
  await assert.rejects(repo.saveYearEnd({ ...fixed, note: 'x' }), /確定した年末調整は変更できません/);
  await assert.rejects(repo.fixYearEnd(saved.id), /もう確定しています/);
  // 精算：仕訳を登録した給与・範囲外の日付・ほかの人の給与は不可
  const dec = list[11];
  const [{ payroll: posted }] = await repo.postPayrolls([list[10].id]);
  await assert.rejects(repo.settleYearEnd(saved.id, posted.id), /仕訳を登録した給与では精算できません/);
  const [lateJan] = await repo.createPayrolls([payrollDraft(emp, { payDate: '2027-02-25' })]);
  await assert.rejects(repo.settleYearEnd(saved.id, lateJan.id), /2026年か2027年1月/);
  const r = await repo.settleYearEnd(saved.id, dec.id);
  assert.equal(r.yearEnd.status, 'settled');
  assert.equal(r.payroll.yearEndTax, fixed.result.diff);
  assert.equal(r.payroll.yearEndId, saved.id);
  await assert.rejects(repo.unfixYearEnd(saved.id), /先に「精算を外す」/);
  await assert.rejects(repo.deleteYearEnd(saved.id), /精算した年末調整は削除できません/);
  await assert.rejects(repo.deletePayroll(dec.id), /年末調整の精算に使っている給与は削除できません/);
  await assert.rejects(repo.deleteEmployee(emp.id), /給与の記録/);
  // 給与を保存し直しても過不足は残る（画面から過不足を変えられない）
  const resaved = await repo.savePayroll({ ...r.payroll, yearEndTax: 0, yearEndId: null, note: 'メモ' });
  assert.equal(resaved.yearEndTax, fixed.result.diff);
  assert.equal(resaved.yearEndId, saved.id);
  // 精算した給与の仕訳：還付は預り金の借方
  const [{ journal }] = await repo.postPayrolls([dec.id]);
  const refundLine = journal.lines.find((l) => /年末調整/.test(l.memo));
  assert.equal(refundLine.side, fixed.result.diff < 0 ? 'debit' : 'credit');
  assert.equal(refundLine.amount, Math.abs(fixed.result.diff));
  await assert.rejects(repo.unsettleYearEnd(saved.id), /計上を取り消す/);
  await repo.unpostPayroll(dec.id);
  const un = await repo.unsettleYearEnd(saved.id);
  assert.equal(un.status, 'fixed');
  const decAfter = await repo.getPayroll(dec.id);
  assert.deepEqual([decAfter.yearEndTax, decAfter.yearEndId], [0, null]);
  // 確定の後に給与が変わると精算できない
  await repo.savePayroll({ ...decAfter, earnings: [{ name: '基本給', amount: 310_000 }] });
  await assert.rejects(repo.settleYearEnd(saved.id, dec.id), /確定した後に給与の支払額.*変わっています/);
  const draft = await repo.unfixYearEnd(saved.id);
  assert.deepEqual([draft.status, draft.result], ['draft', null]);
  await repo.deleteYearEnd(saved.id);
  assert.deepEqual(await repo.listYearEnds(), []);
  repo.close();
});

test('Repository：年末調整をしない人は確定できない・過不足0円は精算しない・年末調整がある人は削除できない', async () => {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  await repo.setup({ settings: createSettings({ businessName: 'x', entityType: 'corporation', taxStatus: 'taxable' }), period: createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' }), accounts: templateAccounts('corporation').map((a) => createAccount(a)) });
  const emp = await repo.saveEmployee({ ...EMP, id: undefined, taxColumn: 'otsu' });
  const ye = await repo.saveYearEnd(yearEndDraft(emp, 2026));
  await assert.rejects(repo.fixYearEnd(ye.id), /乙欄/);
  await assert.rejects(repo.deleteEmployee(emp.id), /年末調整の記録があるため削除できません/);
  const kou = await repo.saveEmployee({ ...EMP, id: undefined, name: '甲', earnings: [{ name: '基本給', amount: 50_000 }], health: 0, pension: 0 });
  await repo.createPayrolls([payrollDraft(kou, { payDate: '2026-12-25' })]);
  const zero = await repo.fixYearEnd((await repo.saveYearEnd(yearEndDraft(kou, 2026))).id);
  assert.equal(zero.result.diff, 0);
  const [p] = (await repo.listPayrolls()).filter((x) => x.employeeId === kou.id);
  await assert.rejects(repo.settleYearEnd(zero.id, p.id), /精算はいりません/);
  repo.close();
});

test('バックアップ：年末調整が往復し、10 から 11 への変換で空になる。参照の不整合は拒否', async () => {
  const { repo, emp, list } = await setupRepo();
  const ye = await repo.saveYearEnd(yearEndDraft(emp, 2026));
  await repo.fixYearEnd(ye.id);
  await repo.settleYearEnd(ye.id, list[11].id);
  const backup = createBackup(await repo.dumpAll());
  assert.equal(backup.version, BACKUP_VERSION);
  assert.ok(BACKUP_VERSION >= 11);
  const parsed = parseBackup(JSON.stringify(backup));
  assert.equal(parsed.yearEnds.length, 1);
  const other = await openDB({ indexedDB: new IDBFactory() });
  await other.replaceAll(parsed);
  assert.deepEqual(await other.listYearEnds(), await repo.listYearEnds());
  assert.deepEqual(await other.listPayrolls(), await repo.listPayrolls());
  other.close();
  const v10 = { ...backup, version: 10, payrolls: backup.payrolls.map((p) => ({ ...p, yearEndTax: 0, yearEndId: null })) };
  delete v10.yearEnds;
  assert.deepEqual(parseBackup(JSON.stringify(v10)).yearEnds, []);
  assert.throws(() => parseBackup(JSON.stringify({ ...backup, yearEnds: [] })), /給与のデータが不正/);
  assert.throws(() => parseBackup(JSON.stringify({ ...backup, yearEnds: [{ ...backup.yearEnds[0], employeeId: 'nobody' }] })), /年末調整のデータが不正/);
  assert.throws(() => parseBackup(JSON.stringify({ ...backup, yearEnds: [backup.yearEnds[0], { ...backup.yearEnds[0], id: 'dup' }] })), /年末調整のデータが不正/);
  repo.close();
});

test('スキーマ移行：バージョン10のデータを残したまま年末調整のストアを追加する', async () => {
  const idb = new IDBFactory();
  await new Promise((resolve, reject) => {
    const open = idb.open(DB_NAME, 10);
    open.onupgradeneeded = () => {
      migrate(open.result, 0, open.transaction);
      open.result.deleteObjectStore('yearEnds'); // バージョン10の構成にする
      open.transaction.objectStore('employees').put({ ...EMP, sortOrder: 1, createdAt: 'x', updatedAt: 'x' });
    };
    open.onsuccess = () => {
      open.result.close();
      resolve();
    };
    open.onerror = () => reject(open.error);
  });
  const repo = await openDB({ indexedDB: idb });
  assert.equal(repo.db.version, DB_VERSION);
  assert.ok(DB_VERSION >= 11);
  assert.equal((await repo.getEmployee('e1')).name, '山田 花子');
  assert.deepEqual(await repo.listYearEnds(), []);
  assert.deepEqual([...repo.db.transaction('yearEnds').objectStore('yearEnds').indexNames], ['employeeId']);
  repo.close();
});
