import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  parseRate,
  formatRate,
  employmentPremium,
  salaryDeduction,
  basicDeduction,
  monthlyKouTax,
  bonusRate,
  bonusTax,
  autoIncomeTax,
  applyAuto,
  payrollTotals,
  previousMonthSalary,
  validateEmployee,
  validatePayroll,
  validatePayrollSettings,
  resolvePayrollSettings,
  payrollJournal,
  payrollDraft,
  copyPayroll,
  employeeDraft,
  withholdingSummary,
  withholdingPeriods,
  monthlyDeductions,
  paymentJournal,
  payrollsCsv,
  PayrollSetupError,
} from '../js/payroll.js';
import { validateJournal } from '../js/journal.js';
import { templateAccounts, fillHints } from '../js/accounts.js';
import { openDB, DB_NAME, DB_VERSION, migrate, ValidationError } from '../js/db.js';
import { createBackup, parseBackup, BACKUP_VERSION } from '../js/backup.js';
import { createSettings, createAccount, createPeriod, createSubAccount } from '../js/models.js';
import { makeBook } from './helpers.js';

const EMP = { id: 'e1', name: '山田 花子', kana: '', kind: 'employee', taxColumn: 'kou', dependents: 1, earnings: [{ name: '基本給', amount: 250000 }], commute: 10000, health: 12000, pension: 22000, employmentRate: 550, residentTax: 8000, deductions: [], note: '', active: true };

/** 検証を通る給与 */
function sample(fields = {}) {
  return applyAuto({
    id: 'p1',
    employeeId: 'e1',
    kind: 'salary',
    payDate: '2026-10-25',
    title: '10月分',
    name: '山田 花子',
    employeeKind: 'employee',
    taxColumn: 'kou',
    dependents: 1,
    employmentRate: 550,
    earnings: [{ name: '基本給', amount: 250000 }],
    commute: 10000,
    health: 12000,
    pension: 22000,
    employment: 0,
    employmentAuto: true,
    incomeTax: 0,
    incomeTaxAuto: true,
    residentTax: 8000,
    deductions: [],
    note: '',
    journalId: null,
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
    ...fields,
  });
}

test('雇用保険料率の入力：千分率を100倍の整数に（空欄は加入なし）', () => {
  assert.equal(parseRate('5.5'), 550);
  assert.equal(parseRate('６'), 600);
  assert.equal(parseRate('4.75'), 475);
  assert.equal(parseRate(''), null);
  assert.ok(Number.isNaN(parseRate('5.555')));
  assert.ok(Number.isNaN(parseRate('0')));
  assert.ok(Number.isNaN(parseRate('abc')));
  assert.equal(formatRate(550), '5.5');
  assert.equal(formatRate(600), '6');
  assert.equal(formatRate(475), '4.75');
  assert.equal(formatRate(null), '');
});

test('雇用保険料：50銭以下切捨て・50銭1厘以上切上げ', () => {
  assert.equal(employmentPremium(300000, 550), 1650);
  assert.equal(employmentPremium(123456, 550), 679); // 679.008
  assert.equal(employmentPremium(100, 500), 0); // ちょうど50銭 → 切捨て
  assert.equal(employmentPremium(101, 500), 1); // 50銭5厘 → 切上げ
  assert.equal(employmentPremium(300000, null), 0);
  assert.equal(employmentPremium(0, 550), 0);
});

test('月額表の甲欄（電算機計算の特例）：給与所得控除・基礎控除の区分', () => {
  assert.equal(salaryDeduction(158333, 2026), 54167);
  assert.equal(salaryDeduction(158334, 2026), 47501 + 6667); // 30%（1円未満切上げ）
  assert.equal(salaryDeduction(300000, 2026), 60000 + 36667);
  assert.equal(salaryDeduction(708330, 2026), 70833 + 91667);
  assert.equal(salaryDeduction(708331, 2026), 162500);
  assert.equal(salaryDeduction(169444, 2027), 57500);
  assert.equal(salaryDeduction(169445, 2027), 50834 + 6667);
  assert.equal(basicDeduction(2120833, 2026), 48334);
  assert.equal(basicDeduction(2120833, 2027), 51667);
  assert.equal(basicDeduction(2150000, 2026), 40000);
  assert.equal(basicDeduction(2200000, 2026), 26667);
  assert.equal(basicDeduction(2240000, 2026), 13334);
  assert.equal(basicDeduction(2300000, 2026), 0);
});

test('月額表の甲欄：税額（10円未満四捨五入）。税額表の行の真ん中の金額では税額表と同じになる', () => {
  // 令和8年分の月額表の行（165,000〜167,000円 扶養1人 1,510円、443,000〜446,000円 扶養1人 16,100円 など）
  assert.equal(monthlyKouTax(166000, 1, 2026), 1510);
  assert.equal(monthlyKouTax(444500, 1, 2026), 16100);
  assert.equal(monthlyKouTax(128000, 0, 2026), 1300);
  assert.equal(monthlyKouTax(300500, 0, 2026), 7930);
  assert.equal(monthlyKouTax(300500, 1, 2026), 6320);
  assert.equal(monthlyKouTax(300500, 2, 2026), 4700);
  // 行の中の金額では数十円違うことがある（No.2523 例：166,531円 扶養1人は税額表 1,510円）
  assert.equal(monthlyKouTax(166531, 1, 2026), 1530);
  // 非課税の範囲・マイナス
  assert.equal(monthlyKouTax(102000, 0, 2026), 0);
  assert.equal(monthlyKouTax(0, 0, 2026), 0);
  // 高い区分：B = 2,000,000 − 162,500 − 48,334 = 1,789,166 → ×40.84% − 237,893 = 492,802.39
  assert.equal(monthlyKouTax(2000000, 0, 2026), 492800);
  // 令和9年分は給与所得控除の最低額と基礎控除が上がる
  assert.equal(monthlyKouTax(160000, 0, 2026), 2910); // B = 56,999
  assert.equal(monthlyKouTax(160000, 0, 2027), 2600); // B = 50,833
  // 計算方法が入っていない年分
  assert.equal(monthlyKouTax(300000, 0, 2025), null);
});

test('賞与：算出率の表（甲欄・乙欄、令和8年分と令和9年分の区切り）', () => {
  assert.equal(bonusRate(81999, 0, 'kou', 2026), 0);
  assert.equal(bonusRate(82000, 0, 'kou', 2026), 2042);
  assert.equal(bonusRate(285454, 3, 'kou', 2026), 2042); // 181千円以上300千円未満
  assert.equal(bonusRate(3495000, 0, 'kou', 2026), 45945);
  assert.equal(bonusRate(90000, 9, 'kou', 2026), 0); // 7人以上の欄
  assert.equal(bonusRate(320000, 9, 'kou', 2027), 2042);
  assert.equal(bonusRate(85000, 0, 'kou', 2027), 0); // 令和9年分は87千円から
  assert.equal(bonusRate(200000, 0, 'otsu', 2026), 10210);
  assert.equal(bonusRate(295500, 0, 'otsu', 2026), 30630);
  assert.equal(bonusRate(295500, 0, 'otsu', 2027), 20420); // 令和9年分は296千円から
  assert.equal(bonusRate(300000, 0, 'kou', 2025), null);
});

test('賞与の源泉所得税：国税庁 No.2523 の計算例', () => {
  // 例1：前月 285,454円・扶養3人 → 2.042%、389,558円 × 2.042% = 7,954円（1円未満切捨て）
  assert.deepEqual(bonusTax({ amount: 389558, prev: 285454, dependents: 3, column: 'kou', year: 2026 }), { tax: 7954, method: 'rate', rate: 2042 });
  // 例2：前月の10倍を超える → (月額表(1,668,062÷6＋166,531) − 月額表(166,531)) × 6。
  //       税額表では (16,100 − 1,510) × 6 = 87,540円。電算機計算の方法では (16,100 − 1,530) × 6 = 87,420円（目安として出す）
  assert.deepEqual(bonusTax({ amount: 1668062, prev: 166531, dependents: 1, column: 'kou', year: 2026 }), { tax: 87420, method: 'special', divisor: 6 });
  assert.equal(monthlyKouTax(278010 + 166531, 1, 2026), 16100);
  // 例3：前月に給与が無い → 月額表(769,300÷6) × 6（税額表では 1,300 × 6 = 7,800円）
  assert.deepEqual(bonusTax({ amount: 769300, prev: 0, dependents: 0, column: 'kou', year: 2026 }), { tax: 7860, method: 'special', divisor: 6 });
  // 10倍ちょうどは算出率の表
  assert.equal(bonusTax({ amount: 1000000, prev: 100000, dependents: 0, column: 'kou', year: 2026 }).method, 'rate');
  // 計算期間が6か月を超えるときは12
  assert.equal(bonusTax({ amount: 1200000, prev: 0, dependents: 0, column: 'kou', year: 2026, longPeriod: true }).divisor, 12);
  // 乙欄で月額表を使う場合は手で入力
  assert.deepEqual(bonusTax({ amount: 500000, prev: 0, dependents: 0, column: 'otsu', year: 2026 }), { tax: null, method: 'special', reason: 'otsu' });
  assert.equal(bonusTax({ amount: 500000, prev: 200000, dependents: 0, column: 'otsu', year: 2026 }).tax, 51050);
  assert.deepEqual(bonusTax({ amount: 0, prev: 0, dependents: 0, column: 'kou', year: 2026 }), { tax: 0, method: 'rate', rate: 0 });
});

test('源泉所得税の自動計算：給与（甲欄）・乙欄・年分・賞与', () => {
  const p = sample();
  const t = payrollTotals(p);
  assert.equal(p.employment, 1430); // (250,000 + 10,000) × 5.5/1000
  assert.equal(t.afterSocial, 250000 - 12000 - 22000 - 1430);
  assert.equal(p.incomeTax, monthlyKouTax(t.afterSocial, 1, 2026));
  assert.deepEqual(autoIncomeTax(p), { tax: p.incomeTax, method: 'monthly' });
  assert.equal(autoIncomeTax({ ...p, taxColumn: 'otsu' }).reason, 'otsu');
  assert.equal(autoIncomeTax({ ...p, payDate: '2025-12-25' }).reason, 'year');
  // 自動にできないときは今の金額のまま
  assert.equal(applyAuto({ ...p, taxColumn: 'otsu', incomeTax: 9999 }).incomeTax, 9999);
  // 手入力なら計算し直さない
  assert.equal(applyAuto({ ...p, incomeTaxAuto: false, incomeTax: 1 }).incomeTax, 1);
  const bonus = sample({ kind: 'bonus', earnings: [{ name: '賞与', amount: 400000 }], commute: 0, health: 20000, pension: 36600, residentTax: 0, prevAfterSocial: 214570 });
  assert.equal(autoIncomeTax(bonus).method, 'rate');
  assert.equal(bonus.incomeTax, Math.floor(((400000 - 20000 - 36600 - 2200) * bonusRate(214570, 1, 'kou', 2026)) / 100000));
});

test('合計：総支給額・控除合計・差引支給額', () => {
  const p = sample({ deductions: [{ name: '社宅', amount: 15000 }], earnings: [{ name: '基本給', amount: 250000 }, { name: '欠勤控除', amount: -10000 }] });
  const t = payrollTotals(p);
  assert.equal(t.taxable, 240000);
  assert.equal(t.gross, 250000);
  assert.equal(t.social, 12000 + 22000 + p.employment);
  assert.equal(t.deductions, t.social + p.incomeTax + 8000 + 15000);
  assert.equal(t.net, t.gross - t.deductions);
});

test('検証：従業員', () => {
  const ok = validateEmployee({ ...EMP }, { entityType: 'individual' });
  assert.deepEqual(ok, {});
  const e = validateEmployee({ ...EMP, name: '', kind: 'officer', dependents: -1, employmentRate: 0, commute: -1, earnings: [{ name: '', amount: 1 }] }, { entityType: 'individual' });
  assert.ok(e.name && e.kind && e.dependents && e.employmentRate && e.commute && e.items);
  assert.match(validateEmployee({ ...EMP, kind: 'family' }, { entityType: 'corporation' }).kind, /個人事業主だけ/);
});

test('検証：給与（支給・控除・差引支給額・従業員）', () => {
  assert.deepEqual(validatePayroll(sample(), { employees: [EMP] }), []);
  assert.deepEqual(validatePayroll(sample(), { employees: [] }), ['従業員が見つかりません']);
  assert.ok(validatePayroll(sample({ payDate: '2026-02-30' })).includes('支給日を入力してください'));
  assert.match(validatePayroll(sample({ residentTax: 300000 })).join(), /控除の合計が支給額を超えています/);
  assert.match(validatePayroll(sample({ earnings: [], commute: 0, health: 0, pension: 0, employment: 0, employmentAuto: false, residentTax: 0, incomeTax: 0, incomeTaxAuto: false })).join(), /支給する金額/);
  assert.match(validatePayroll(sample({ earnings: [{ name: '基本給', amount: 1.5 }] })).join(), /整数/);
  assert.match(validatePayroll(sample({ deductions: [{ name: '', amount: 100 }] })).join(), /名前/);
  assert.match(validatePayroll(sample({ kind: 'bonus', prevAfterSocial: -1 })).join(), /前月の給与/);
});

test('前月の給与：前月に支払った給与（賞与を除く）の社会保険料等控除後の合計', () => {
  const list = [sample({ id: 'a', payDate: '2026-06-25' }), sample({ id: 'b', payDate: '2026-06-30', earnings: [{ name: '残業', amount: 20000 }], commute: 0, health: 0, pension: 0 }), sample({ id: 'c', payDate: '2026-06-10', kind: 'bonus' }), sample({ id: 'd', payDate: '2026-05-25' }), sample({ id: 'e', employeeId: 'x', payDate: '2026-06-25' })];
  const r = previousMonthSalary(list, 'e1', '2026-07-10');
  assert.equal(r.month, '2026-06');
  assert.equal(r.count, 2);
  assert.equal(r.amount, payrollTotals(list[0]).afterSocial + payrollTotals(list[1]).afterSocial);
  assert.equal(previousMonthSalary(list, 'e1', '2026-01-10').month, '2025-12');
});

test('下書き：従業員の登録内容から（賞与は前月の給与を探す）・複製', () => {
  const p = payrollDraft(EMP, { kind: 'salary', payDate: '2026-10-25' });
  assert.equal(p.title, '10月分');
  assert.equal(p.employment, 1430);
  assert.ok(p.incomeTax > 0);
  assert.deepEqual(validatePayroll({ ...p, id: 'x' }, { employees: [EMP] }), []);
  const b = payrollDraft(EMP, { kind: 'bonus', payDate: '2026-11-10', payrolls: [{ ...p, id: 'p' }] });
  assert.equal(b.prevAfterSocial, payrollTotals(p).afterSocial);
  assert.equal(b.commute, 0);
  assert.equal(b.residentTax, 0);
  const c = copyPayroll({ ...p, id: 'p', journalId: 'j', postedAt: 'x' }, { payDate: '2026-11-25' });
  assert.equal(c.id, undefined);
  assert.equal(c.journalId, null);
  assert.equal(c.title, '11月分');
  assert.equal(employeeDraft().earnings[0].name, '基本給');
});

test('給与の仕訳：借方 給料・通勤手当／貸方 預り金・支払口座。区分で科目が変わる', () => {
  const b = makeBook('individual', { subs: [['預り金', '源泉所得税'], ['預り金', '住民税']] });
  const accounts = b.accounts;
  const settings = { payroll: { accounts: {}, subs: { incomeTax: 'sub-0', residentTax: 'sub-1' }, special: false } };
  const p = sample({ deductions: [{ name: '社宅', amount: 5000 }] });
  const j = payrollJournal(p, { accounts, settings, periodId: b.period.id });
  const name = (id) => accounts.find((a) => a.id === id).name;
  const t = payrollTotals(p);
  assert.deepEqual(
    j.lines.map((l) => [l.side, name(l.accountId), l.amount, l.taxCategory, l.subAccountId]),
    [
      ['debit', '給料賃金', 250000, 'none', null],
      ['debit', '旅費交通費', 10000, 'purchase_10', null],
      ['credit', '預り金', 34000, 'none', null],
      ['credit', '預り金', 1430, 'none', null],
      ['credit', '預り金', p.incomeTax, 'none', 'sub-0'],
      ['credit', '預り金', 8000, 'none', 'sub-1'],
      ['credit', '預り金', 5000, 'none', null],
      ['credit', '当座預金', t.net, 'none', null], // 支払口座の初期値は最初の預金の科目
    ],
  );
  assert.equal(j.source, 'payroll');
  assert.equal(j.sourceId, 'p1');
  assert.match(j.lines[4].memo, /山田 花子 10月分 源泉所得税/);
  assert.deepEqual(validateJournal(j, { accounts, subAccounts: b.subAccounts, period: b.period }), []);
  // 専従者 → 専従者給与
  const f = payrollJournal({ ...p, employeeKind: 'family' }, { accounts, settings, periodId: b.period.id });
  assert.equal(name(f.lines[0].accountId), '専従者給与');
  // 法人：役員 → 役員報酬、賞与 → 賞与
  const c = makeBook('corporation');
  const cn = (id) => c.accounts.find((a) => a.id === id).name;
  assert.equal(cn(payrollJournal({ ...p, employeeKind: 'officer' }, { accounts: c.accounts, settings: {}, periodId: c.period.id }).lines[0].accountId), '役員報酬');
  assert.equal(cn(payrollJournal({ ...p, kind: 'bonus', prevAfterSocial: 0 }, { accounts: c.accounts, settings: {}, periodId: c.period.id }).lines[0].accountId), '賞与');
  assert.equal(cn(payrollJournal(p, { accounts: c.accounts, settings: {}, periodId: c.period.id }).lines[1].accountId), '旅費交通費');
  // 科目が決まらないとき
  assert.throws(() => payrollJournal(p, { accounts: accounts.filter((a) => a.hint !== 'travel'), settings, periodId: b.period.id }), (e) => e instanceof PayrollSetupError && /通勤手当/.test(e.message));
});

test('給与の設定：初期値（目印・区分）と検証', () => {
  const c = makeBook('corporation');
  const cfg = resolvePayrollSettings(undefined, c.accounts);
  const name = (id) => c.accounts.find((a) => a.id === id)?.name;
  assert.equal(name(cfg.accounts.salary), '給料手当');
  assert.equal(name(cfg.accounts.officer), '役員報酬');
  assert.equal(name(cfg.accounts.officerBonus), '役員報酬');
  assert.equal(name(cfg.accounts.deposit), '預り金');
  assert.equal(name(cfg.accounts.welfare), '法定福利費');
  assert.equal(cfg.special, false);
  // 設定した科目が消えていたら初期値
  assert.equal(resolvePayrollSettings({ accounts: { salary: 'gone' } }, c.accounts).accounts.salary, cfg.accounts.salary);
  assert.deepEqual(validatePayrollSettings(undefined), []);
  assert.deepEqual(validatePayrollSettings({ accounts: { salary: cfg.accounts.salary }, subs: {}, special: true }, { accounts: c.accounts, subAccounts: [] }), []);
  assert.match(validatePayrollSettings({ accounts: { salary: cfg.accounts.deposit }, subs: {}, special: false }, { accounts: c.accounts, subAccounts: [] }).join(), /選べません/);
  assert.match(validatePayrollSettings({ accounts: {}, subs: {}, special: 'x' }).join(), /納期の特例/);
  assert.match(validatePayrollSettings({ accounts: {}, subs: { incomeTax: 'nope' }, special: false }, { accounts: c.accounts, subAccounts: [] }).join(), /預り金の科目の補助科目/);
});

test('源泉所得税の納付：毎月（翌月10日、休日なら翌日）と納期の特例（7月10日・翌年1月20日）', () => {
  const monthly = withholdingPeriods(2026, false);
  assert.equal(monthly.length, 12);
  assert.deepEqual(monthly.map((p) => p.due), ['2026-02-10', '2026-03-10', '2026-04-10', '2026-05-11', '2026-06-10', '2026-07-10', '2026-08-10', '2026-09-10', '2026-10-13', '2026-11-10', '2026-12-10', '2027-01-12']);
  assert.equal(monthly[8].nominalDue, '2026-10-10');
  const special = withholdingPeriods(2027, true);
  assert.deepEqual(special.map((p) => [p.key, p.from, p.to, p.due]), [
    ['2027-H1', '2027-01-01', '2027-06-30', '2027-07-12'],
    ['2027-H2', '2027-07-01', '2027-12-31', '2028-01-20'],
  ]);
});

test('源泉所得税の納付の集計：区分・実人員・支給額（非課税の通勤手当を除く）・税額。仕訳を登録した給与だけ', () => {
  const posted = (f) => sample({ journalId: 'j', ...f });
  const list = [
    posted({ id: 'a', payDate: '2026-01-25' }),
    posted({ id: 'b', payDate: '2026-01-31', earnings: [{ name: '残業', amount: 10000 }], commute: 0, health: 0, pension: 0, residentTax: 0 }),
    posted({ id: 'c', employeeId: 'e2', payDate: '2026-01-25' }),
    posted({ id: 'd', employeeId: 'e3', employeeKind: 'officer', kind: 'bonus', prevAfterSocial: 500000, payDate: '2026-01-20', commute: 0, residentTax: 0 }),
    posted({ id: 'e', payDate: '2026-02-25' }),
    sample({ id: 'f', payDate: '2026-02-26' }), // 下書き
  ];
  const [jan, feb] = withholdingSummary(list, { year: 2026, special: false });
  assert.deepEqual(jan.rows.map((r) => [r.id, r.persons]), [['salary', 2], ['bonus', 0], ['officer_bonus', 1]]);
  assert.equal(jan.rows[0].amount, 250000 + 10000 + 250000);
  assert.equal(jan.rows[0].tax, list[0].incomeTax + list[1].incomeTax + list[2].incomeTax);
  assert.equal(jan.tax, jan.rows[0].tax + list[3].incomeTax);
  assert.deepEqual([jan.first, jan.last, jan.posted, jan.drafts], ['2026-01-20', '2026-01-31', 4, 0]);
  assert.equal(feb.drafts, 1);
  assert.equal(feb.posted, 1);
  // 納期の特例：実人員は月ごとの実人員の合計
  const [h1] = withholdingSummary(list, { year: 2026, special: true });
  assert.equal(h1.rows[0].persons, 3);
  assert.equal(h1.due, '2026-07-10');
});

test('住民税・社会保険料の天引きの月ごとの合計と、納付の仕訳（会社負担分）', () => {
  const list = [sample({ journalId: 'j', payDate: '2026-03-25' }), sample({ journalId: 'j', id: 'x', employeeId: 'e2', payDate: '2026-03-25' }), sample({ payDate: '2026-03-26' })];
  const m = monthlyDeductions(list, 2026);
  assert.deepEqual(m[2], { key: '2026-03', residentTax: 16000, social: 68000, employment: 2860 });
  assert.equal(m[3].social, 0);
  const c = makeBook('corporation');
  const j = paymentJournal({ kind: 'social', key: '2026-03', label: '3月支給分', date: '2026-03-31', amount: 68000, companyShare: 69000 }, { accounts: c.accounts, settings: {}, periodId: c.period.id });
  const name = (id) => c.accounts.find((a) => a.id === id).name;
  assert.deepEqual(j.lines.map((l) => [l.side, name(l.accountId), l.amount]), [['debit', '預り金', 68000], ['debit', '法定福利費', 69000], ['credit', '当座預金', 137000]]);
  assert.equal(j.source, 'payroll_payment');
  assert.equal(j.sourceId, 'social:2026-03');
  assert.deepEqual(validateJournal(j, { accounts: c.accounts, subAccounts: [], period: c.period }), []);
});

test('一覧の CSV', () => {
  const csv = payrollsCsv([sample({ journalId: 'j' })]);
  const lines = csv.trim().split(/\r?\n/);
  assert.match(lines[0], /支給日,氏名,区分,種類,題名,課税支給額/);
  assert.match(lines[1], /^2026-10-25,山田 花子,従業員,給与,10月分,250000,10000,260000,12000,22000,1430,/);
  assert.match(lines[1], /,登録済み$/);
});

// ---- Repository ----

async function setupRepo(entityType = 'individual') {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts(entityType).map((a) => createAccount(a));
  const period = createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト商店', entityType, taxStatus: 'taxable' }), period, accounts });
  const byName = Object.fromEntries(accounts.map((a) => [a.name, a]));
  const emp = await repo.saveEmployee({ ...EMP, id: undefined });
  return { repo, byName, period, emp };
}

test('Repository：従業員の保存・検証・削除（給与の記録がある人は削除できない）', async () => {
  const { repo, emp } = await setupRepo();
  assert.equal(emp.sortOrder, 1);
  assert.equal((await repo.saveEmployee({ ...EMP, id: undefined, name: '鈴木 一郎' })).sortOrder, 2);
  await assert.rejects(repo.saveEmployee({ ...EMP, id: undefined, kind: 'officer' }), (e) => e instanceof ValidationError && Boolean(e.errors.kind));
  // 乙欄は扶養親族等の数を0にする・空の明細は捨てる
  const otsu = await repo.saveEmployee({ ...EMP, id: undefined, name: '乙', taxColumn: 'otsu', dependents: 3, earnings: [{ name: '', amount: 0 }, { name: '基本給', amount: 100000 }] });
  assert.equal(otsu.dependents, 0);
  assert.equal(otsu.earnings.length, 1);
  await repo.createPayrolls([payrollDraft(emp, { payDate: '2026-10-25' })]);
  await assert.rejects(repo.deleteEmployee(emp.id), /給与の記録があるため削除できません/);
  await repo.deleteEmployee(otsu.id);
  assert.equal((await repo.listEmployees()).length, 2);
  repo.close();
});

test('Repository：給与の保存・仕訳の登録（変更・削除できない）・計上の取消・削除', async () => {
  const { repo, emp, byName } = await setupRepo();
  await repo.savePayrollSettings({ accounts: { payment: byName['普通預金'].id }, subs: {}, special: true });
  const [p] = await repo.createPayrolls([payrollDraft(emp, { payDate: '2026-10-25' })]);
  const [{ payroll, journal }] = await repo.postPayrolls([p.id]);
  assert.equal(payroll.journalId, journal.id);
  assert.equal(journal.date, '2026-10-25');
  assert.equal(journal.source, 'payroll');
  const credit = journal.lines.find((l) => l.accountId === byName['普通預金'].id);
  assert.equal(credit.amount, payrollTotals(p).net);
  await assert.rejects(repo.postPayrolls([p.id]), /もう登録してあります/);
  await assert.rejects(repo.savePayroll({ ...payroll, title: 'x' }), /変更できません/);
  await assert.rejects(repo.deletePayroll(p.id), /削除できません/);
  // 計上の取消：仕訳を削除して履歴に残る
  const r = await repo.unpostPayroll(p.id);
  assert.equal(r.payroll.journalId, null);
  assert.equal(await repo.getJournal(journal.id), undefined);
  const hist = await repo.listJournalHistory(journal.periodId);
  assert.ok(hist.some((x) => x.journalId === journal.id && x.action === 'delete'));
  // 直して保存・削除
  const fixed = await repo.savePayroll({ ...r.payroll, title: '10月分（訂正）' });
  assert.equal(fixed.title, '10月分（訂正）');
  await repo.deletePayroll(p.id);
  assert.equal(await repo.getPayroll(p.id), undefined);
  repo.close();
});

test('Repository：まとめて登録は1件でも登録できなければ何もしない・締めた期間・仕訳が消された給与はもう一度登録できる', async () => {
  const { repo, emp, period } = await setupRepo();
  const list = await repo.createPayrolls([payrollDraft(emp, { payDate: '2026-11-25' }), payrollDraft(emp, { payDate: '2027-01-25' })]);
  await assert.rejects(repo.postPayrolls(list.map((p) => p.id)), /2027\/01\/25.*会計期間がありません/);
  assert.equal((await repo.listPayrolls()).filter((p) => p.journalId).length, 0);
  const [{ journal }] = await repo.postPayrolls([list[0].id]);
  await repo.deleteJournal(journal.id);
  const [again] = await repo.postPayrolls([list[0].id]);
  assert.notEqual(again.journal.id, journal.id);
  // 締めた期間
  await repo.createNextPeriod(createPeriod({ startDate: '2027-01-01', endDate: '2027-12-31' }), []);
  await repo.closePeriod(period.id);
  await assert.rejects(repo.unpostPayroll(list[0].id), /締めてある/);
  repo.close();
});

test('Repository：給与の設定・納付の仕訳・作った機能で仕訳を探す', async () => {
  const { repo, byName } = await setupRepo();
  await assert.rejects(repo.savePayrollSettings({ accounts: { salary: byName['預り金'].id } }), /選べません/);
  const sub = await repo.saveSubAccount(createSubAccount({ accountId: byName['預り金'].id, name: '源泉所得税' }));
  const s = await repo.savePayrollSettings({ accounts: {}, subs: { incomeTax: sub.id }, special: true });
  assert.equal(s.payroll.special, true);
  assert.equal(s.payroll.subs.incomeTax, sub.id);
  const j = await repo.savePayrollPayment({ kind: 'incomeTax', key: '2026-H1', label: '1〜6月', date: '2026-07-10', amount: 12340 });
  assert.equal(j.lines[0].subAccountId, sub.id);
  assert.equal(j.sourceId, 'incomeTax:2026-H1');
  assert.deepEqual((await repo.listJournalsBySource('payroll_payment')).map((x) => x.id), [j.id]);
  await assert.rejects(repo.savePayrollPayment({ kind: 'incomeTax', key: 'x', label: '', date: '2028-01-20', amount: 1 }), /会計期間がありません/);
  await assert.rejects(repo.savePayrollPayment({ kind: 'incomeTax', key: 'x', label: '', date: '2026-07-10', amount: 0 }), /金額を入力/);
  repo.close();
});

test('バックアップ：従業員・給与・給与の設定が往復し、9 から 10 への変換で空になる。不正なデータは拒否', async () => {
  const { repo, emp } = await setupRepo();
  await repo.savePayrollSettings({ accounts: {}, subs: {}, special: true });
  const [p] = await repo.createPayrolls([payrollDraft(emp, { payDate: '2026-10-25' })]);
  await repo.postPayrolls([p.id]);
  const backup = createBackup(await repo.dumpAll());
  assert.equal(backup.version, BACKUP_VERSION);
  assert.ok(BACKUP_VERSION >= 10);
  const parsed = parseBackup(JSON.stringify(backup));
  assert.equal(parsed.employees.length, 1);
  assert.equal(parsed.payrolls.length, 1);
  assert.equal(parsed.settings.payroll.special, true);
  const other = await openDB({ indexedDB: new IDBFactory() });
  await other.replaceAll(parsed);
  assert.deepEqual(await other.listPayrolls(), await repo.listPayrolls());
  assert.deepEqual(await other.listEmployees(), await repo.listEmployees());
  other.close();
  const v9 = { ...backup, version: 9 };
  delete v9.employees;
  delete v9.payrolls;
  delete v9.settings.payroll;
  const up = parseBackup(JSON.stringify(v9));
  assert.deepEqual([up.employees, up.payrolls], [[], []]);
  assert.throws(() => parseBackup(JSON.stringify({ ...backup, payrolls: [{ ...backup.payrolls[0], employeeId: 'nobody' }] })), /給与のデータが不正/);
  assert.throws(() => parseBackup(JSON.stringify({ ...backup, employees: [{ ...backup.employees[0], taxColumn: 'x' }] })), /従業員のデータが不正/);
  assert.throws(() => parseBackup(JSON.stringify({ ...backup, settings: { ...backup.settings, payroll: { special: 'yes' } } })), /給与の設定が不正/);
  repo.close();
});

test('スキーマ移行：バージョン9のデータを残したまま従業員・給与のストアを追加する', async () => {
  const idb = new IDBFactory();
  await new Promise((resolve, reject) => {
    const open = idb.open(DB_NAME, 9);
    open.onupgradeneeded = () => {
      migrate(open.result, 0, open.transaction);
      open.result.deleteObjectStore('employees'); // バージョン9の構成にする
      open.result.deleteObjectStore('payrolls');
      open.transaction.objectStore('invoices').put({ id: 'i1', kind: 'estimate', createdAt: 'x', updatedAt: 'x' });
    };
    open.onsuccess = () => {
      open.result.close();
      resolve();
    };
    open.onerror = () => reject(open.error);
  });
  const repo = await openDB({ indexedDB: idb });
  assert.equal(repo.db.version, DB_VERSION);
  assert.ok(DB_VERSION >= 10);
  assert.equal((await repo.getInvoice('i1')).kind, 'estimate');
  assert.deepEqual(await repo.listEmployees(), []);
  assert.deepEqual(await repo.listPayrolls(), []);
  assert.deepEqual([...repo.db.transaction('payrolls').objectStore('payrolls').indexNames], ['employeeId']);
  repo.close();
});

test('目印：前に作った科目にも給与計算の目印（預り金・給料賃金・旅費交通費・福利厚生費）を補う', () => {
  const accounts = templateAccounts('individual').map((a) => createAccount({ ...a, hint: ['travel', 'salaries', 'deposits_received', 'legal_welfare'].includes(a.hint) ? null : a.hint }));
  const changed = fillHints('individual', accounts);
  assert.deepEqual(changed.map((a) => [a.code, a.hint]).sort(), [['305', 'deposits_received'], ['603', 'travel'], ['611', 'legal_welfare'], ['612', 'salaries']]);
});
