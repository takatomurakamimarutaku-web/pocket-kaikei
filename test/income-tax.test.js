import { test } from 'node:test';
import assert from 'node:assert/strict';
import { incomeTaxOn, basicDeduction, salaryIncome, lifeInsuranceDeduction, earthquakeDeduction, spouseDeduction, dependentDeduction, ageAtYearEnd, computeIncomeTax, validateIncomeTax, DEFAULT_INCOME_TAX } from '../js/income-tax.js';

const business = { revenue: 10000000, income: 4000000, familySalary: 0, blueDeduction: 650000 };

test('速算表：各段の境目', () => {
  assert.equal(incomeTaxOn(1949000), 97450);
  assert.equal(incomeTaxOn(1950000), 97500);
  assert.equal(incomeTaxOn(3300000), 232500);
  assert.equal(incomeTaxOn(7000000), 974000);
  assert.equal(incomeTaxOn(40000000), 13204000);
  assert.equal(incomeTaxOn(0), 0);
});

test('基礎控除：令和7年分と令和8年分（合計所得の段階ごと）', () => {
  assert.deepEqual([1000000, 3000000, 4000000, 6000000, 10000000, 24200000, 26000000].map((n) => basicDeduction(n, 2025)), [950000, 880000, 680000, 630000, 580000, 320000, 0]);
  assert.deepEqual([1000000, 4890000, 4890001, 6550000, 7000000, 23500001].map((n) => basicDeduction(n, 2026)), [1040000, 1040000, 670000, 670000, 620000, 480000]);
});

test('給与所得：最低保障額・4,000円単位の表・令和8年分の特例の段', () => {
  assert.equal(salaryIncome(1500000, 2025), 850000);
  assert.equal(salaryIncome(5000003, 2025), 3560000);
  assert.equal(salaryIncome(7000000, 2025), 5200000);
  assert.equal(salaryIncome(9000000, 2025), 7050000);
  assert.equal(salaryIncome(650000, 2025), 0);
  assert.equal(salaryIncome(740000, 2026), 0);
  assert.equal(salaryIncome(1500000, 2026), 760000);
  assert.equal(salaryIncome(2191500, 2026), 1451000);
  assert.equal(salaryIncome(2195000, 2026), 1453000);
  assert.equal(salaryIncome(2199999, 2026), 1456000);
  assert.equal(salaryIncome(2200000, 2026), 1460000);
  assert.equal(salaryIncome(5000000, 2026), 3560000);
});

test('生命保険料控除：新旧の組合せ・上限・令和8年分の23歳未満の扶養親族の特例', () => {
  const z = { newGeneral: 0, oldGeneral: 0, newMedical: 0, newPension: 0, oldPension: 0 };
  assert.equal(lifeInsuranceDeduction({ ...z, newGeneral: 30000 }).general, 25000);
  assert.equal(lifeInsuranceDeduction({ ...z, newGeneral: 100000 }).general, 40000);
  assert.equal(lifeInsuranceDeduction({ ...z, oldGeneral: 80000 }).general, 45000);
  assert.equal(lifeInsuranceDeduction({ ...z, newGeneral: 30000, oldGeneral: 30000 }).general, 40000);
  assert.equal(lifeInsuranceDeduction({ ...z, newGeneral: 100000 }, true).general, 55000);
  assert.equal(lifeInsuranceDeduction({ ...z, newGeneral: 200000 }, true).general, 60000);
  assert.equal(lifeInsuranceDeduction({ ...z, newGeneral: 33333 }).general, 26667); // 1円未満切上げ
  const all = lifeInsuranceDeduction({ newGeneral: 200000, oldGeneral: 0, newMedical: 200000, newPension: 200000, oldPension: 0 }, true);
  assert.deepEqual([all.general, all.medical, all.pension, all.total], [60000, 40000, 40000, 120000]);
});

test('地震保険料控除', () => {
  assert.equal(earthquakeDeduction({ quake: 30000, oldLongTerm: 0 }), 30000);
  assert.equal(earthquakeDeduction({ quake: 0, oldLongTerm: 15000 }), 12500);
  assert.equal(earthquakeDeduction({ quake: 45000, oldLongTerm: 30000 }), 50000);
});

test('配偶者控除・配偶者特別控除・扶養控除・特定親族特別控除', () => {
  assert.deepEqual(spouseDeduction({ ownIncome: 5000000, spouseIncome: 620000, spouseAge: 40, year: 2026 }), { kind: 'spouse', amount: 380000, elderly: false });
  assert.deepEqual(spouseDeduction({ ownIncome: 5000000, spouseIncome: 620001, spouseAge: 40, year: 2026 }), { kind: 'special', amount: 380000 });
  assert.equal(spouseDeduction({ ownIncome: 5000000, spouseIncome: 600000, spouseAge: 40, year: 2025 }).kind, 'special');
  assert.equal(spouseDeduction({ ownIncome: 9200000, spouseIncome: 1000000, spouseAge: 40, year: 2026 }).amount, 240000);
  assert.equal(spouseDeduction({ ownIncome: 5000000, spouseIncome: 0, spouseAge: 72, year: 2026 }).amount, 480000);
  assert.equal(spouseDeduction({ ownIncome: 10000001, spouseIncome: 0, spouseAge: 40, year: 2026 }).amount, 0);
  assert.deepEqual(dependentDeduction({ birthDate: '2005-06-01', income: 1000000 }, 2026), { kind: 'specific_relative', amount: 410000, age: 21 });
  assert.equal(dependentDeduction({ birthDate: '2005-06-01', income: 600000 }, 2026).amount, 630000);
  assert.equal(dependentDeduction({ birthDate: '2004-06-01', income: 600000 }, 2025).amount, 630000);
  assert.equal(dependentDeduction({ birthDate: '2004-06-01', income: 600000 }, 2025).kind, 'specific_relative');
  assert.equal(dependentDeduction({ birthDate: '1950-03-01', income: 0, livingWithParent: true }, 2026).amount, 580000);
  assert.equal(dependentDeduction({ birthDate: '2015-03-01', income: 0 }, 2026).amount, 0);
  assert.equal(ageAtYearEnd('2010-01-01', 2026), 17);
});

test('確定申告書：事業所得400万円・配偶者・特定扶養・16歳未満の子・保険料（令和8年分）', () => {
  const r = computeIncomeTax({
    year: 2026,
    business,
    input: {
      socialInsurance: 600000,
      smallBusinessAid: 240000,
      life: { newGeneral: 100000, oldGeneral: 0, newMedical: 50000, newPension: 0, oldPension: 0 },
      earthquake: { quake: 20000, oldLongTerm: 0 },
      spouse: { name: '配偶者', birthDate: '1986-05-01', income: 0 },
      dependents: [
        { name: '長男', relation: '子', birthDate: '2005-08-01', income: 0, livingWithParent: false },
        { name: '次男', relation: '子', birthDate: '2016-08-01', income: 0, livingWithParent: false },
      ],
    },
  });
  const L = r.lines;
  assert.equal(r.childRule, true);
  assert.deepEqual([L[12], L[13], L[14], L[15], L[16], L[21], L[23], L[25]], [4000000, 600000, 240000, 87500, 20000, 380000, 630000, 1040000]);
  assert.equal(L[30], 2997500);
  assert.equal(L[31], 1002000);
  assert.equal(L[32], 50100);
  assert.equal(L[45], 1052);
  assert.equal(L[46], 51152);
  assert.equal(L[50], 51100);
  assert.equal(L[52], 51100);
});

test('確定申告書：事業の赤字と給与の通算、源泉徴収で還付', () => {
  const r = computeIncomeTax({ year: 2026, business: { ...business, income: -500000 }, input: { salaryRevenue: 3000000, salaryWithholding: 100000 } });
  const L = r.lines;
  assert.equal(L[6], 2020000);
  assert.equal(L[12], 1520000);
  assert.equal(L[31], 480000);
  assert.equal(L[46], 24504);
  assert.equal(L[50], -75496);
  assert.equal(L[53], 75496);
  assert.equal(L[52], 0);
});

test('医療費控除・寄附金控除・予定納税', () => {
  const r = computeIncomeTax({
    year: 2025,
    business,
    input: { medical: [{ name: '本人', payee: '○○病院', kind: 'treatment', paid: 250000, reimbursed: 30000 }], donations: 30000, prepaid1: 20000, prepaid2: 20000 },
  });
  assert.equal(r.lines[28], 120000);
  assert.equal(r.lines[29], 28000);
  assert.equal(r.lines[51], 40000);
  assert.equal(computeIncomeTax({ year: 2027, business, input: {} }).supported, false);
});

test('入力の検証', () => {
  assert.deepEqual(validateIncomeTax({ ...DEFAULT_INCOME_TAX }), []);
  assert.match(validateIncomeTax({ ...DEFAULT_INCOME_TAX, socialInsurance: -1 }).join(), /0以上/);
  assert.match(validateIncomeTax({ ...DEFAULT_INCOME_TAX, spouse: { name: '', birthDate: 'x', income: 0 } }).join(), /配偶者の氏名/);
  assert.match(validateIncomeTax({ ...DEFAULT_INCOME_TAX, medical: [{ name: 'a', payee: 'b', kind: 'zzz', paid: 1, reimbursed: 0 }] }).join(), /区分/);
});
