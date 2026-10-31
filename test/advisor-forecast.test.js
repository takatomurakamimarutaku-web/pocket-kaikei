import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecastLanding, defaultActualThrough, growthPermille, validateForecast, cleanForecast, amountsByMonth } from '../js/advisor/forecast.js';
import { forecastTaxes } from '../js/advisor/tax-forecast.js';
import { buildStatements } from '../js/statements.js';
import { createBudget, createSettings, createAsset } from '../js/models.js';
import { monthsInPeriod } from '../js/period.js';
import { computeTaxReturn } from '../js/tax-return.js';
import { corporateTaxReturn } from '../js/corporate-tax.js';
import { makeBook } from './helpers.js';

const rowOf = (r, account) => r.rows.find((x) => x.account.id === account.id);

test('実績とみなす月の既定は今日の前月まで（期間の前は無し、期間の後は最後の月）', () => {
  const period = { startDate: '2026-04-01', endDate: '2027-03-31' };
  assert.equal(defaultActualThrough(period, '2026-11-05'), '2026-10');
  assert.equal(defaultActualThrough(period, '2026-04-20'), null);
  assert.equal(defaultActualThrough(period, '2026-03-31'), null);
  assert.equal(defaultActualThrough(period, '2027-05-01'), '2027-03');
  assert.equal(defaultActualThrough(period, '2027-03-31'), '2027-02');
});

test('伸び率は当期の累計÷前期の累計（‰）で、50%〜200%に収める', () => {
  assert.equal(growthPermille(1100, 1000), 1100);
  assert.equal(growthPermille(5000, 1000), 2000);
  assert.equal(growthPermille(100, 1000), 500);
  assert.equal(growthPermille(0, 1000), 1000);
  assert.equal(growthPermille(1000, 0), 1000);
});

test('入力の検証と保存の形', () => {
  assert.deepEqual(validateForecast({ actualThrough: '2026-10', methods: { a: 'budget', b: 'manual' }, manual: { b: 120000 } }), []);
  assert.match(validateForecast({ actualThrough: '2026-13' })[0], /実績とみなす月/);
  assert.match(validateForecast({ methods: { a: 'magic' } })[0], /立て方/);
  assert.match(validateForecast({ manual: { a: 1.5 } })[0], /整数の円/);
  assert.match(validateForecast(null)[0], /不正/);
  // おまかせは保存しない。手入力の金額は「金額を入れる」の科目だけ残す
  assert.deepEqual(cleanForecast({ actualThrough: '2026-10', methods: { a: 'auto', b: 'manual', c: 'none' }, manual: { b: 5, c: 9 } }), { actualThrough: '2026-10', methods: { b: 'manual', c: 'none' }, manual: { b: 5 } });
});

test('すべての月が実績なら、着地は損益計算書と一致する', () => {
  const b = makeBook('corporation');
  const journals = [b.j('2026-01-10', [['売掛金', 1100000]], [['売上高', 1100000]]), b.j('2026-06-20', [['消耗品費', 33000]], [['現金', 33000]]), b.j('2026-12-31', [['支払利息', 5000]], [['普通預金', 5000]])];
  const r = forecastLanding({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals, today: '2027-01-15' });
  assert.equal(r.actualThrough, '2026-12');
  assert.equal(r.forecastMonths.length, 0);
  assert.equal(r.synthetic.length, 0);
  const { pl } = buildStatements({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals });
  assert.equal(r.pl.netIncome, pl.netIncome);
  assert.equal(rowOf(r, b.byName['売上高']).landing, 1100000);
});

test('予算があれば残りの月は予算、無い科目は直近3か月の平均（決算整理を除く）', () => {
  const b = makeBook('individual');
  const months = monthsInPeriod(b.period);
  const budgets = [createBudget({ periodId: b.period.id, accountId: b.byName['売上高'].id, months: Object.fromEntries(months.map((m) => [m, 300000])) })];
  const journals = [];
  for (const m of months.slice(0, 10)) {
    journals.push(b.j(`${m}-10`, [['売掛金', 250000]], [['売上高', 250000]]));
    journals.push(b.j(`${m}-20`, [['通信費', 10000 + Number(m.slice(5)) * 100]], [['現金', 10000 + Number(m.slice(5)) * 100]]));
  }
  const r = forecastLanding({ entityType: 'individual', accounts: b.accounts, period: b.period, journals, budgets, today: '2026-11-03' });
  assert.equal(r.actualThrough, '2026-10');
  assert.deepEqual(r.forecastMonths, ['2026-11', '2026-12']);
  const sales = rowOf(r, b.byName['売上高']);
  assert.equal(sales.resolved, 'budget');
  assert.equal(sales.actual, 2500000);
  assert.equal(sales.forecast, 600000);
  assert.equal(sales.landing, 3100000);
  const tel = rowOf(r, b.byName['通信費']);
  assert.equal(tel.resolved, 'average');
  // 8〜10月の平均：(10800+10900+11000)/3 = 10900
  assert.equal(tel.forecast, 21800);
  // 着地の損益計算書は実績＋予測の仕訳から作るので、科目の着地の合計と一致する
  assert.equal(r.pl.profits.sales, 3100000);
});

test('前期の同じ月×伸び率：同じ暦の月で合わせ、1円未満は四捨五入', () => {
  const prev = makeBook('individual', { startDate: '2025-01-01', endDate: '2025-12-31' });
  const b = makeBook('individual');
  // 科目の id を前期と当期でそろえる（同じ帳簿）
  const accounts = b.accounts;
  const byName = b.byName;
  const pj = (date, amount) => ({ ...prev.j(date, [['売掛金', amount]], [['売上高', amount]]), lines: [
    { side: 'debit', accountId: byName['売掛金'].id, subAccountId: null, amount, taxCategory: 'none', memo: '' },
    { side: 'credit', accountId: byName['売上高'].id, subAccountId: null, amount, taxCategory: 'sales_10', memo: '' },
  ] });
  const prevJournals = monthsInPeriod(prev.period).map((m) => pj(`${m}-15`, m === '2025-12' ? 999999 : 100000));
  const journals = monthsInPeriod(b.period).slice(0, 11).map((m) => b.j(`${m}-15`, [['売掛金', 121000]], [['売上高', 121000]]));
  const r = forecastLanding({ entityType: 'individual', accounts, period: b.period, journals, prev: { period: prev.period, journals: prevJournals }, today: '2026-12-01' });
  const sales = rowOf(r, byName['売上高']);
  assert.equal(sales.resolved, 'last_year');
  assert.equal(sales.growth, 1210);
  assert.equal(sales.forecast, Math.round((999999 * 1210) / 1000));
  assert.equal(sales.previous, 100000 * 11 + 999999);
});

test('手入力は残りの月に均等に割り、見込まないは0円', () => {
  const b = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  const journals = [b.j('2026-04-10', [['売掛金', 500000]], [['売上高', 500000]]), b.j('2026-05-10', [['広告宣伝費', 90000]], [['現金', 90000]])];
  const input = { methods: { [b.byName['売上高'].id]: 'manual', [b.byName['広告宣伝費'].id]: 'none' }, manual: { [b.byName['売上高'].id]: 1000000 } };
  const r = forecastLanding({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals, input, today: '2027-01-10' });
  assert.deepEqual(r.forecastMonths, ['2027-01', '2027-02', '2027-03']);
  const sales = rowOf(r, b.byName['売上高']);
  assert.equal(sales.forecast, 1000000);
  assert.deepEqual(sales.monthly.slice(-3), [333333, 333333, 333334]);
  assert.equal(rowOf(r, b.byName['広告宣伝費']).forecast, 0);
  // 予測の仕訳は貸借が一致し、相手科目は現金
  for (const j of r.synthetic) {
    const d = j.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0);
    const c = j.lines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amount, 0);
    assert.equal(d, c);
    assert.ok(j.lines.some((l) => l.accountId === b.byName['現金'].id));
  }
});

test('減価償却：仕訳が無ければ固定資産台帳の償却額を期末に見込み、仕訳があれば二重に数えない', () => {
  const b = makeBook('corporation');
  const asset = createAsset({ name: '工作機械', category: 'machinery', accountId: b.byName['機械装置'].id, acquiredOn: '2026-01-10', startedOn: '2026-01-10', cost: 1200000, usefulLife: 10 });
  const journals = [b.j('2026-01-10', [['機械装置', 1200000]], [['普通預金', 1200000]])];
  const r = forecastLanding({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals, assets: [asset], periods: [b.period], today: '2026-11-15' });
  const dep = rowOf(r, b.byName['減価償却費']);
  assert.equal(dep.resolved, 'asset');
  assert.equal(r.depreciation.booked, false);
  assert.ok(dep.forecast > 0);
  assert.equal(dep.forecast, r.depreciation.expected);
  assert.equal(dep.monthly.at(-1), dep.forecast);
  // 減価償却の仕訳を登録したあと
  const booked = [...journals, { ...b.j('2026-12-31', [['減価償却費', dep.forecast]], [['機械装置', dep.forecast]]), source: 'depreciation' }];
  const r2 = forecastLanding({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals: booked, assets: [asset], periods: [b.period], today: '2027-01-15' });
  const dep2 = rowOf(r2, b.byName['減価償却費']);
  assert.notEqual(dep2.resolved, 'asset');
  assert.equal(dep2.landing, dep.forecast);
});

test('法人税等の科目は予測しない（税額は納税予測で計算する）', () => {
  const b = makeBook('corporation');
  const tax = b.accounts.find((a) => a.group === 'income_taxes');
  const journals = [b.j('2026-06-30', [['法人税、住民税及び事業税', 70000]], [['普通預金', 70000]])];
  const r = forecastLanding({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals, today: '2026-11-15' });
  assert.equal(r.rows.some((x) => x.account.id === tax.id), false);
  assert.equal(amountsByMonth({ accounts: b.accounts, period: b.period, journals }).has(tax.id), false);
});

test('納税予測（法人）：着地の仕訳で法人税の申告と同じ計算をし、消費税等の決算整理を見込む', () => {
  const b = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  const settings = createSettings({ businessName: 'テスト', entityType: 'corporation', taxStatus: 'taxable' });
  const journals = [];
  for (const m of monthsInPeriod(b.period).slice(0, 7)) {
    journals.push(b.j(`${m}-10`, [['売掛金', 2200000]], [['売上高', 2200000, 'sales_10']]));
    journals.push(b.j(`${m}-20`, [['仕入高', 1100000, 'purchase_10']], [['買掛金', 1100000]]));
  }
  const landing = forecastLanding({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals, today: '2026-11-20' });
  assert.equal(landing.pl.profits.sales, 2200000 * 12);
  const t = forecastTaxes({ settings, accounts: b.accounts, period: b.period, journals: landing.journals, actualJournals: journals });
  // 消費税：着地の仕訳でそのまま申告計算した額
  const ct = computeTaxReturn({ journals: landing.journals, period: b.period, entityType: 'corporation' });
  const consumption = t.items.find((i) => i.key === 'consumption');
  assert.equal(consumption.due, ct.payable);
  assert.ok(ct.payable > 0);
  // 消費税等を租税公課として引いた利益で法人税を計算する
  assert.equal(t.pretax, landing.pl.profits.pretax - ct.payable);
  const adjusted = [...landing.journals, ...t.journals.slice(landing.journals.length)];
  const corp = corporateTaxReturn({ accounts: b.accounts, period: b.period, journals: adjusted, input: {}, enterpriseInput: {} });
  assert.equal(t.items.find((i) => i.key === 'corp').annual, corp.dues.find((d) => d.key === 'corp').annual);
  assert.equal(t.incomeTaxes, corp.dues.reduce((s, d) => s + d.annual, 0));
  assert.equal(t.afterTax, t.pretax - t.incomeTaxes);
  assert.equal(t.total, t.items.reduce((s, i) => s + i.due, 0));
  // 期限は事業年度終了の日の翌日から2か月（2027-05-31）
  assert.equal(consumption.deadline, '2027-05-31');
});

test('納税予測（個人・免税）：所得税と個人事業税を出し、消費税は計算しない', () => {
  const b = makeBook('individual');
  const settings = createSettings({ businessName: 'テスト', entityType: 'individual', taxStatus: 'exempt' });
  const journals = monthsInPeriod(b.period).slice(0, 10).map((m) => b.j(`${m}-10`, [['普通預金', 800000]], [['売上高', 800000]]));
  const landing = forecastLanding({ entityType: 'individual', accounts: b.accounts, period: b.period, journals, today: '2026-11-02' });
  assert.equal(landing.pl.profits.sales, 9600000);
  const t = forecastTaxes({ settings, accounts: b.accounts, period: b.period, journals: landing.journals, actualJournals: journals });
  assert.equal(t.items.some((i) => i.key === 'consumption'), false);
  const it = t.items.find((i) => i.key === 'income');
  assert.ok(it.annual > 0);
  assert.equal(it.deadline, '2027-03-15');
  const et = t.items.find((i) => i.key === 'enterprise');
  // 事業税：(9,600,000 − 2,900,000) × 5% = 335,000
  assert.equal(et.annual, 335000);
  assert.ok(t.notes.some((n) => /住民税/.test(n)));
});

test('期間の後で全部が実績でも、減価償却は最後の月に見込む', () => {
  const b = makeBook('individual');
  const asset = createAsset({ name: 'パソコン', category: 'tools', accountId: b.byName['工具器具備品'].id, acquiredOn: '2026-03-01', startedOn: '2026-03-01', cost: 400000, usefulLife: 4 });
  const r = forecastLanding({ entityType: 'individual', accounts: b.accounts, period: b.period, journals: [], assets: [asset], periods: [b.period], today: '2027-02-01' });
  const dep = rowOf(r, b.byName['減価償却費']);
  assert.equal(r.forecastMonths.length, 0);
  assert.ok(dep.forecast > 0);
  assert.equal(dep.monthly.at(-1), dep.forecast);
});

test('着地見込みの設定は Repository で検証して期間に保存し、バックアップに残る', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { openDB, ValidationError } = await import('../js/db.js');
  const { createBackup, parseBackup } = await import('../js/backup.js');
  const { createPeriod, createAccount } = await import('../js/models.js');
  const { templateAccounts } = await import('../js/accounts.js');
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const p = createPeriod({ startDate: '2026-04-01', endDate: '2027-03-31' });
  const accounts = templateAccounts('corporation').map((a) => createAccount(a));
  await repo.setup({ settings: createSettings({ businessName: 'テスト株式会社', entityType: 'corporation' }), period: p, accounts });
  const sales = accounts.find((a) => a.name === '売上高');
  const saved = await repo.saveForecast(p.id, { actualThrough: '2026-09', methods: { [sales.id]: 'manual' }, manual: { [sales.id]: 3000000 } });
  assert.equal(saved.forecast.actualThrough, '2026-09');
  assert.equal(saved.forecast.manual[sales.id], 3000000);
  await assert.rejects(repo.saveForecast(p.id, { manual: { [sales.id]: 1.5 }, methods: { [sales.id]: 'manual' } }), ValidationError);
  const backup = createBackup(await repo.dumpAll());
  const restored = parseBackup(JSON.stringify(backup));
  assert.equal(restored.periods[0].forecast.methods[sales.id], 'manual');
});

test('見込みの月にある仕訳（先日付の予定など）は着地に入れず、決算整理の仕訳は残す', () => {
  const b = makeBook('individual');
  const journals = [
    b.j('2026-09-10', [['普通預金', 300000]], [['売上高', 300000]]),
    b.j('2026-10-10', [['普通預金', 300000]], [['売上高', 300000]]),
    b.j('2026-11-10', [['普通預金', 999999]], [['売上高', 999999]]), // 見込みの月の仕訳
    { ...b.j('2026-12-31', [['租税公課', 50000]], [['未払金', 50000]]), source: 'consumption_tax' },
  ];
  const r = forecastLanding({ entityType: 'individual', accounts: b.accounts, period: b.period, journals, today: '2026-11-15' });
  assert.equal(r.dropped, 1);
  const sales = rowOf(r, b.byName['売上高']);
  assert.equal(sales.actual, 600000);
  // 直近3か月（8〜10月）の平均 200,000 × 2か月
  assert.equal(sales.forecast, 400000);
  assert.equal(r.pl.profits.sales, sales.landing);
  assert.equal(rowOf(r, b.byName['租税公課']).actual, 50000);
});
