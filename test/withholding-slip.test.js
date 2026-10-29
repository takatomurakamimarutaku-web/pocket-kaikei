import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { eraDate, eraText, yearLabel, isMinor, slipDeadline, payerInfo, withholdingSlip, withholdingSlips, slipTotals, slipsCsvRows, supportedSlipYears, OMIT_LIMIT } from '../js/withholding-slip.js';
import { yearEndCalc, yearEndDraft, yearEndSnapshot, familyDraft, validateYearEnd } from '../js/year-end.js';
import { employeeDraft, validateEmployee, validatePayrollSettings, resolvePayrollSettings } from '../js/payroll.js';
import { templateAccounts } from '../js/accounts.js';
import { openDB } from '../js/db.js';
import { createBackup, parseBackup } from '../js/backup.js';
import { createSettings, createAccount, createPeriod } from '../js/models.js';

const EMP = { ...employeeDraft(), id: 'e1', name: '山田 花子', kana: 'やまだ はなこ', dependents: 2, address: '東京都千代田区霞が関3-1-1', birthDate: '1980-04-01', residentCity: '千代田区' };

const pay = (fields) => ({ employeeId: 'e1', kind: 'salary', payDate: '2026-06-25', taxColumn: 'kou', earnings: [], commute: 0, health: 0, pension: 0, employment: 0, incomeTax: 0, residentTax: 0, deductions: [], journalId: 'j', ...fields });

/** 国税庁「令和8年分 年末調整のしかた」の設例と同じ1年分（給与・賞与） */
const NTA_PAYROLLS = [pay({ earnings: [{ name: '給与', amount: 3_690_000 }], health: 641_525, incomeTax: 40_000 }), pay({ kind: 'bonus', payDate: '2026-12-10', earnings: [{ name: '賞与', amount: 700_000 }], incomeTax: 11_845 })];

function ntaInput() {
  const ye = yearEndDraft({ id: 'e1' }, 2026);
  ye.spouse = { ...familyDraft(), name: '山田 太郎', birthDate: '1985-05-05', income: 0 };
  ye.dependents = [{ ...familyDraft(), name: '山田 一郎', relation: '子', birthDate: '2009-04-01', income: 0 }];
  Object.assign(ye.insurance, { lifeOld: 50_200, pensionNew: 56_000, earthquake: 45_000 });
  return ye;
}

/** 確定した年末調整（確定のときの結果を残す） */
function fixed(ye, payrolls, employee = EMP) {
  return { ...ye, id: 'ye1', status: 'fixed', result: yearEndSnapshot(yearEndCalc(ye, { payrolls, employee })) };
}

test('和暦・年分・提出期限・未成年者（令和8年分は平成21年1月3日以後生）', () => {
  assert.deepEqual(eraDate('2019-05-01'), { era: '令和', year: 1, month: 5, day: 1 });
  assert.equal(eraText('2019-05-01'), '令和元年5月1日');
  assert.equal(eraText('2019-04-30'), '平成31年4月30日');
  assert.equal(eraText('1989-01-08'), '平成元年1月8日');
  assert.equal(eraText('1989-01-07'), '昭和64年1月7日');
  assert.equal(eraText('1926-12-25'), '昭和元年12月25日');
  assert.equal(eraText('1926-12-24'), '大正15年12月24日');
  assert.equal(eraText('1912-07-29'), '明治45年7月29日');
  assert.equal(eraText(''), '');
  assert.equal(eraDate('2026-02-30'), null);
  assert.equal(yearLabel(2026), '令和8年分');
  assert.equal(yearLabel(2019), '令和元年分');
  // 翌年1月31日（土日は翌日）：令和8年分は令和9年2月1日（月）、令和7年分は令和8年2月2日（月）
  assert.equal(slipDeadline(2026), '2027-02-01');
  assert.equal(slipDeadline(2025), '2026-02-02');
  assert.equal(slipDeadline(2027), '2028-01-31');
  assert.equal(isMinor('2009-01-03', 2026), true);
  assert.equal(isMinor('2009-01-02', 2026), false);
  assert.equal(isMinor('', 2026), false);
  assert.deepEqual(supportedSlipYears(), [2026]);
});

test('支払者の欄：給与の設定 → 請求書の発行元 → 事業者名の順に使う', () => {
  assert.deepEqual(payerInfo({ businessName: '山田商店' }), { name: '山田商店', address: '', phone: '' });
  assert.deepEqual(payerInfo({ businessName: '山田商店', invoice: { issuerName: '山田商店 山田太郎', address: '東京都', phone: '03-0000-0000' } }), { name: '山田商店 山田太郎', address: '東京都', phone: '03-0000-0000' });
  assert.deepEqual(payerInfo({ businessName: '山田商店', invoice: { address: '東京都' }, payroll: { payer: { name: '', address: '大阪府', phone: '06' } } }), { name: '山田商店', address: '大阪府', phone: '06' });
});

test('源泉徴収票：国税庁の設例（年末調整をした人）の各欄', () => {
  const ye = fixed(ntaInput(), NTA_PAYROLLS);
  const s = withholdingSlip({ employee: EMP, yearEnd: ye, payrolls: NTA_PAYROLLS, year: 2026 });
  assert.equal(s.adjusted, true);
  assert.equal(s.kind, '給料・賞与');
  assert.equal(s.pay, 4_390_000);
  assert.equal(s.salaryIncome, 3_070_400);
  assert.equal(s.totalDeductions, 2_558_075);
  assert.equal(s.tax, 26_100);
  assert.deepEqual(s.spouse, { has: true, elderly: false, amount: 380_000, income: 0 });
  assert.deepEqual(s.counts, { specific: 0, elderly: 0, elderlyCohabiting: 0, other: 1, specificRelative: 0, young: 0, disabledSpecial: 0, disabledSpecialCohabiting: 0, disabledOther: 0, nonResident: 0 });
  assert.equal(s.social, 641_525);
  assert.equal(s.smallBusiness, 0);
  assert.equal(s.life, 71_550);
  assert.equal(s.earthquake, 45_000);
  assert.equal(s.housing, 0);
  assert.equal(s.basic, 1_040_000);
  assert.equal(s.adjustment, 0);
  assert.deepEqual(s.lifeBreakdown, { lifeNew: 0, lifeOld: 50_200, care: 0, pensionNew: 56_000, pensionOld: 0 });
  assert.deepEqual(s.spouseRow, { name: '山田 太郎', code: '00', nonResident: false });
  assert.deepEqual(s.dependentRows.map((x) => [x.name, x.code]), [['山田 一郎', '00']]);
  assert.deepEqual(s.remarks, []);
  assert.deepEqual(s.warnings, []);
  assert.deepEqual(s.birth, { era: '昭和', year: 55, month: 4, day: 1 });
  assert.equal(s.flags.minor, false);
  assert.equal(s.midway, null);
  // 合計表：前職分が無いので源泉徴収票と同じ
  assert.equal(s.ownPay, 4_390_000);
  assert.equal(s.ownTax, 26_100);
  assert.equal(s.omittable, false);
});

test('源泉徴収票：前職分は支払金額・源泉徴収税額・社会保険料等に含め、摘要に書く（合計表のⒶには含めない）', () => {
  const ye = fixed({ ...ntaInput(), previous: { name: '前の会社', pay: 1_000_000, social: 150_000, tax: 20_000, retiredOn: '2026-03-31' } }, NTA_PAYROLLS);
  const s = withholdingSlip({ employee: { ...EMP, joinedOn: '2026-04-01' }, yearEnd: ye, payrolls: NTA_PAYROLLS, year: 2026 });
  assert.equal(s.pay, 5_390_000);
  assert.equal(s.social, 791_525);
  assert.equal(s.tax, ye.result.annualTax);
  assert.deepEqual(s.remarks, ['前職分 前の会社 支払金額1,000,000円 源泉徴収税額20,000円 社会保険料等150,000円 令和8年3月31日退職']);
  assert.ok(s.warnings.some((w) => /前の支払者の住所/.test(w)));
  assert.deepEqual(s.midway, { joined: true, retired: false, date: '2026-04-01' });
  assert.equal(s.ownPay, 4_390_000);
  assert.equal(s.ownTax, ye.result.annualTax - 20_000);
  // 年末調整の超過額が、この支払者が徴収した税額を上回るときは0
  const loan = fixed({ ...ntaInput(), housingLoan: 300_000, previous: { name: '前の会社', pay: 1_000_000, social: 0, tax: 20_000, retiredOn: '' } }, NTA_PAYROLLS);
  const s2 = withholdingSlip({ employee: EMP, yearEnd: loan, payrolls: NTA_PAYROLLS, year: 2026 });
  assert.equal(s2.tax, 0);
  assert.equal(s2.ownTax, 0);
  assert.equal(s2.housingPossible, 300_000);
  assert.ok(s2.warnings.some((w) => /住宅借入金等特別控除の内訳/.test(w)));
});

test('源泉徴収票：5人目以降・16歳未満（年少）・所得金額調整控除（調整）（同配）・生命保険料控除の特例・非居住者の区分', () => {
  const big = [pay({ earnings: [{ name: '給与', amount: 9_000_000 }], incomeTax: 500_000 })];
  const ye = yearEndDraft({ id: 'e1' }, 2026);
  const dep = (name, birthDate, extra = {}) => ({ ...familyDraft(), name, relation: '子', birthDate, ...extra });
  ye.dependents = [dep('一般1', '1990-01-10'), dep('一般2', '1991-01-10'), dep('一般3', '1992-01-10'), dep('一般4', '1993-01-10'), dep('一般5', '1994-01-10'), ...['年少1', '年少2', '年少3', '年少4', '年少5'].map((n, i) => dep(n, `201${3 + i}-05-01`))];
  ye.insurance.lifeNew = 100_000;
  let s = withholdingSlip({ employee: EMP, yearEnd: fixed(ye, big), payrolls: big, year: 2026 });
  assert.equal(s.dependentRows.length, 4);
  assert.equal(s.youngRows.length, 4);
  assert.equal(s.counts.other, 5);
  assert.equal(s.counts.young, 5);
  assert.ok(s.adjustment > 0);
  // 23歳未満の扶養親族（年少5）は家族の欄に載らないので（調整）。載っている年少1〜4は省略
  assert.deepEqual(s.remarks, ['(5)一般5', '(5)年少5（年少）', '年少5（調整）', '租税特別措置法第41条の15の5第1項適用']);

  // 他の人の扶養控除の対象にしている子は家族の欄に載らない → （調整）
  const other = { ...yearEndDraft({ id: 'e1' }, 2026), dependents: [dep('子', '2016-04-01', { claimedByOther: true })] };
  s = withholdingSlip({ employee: EMP, yearEnd: fixed(other, big), payrolls: big, year: 2026 });
  assert.deepEqual(s.remarks, ['子（調整）']);
  assert.deepEqual(s.youngRows, []);
  // 本人が特別障害者なら書かない
  s = withholdingSlip({ employee: EMP, yearEnd: fixed({ ...other, person: { ...other.person, disability: 'special' } }, big), payrolls: big, year: 2026 });
  assert.deepEqual(s.remarks, []);
  assert.equal(s.flags.disabled, 'special');

  // 本人の合計所得金額が1,000万円を超えて配偶者控除が無い同一生計配偶者が障害者 → （同配）
  const rich = [pay({ earnings: [{ name: '給与', amount: 13_000_000 }], incomeTax: 1_500_000 })];
  const sp = { ...yearEndDraft({ id: 'e1' }, 2026), spouse: { ...familyDraft(), name: '配偶者', birthDate: '1980-01-01', disability: 'special' } };
  s = withholdingSlip({ employee: EMP, yearEnd: fixed(sp, rich), payrolls: rich, year: 2026 });
  assert.equal(s.spouseRow, null);
  assert.equal(s.spouse.has, false);
  assert.deepEqual(s.remarks, ['配偶者（同配）']);

  // 非居住者：配偶者は01、扶養親族は30歳未満・70歳以上が01、30歳以上70歳未満は02〜04を書き足す
  const nr = { ...ntaInput(), spouse: { ...ntaInput().spouse, nonResident: true }, dependents: [dep('留学', '2000-01-10', { nonResident: true }), dep('親', '1960-01-10', { nonResident: true })] };
  s = withholdingSlip({ employee: EMP, yearEnd: fixed(nr, NTA_PAYROLLS), payrolls: NTA_PAYROLLS, year: 2026 });
  assert.equal(s.spouseRow.code, '01');
  assert.deepEqual(s.dependentRows.map((x) => x.code), ['01', null]);
  assert.equal(s.counts.nonResident, 3);
  assert.ok(s.warnings.some((w) => /02 留学/.test(w)));
});

test('源泉徴収票：年末調整をしなかった人（退職者・乙欄）。30万円以下の退職者は提出を省略できる', () => {
  const retiredEmp = { ...EMP, active: false, joinedOn: '2020-04-01', retiredOn: '2026-03-31', residentCollection: 'special' };
  const three = [1, 2, 3].map((m) => pay({ payDate: `2026-0${m}-25`, earnings: [{ name: '給与', amount: 100_000 }], health: 5_000, incomeTax: 1_000 }));
  let s = withholdingSlip({ employee: retiredEmp, yearEnd: null, payrolls: three, year: 2026 });
  assert.equal(s.adjusted, false);
  assert.equal(s.kind, '給料');
  assert.equal(s.pay, OMIT_LIMIT);
  assert.equal(s.tax, 3_000);
  assert.equal(s.social, 15_000);
  assert.equal(s.salaryIncome, null);
  assert.equal(s.totalDeductions, null);
  assert.equal(s.counts, null);
  assert.deepEqual(s.spouse, { has: null, elderly: null, amount: null, income: null });
  assert.equal(s.omittable, true);
  assert.equal(s.retired, true);
  assert.equal(s.collection, 'ordinary');
  assert.deepEqual(s.midway, { joined: false, retired: true, date: '2026-03-31' });
  assert.ok(!s.warnings.some((w) => /年末調整をしていません。/.test(w)));
  assert.ok(s.warnings.some((w) => /扶養控除等申告書を見て/.test(w)));
  // 1円でも超えると提出する
  s = withholdingSlip({ employee: retiredEmp, yearEnd: null, payrolls: [...three, pay({ payDate: '2026-03-31', earnings: [{ name: '精算', amount: 1 }] })], year: 2026 });
  assert.equal(s.omittable, false);
  // 同じ年に就職して退職：退職の欄と退職した日、摘要に「中途就」。死亡退職
  s = withholdingSlip({ employee: { ...retiredEmp, joinedOn: '2026-01-05', deceased: true }, yearEnd: null, payrolls: three, year: 2026 });
  assert.deepEqual(s.midway, { joined: false, retired: true, date: '2026-03-31' });
  assert.deepEqual(s.remarks, ['中途就']);
  assert.equal(s.flags.deceased, true);
  // 乙欄・未成年者・外国人
  const otsu = three.map((p) => ({ ...p, taxColumn: 'otsu' }));
  s = withholdingSlip({ employee: { ...EMP, taxColumn: 'otsu', dependents: 0, birthDate: '2009-06-01', foreigner: true }, yearEnd: null, payrolls: otsu, year: 2026 });
  assert.equal(s.flags.otsu, true);
  assert.equal(s.flags.minor, true);
  assert.equal(s.flags.foreigner, true);
  assert.deepEqual(s.birth, { era: '平成', year: 21, month: 6, day: 1 });
  // 在籍している甲欄の人で年末調整がまだ・下書き
  assert.ok(withholdingSlip({ employee: EMP, yearEnd: null, payrolls: NTA_PAYROLLS, year: 2026 }).warnings.some((w) => /年末調整をしていません/.test(w)));
  assert.ok(withholdingSlip({ employee: EMP, yearEnd: ntaInput(), payrolls: NTA_PAYROLLS, year: 2026 }).warnings.some((w) => /年末調整が確定していません/.test(w)));
  // 住所・生年月日・退職日が無い
  const w = withholdingSlip({ employee: { ...EMP, address: '', birthDate: '', active: false }, yearEnd: null, payrolls: NTA_PAYROLLS, year: 2026 }).warnings.join('\n');
  assert.match(w, /住所を/);
  assert.match(w, /生年月日を/);
  assert.match(w, /退職した日を/);
});

test('源泉徴収票：確定した後に給与が変わったら注意を出す。確定のときの結果で作る', () => {
  const ye = fixed(ntaInput(), NTA_PAYROLLS);
  const more = [...NTA_PAYROLLS, pay({ earnings: [{ name: '手当', amount: 10_000 }] })];
  const s = withholdingSlip({ employee: EMP, yearEnd: ye, payrolls: more, year: 2026 });
  assert.equal(s.pay, 4_390_000);
  assert.ok(s.warnings.some((w) => /確定した後に給与の支払額/.test(w)));
});

test('合計表と給与支払報告書の人数：Ⓐは全員（前職分を含めない）、Ⓑは提出する人（前職分を含める）、市区町村ごと', () => {
  const employees = [
    { ...EMP, id: 'a', name: 'A', residentCity: '千代田区' },
    { ...EMP, id: 'b', name: 'B', residentCity: '横浜市', residentCollection: 'ordinary' },
    { ...EMP, id: 'c', name: 'C', residentCity: '千代田区', active: false, retiredOn: '2026-02-28' },
    { ...EMP, id: 'd', name: 'D', residentCity: '', active: false, retiredOn: '2026-05-31' },
    { ...EMP, id: 'x', name: '給与なし' },
  ];
  const payrolls = [
    pay({ employeeId: 'a', earnings: [{ name: '給与', amount: 3_000_000 }], incomeTax: 50_000 }),
    pay({ employeeId: 'b', earnings: [{ name: '給与', amount: 1_000_000 }], incomeTax: 0 }),
    pay({ employeeId: 'c', payDate: '2026-02-25', earnings: [{ name: '給与', amount: 200_000 }], incomeTax: 4_000 }),
    pay({ employeeId: 'd', payDate: '2026-05-25', earnings: [{ name: '給与', amount: 400_000 }], incomeTax: 8_000 }),
    pay({ employeeId: 'x', payDate: '2025-12-25', earnings: [{ name: '給与', amount: 1 }] }),
  ];
  const ye = fixed({ ...yearEndDraft({ id: 'a' }, 2026), previous: { name: '前', pay: 500_000, social: 0, tax: 10_000, retiredOn: '' } }, payrolls, employees[0]);
  const slips = withholdingSlips({ employees, payrolls, yearEnds: [ye], year: 2026 });
  assert.deepEqual(slips.map((s) => s.name), ['A', 'B', 'C', 'D']);
  const a = slips[0];
  const t = slipTotals(slips);
  assert.deepEqual(t.a, { count: 4, noTax: 1, pay: 3_000_000 + 1_000_000 + 200_000 + 400_000, tax: a.ownTax + 0 + 4_000 + 8_000 });
  assert.deepEqual(t.b, { count: 3, pay: 3_500_000 + 1_000_000 + 400_000, tax: a.tax + 0 + 8_000 });
  assert.equal(t.omitted, 1);
  assert.deepEqual(t.cities, [
    { city: '横浜市', count: 1, special: 0, retired: 0, ordinary: 1 },
    { city: '千代田区', count: 1, special: 1, retired: 0, ordinary: 0 },
    { city: '', count: 1, special: 0, retired: 1, ordinary: 0 },
  ]);
  // CSV：見出しと同じ列数
  const rows = slipsCsvRows(slips);
  assert.equal(rows.length, 5);
  for (const r of rows) assert.equal(r.length, rows[0].length);
  const col = (name) => rows[0].indexOf(name);
  assert.equal(rows[1][col('支払金額')], 3_500_000);
  assert.equal(rows[1][col('年末調整')], '済');
  assert.equal(rows[1][col('生年月日')], '昭和55年4月1日');
  assert.equal(rows[3][col('給与支払報告書')], '省略できる');
  assert.equal(rows[3][col('給与所得控除後の金額（調整控除後）')], '');
  assert.equal(rows[2][col('住民税の徴収')], '普通徴収');
});

test('検証：従業員の住所・生年月日・就職と退職の日・住民税の徴収、支払者の設定、国民年金保険料等', () => {
  assert.deepEqual(validateEmployee({ ...employeeDraft(), name: 'A' }), {});
  // 前の版の従業員（新しい項目が無い）も通る
  const old = { ...employeeDraft(), name: 'A' };
  for (const k of ['address', 'birthDate', 'joinedOn', 'retiredOn', 'residentCity', 'residentCollection', 'foreigner', 'deceased']) delete old[k];
  assert.deepEqual(validateEmployee(old), {});
  const e = validateEmployee({ ...employeeDraft(), name: 'A', address: 'あ'.repeat(121), birthDate: '1990-02-30', joinedOn: '2026-04-01', retiredOn: '2026-03-31', residentCity: 'い'.repeat(31), residentCollection: 'x', foreigner: 'yes' });
  assert.deepEqual(Object.keys(e).sort(), ['address', 'birthDate', 'flags', 'residentCity', 'residentCollection', 'retiredOn']);
  assert.match(e.retiredOn, /就職した日より後/);
  assert.deepEqual(validatePayrollSettings({ accounts: {}, subs: {}, special: false, payer: { name: 'あ', address: '', phone: '0'.repeat(31) } }), ['支払者の電話番号は30文字以内にしてください']);
  assert.deepEqual(validatePayrollSettings({ accounts: {}, subs: {}, special: false, payer: 'x' }), ['支払者の設定が不正です']);
  assert.deepEqual(resolvePayrollSettings(undefined, []).payer, { name: '', address: '', phone: '' });
  const ye = yearEndDraft({ id: 'e1' }, 2026);
  ye.insurance.nationalPension = 10;
  assert.match(validateYearEnd(ye).join(), /国民年金保険料等は申告による社会保険料のうちの金額/);
  ye.insurance.socialDeclared = 10;
  assert.deepEqual(validateYearEnd(ye), []);
});

test('Repository：従業員の新しい項目・支払者の設定を保存し、バックアップで往復する', async () => {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('individual').map((a) => createAccount(a));
  await repo.setup({ settings: createSettings({ businessName: '山田商店', entityType: 'individual', taxStatus: 'taxable' }), period: createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' }), accounts });
  const emp = await repo.saveEmployee({ ...EMP, id: undefined, address: ' 東京都 ', residentCollection: 'ordinary', foreigner: true });
  assert.equal(emp.address, '東京都');
  assert.equal(emp.birthDate, '1980-04-01');
  assert.equal(emp.residentCity, '千代田区');
  assert.equal(emp.residentCollection, 'ordinary');
  assert.equal(emp.foreigner, true);
  assert.equal(emp.deceased, false);
  // 前の版の形で保存しても初期値が入る
  const old = { ...employeeDraft(), name: 'B' };
  delete old.address;
  delete old.residentCollection;
  const b = await repo.saveEmployee(old);
  assert.equal(b.address, '');
  assert.equal(b.residentCollection, 'special');
  // 支払者：保存し、指定しない保存では前の値を残す
  await repo.savePayrollSettings({ accounts: {}, subs: {}, special: false, payer: { name: ' 山田商店 山田太郎 ', address: '東京都', phone: '03' } });
  assert.deepEqual((await repo.getSettings()).payroll.payer, { name: '山田商店 山田太郎', address: '東京都', phone: '03' });
  await repo.savePayrollSettings({ accounts: {}, subs: {}, special: true });
  assert.deepEqual((await repo.getSettings()).payroll.payer, { name: '山田商店 山田太郎', address: '東京都', phone: '03' });
  await assert.rejects(repo.savePayrollSettings({ accounts: {}, subs: {}, special: true, payer: { name: 'あ'.repeat(121) } }), /120文字以内/);
  const backup = createBackup(await repo.dumpAll());
  const parsed = parseBackup(JSON.stringify(backup));
  const other = await openDB({ indexedDB: new IDBFactory() });
  await other.replaceAll(parsed);
  assert.deepEqual(await other.listEmployees(), await repo.listEmployees());
  assert.deepEqual((await other.getSettings()).payroll.payer, { name: '山田商店 山田太郎', address: '東京都', phone: '03' });
  // 不正な生年月日のバックアップは拒否
  assert.throws(() => parseBackup(JSON.stringify({ ...backup, employees: [{ ...backup.employees[0], birthDate: '1980-13-01' }] })), /従業員のデータが不正/);
  other.close();
  repo.close();
});
