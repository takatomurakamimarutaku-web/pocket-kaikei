import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { spreadAnnual, budgetTotal, validateBudget, budgetVsActual, monthlySales, budgetFromActuals, isBudgetable } from '../js/budget.js';
import { cashPlan } from '../js/cash-flow.js';
import { openDB, DB_NAME, DB_VERSION, migrate } from '../js/db.js';
import { createBackup, parseBackup } from '../js/backup.js';
import { createSettings, createAccount, createPeriod, createBudget, createTemplate } from '../js/models.js';
import { templateAccounts } from '../js/accounts.js';
import { monthsInPeriod } from '../js/period.js';
import { makeBook } from './helpers.js';

const row = (res, label, kind = 'line') => res.rows.find((r) => r.label === label && r.kind === kind);

test('年額を月に均等に割り、端数は最後の月に寄せる', () => {
  const months = monthsInPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' });
  const m = spreadAnnual(1000000, months);
  assert.equal(m['2026-01'], 83333);
  assert.equal(m['2026-12'], 83337);
  assert.equal(budgetTotal({ months: m }), 1000000);
  assert.equal(budgetTotal({ months: m }, ['2026-01', '2026-02']), 166666);
  assert.deepEqual(spreadAnnual(0, months)['2026-05'], 0);
});

test('予算の検証：損益の科目だけ、会計期間の月、0以上の整数', () => {
  const b = makeBook('individual');
  const ctx = { accounts: b.accounts, periods: [b.period] };
  const ok = createBudget({ periodId: b.period.id, accountId: b.byName['売上高'].id, months: { '2026-01': 100000 } });
  assert.deepEqual(validateBudget(ok, ctx), []);
  assert.match(validateBudget({ ...ok, accountId: b.byName['現金'].id }, ctx)[0], /損益の科目だけ/);
  assert.match(validateBudget({ ...ok, accountId: b.byName['期末商品棚卸高'].id }, ctx)[0], /損益の科目だけ/);
  assert.match(validateBudget({ ...ok, months: { '2027-01': 1 } }, ctx)[0], /会計期間の外/);
  assert.match(validateBudget({ ...ok, months: { '2026-01': -1 } }, ctx)[0], /0以上の整数/);
  assert.match(validateBudget({ ...ok, months: { '2026-01': 1.5 } }, ctx)[0], /0以上の整数/);
  assert.equal(isBudgetable(b.byName['消耗品費']), true);
  assert.equal(isBudgetable(b.byName['売掛金']), false);
});

test('予算と実績：範囲の月で損益計算書の形に突き合わせ、差異と達成率を出す', () => {
  const b = makeBook('individual');
  const months = monthsInPeriod(b.period);
  const budgets = [
    createBudget({ periodId: b.period.id, accountId: b.byName['売上高'].id, months: Object.fromEntries(months.map((m) => [m, 500000])) }),
    createBudget({ periodId: b.period.id, accountId: b.byName['消耗品費'].id, months: spreadAnnual(120000, months) }),
    createBudget({ periodId: 'other', accountId: b.byName['通信費'].id, months: { '2026-01': 99999 } }), // ほかの期間の予算は使わない
  ];
  const journals = [
    b.j('2026-01-10', [['売掛金', 600000]], [['売上高', 600000]]),
    b.j('2026-02-10', [['売掛金', 400000]], [['売上高', 400000]]),
    b.j('2026-01-20', [['消耗品費', 15000]], [['現金', 15000]]),
    b.j('2026-03-05', [['消耗品費', 9000]], [['現金', 9000]]),
  ];
  const ctx = { entityType: 'individual', accounts: b.accounts, period: b.period, journals, budgets };
  const jf = budgetVsActual({ ...ctx, fromMonth: '2026-01', toMonth: '2026-02' });
  const sales = row(jf, '売上高');
  assert.deepEqual([sales.budget, sales.actual, sales.diff, sales.achievement], [1000000, 1000000, 0, 1000]);
  const supplies = row(jf, '消耗品費');
  assert.deepEqual([supplies.budget, supplies.actual, supplies.diff, supplies.achievement], [20000, 15000, -5000, 750]);
  assert.equal(row(jf, '通信費').budget, 0);
  const income = row(jf, '青色申告特別控除前の所得金額', 'subtotal');
  assert.deepEqual([income.budget, income.actual, income.diff], [980000, 985000, 5000]);
  const year = budgetVsActual(ctx);
  assert.deepEqual([row(year, '売上高').budget, row(year, '売上高').achievement], [6000000, 167]);
  assert.equal(row(year, '消耗品費').actual, 24000);
  // 売上のグラフ
  const series = monthlySales({ accounts: b.accounts, period: b.period, journals, budgets });
  assert.deepEqual(series.slice(0, 3).map((s) => [s.actual, s.budget]), [[600000, 500000], [400000, 500000], [0, 500000]]);
});

test('前期の実績から予算を作る：同じ暦の月の実績×割合（四捨五入）、純額がマイナスの月は入れない', () => {
  const b = makeBook('individual');
  const prevPeriod = createPeriod({ startDate: '2025-01-01', endDate: '2025-12-31' });
  const prevJournals = [
    b.j('2025-03-10', [['売掛金', 100000]], [['売上高', 100000]]),
    b.j('2025-03-20', [['売上高', 10000]], [['売掛金', 10000]]), // 返品
    b.j('2025-04-01', [['消耗品費', 3001]], [['現金', 3001]]),
    b.j('2025-05-01', [['現金', 500]], [['消耗品費', 500]]), // 戻りだけの月
  ];
  const made = budgetFromActuals({ accounts: b.accounts, prevPeriod, prevJournals, period: b.period, ratio: 110 });
  const by = Object.fromEntries(made.map((e) => [b.accounts.find((a) => a.id === e.accountId).name, e.months]));
  assert.deepEqual(by['売上高'], { '2026-03': 99000 });
  assert.deepEqual(by['消耗品費'], { '2026-04': 3301 });
  assert.equal(Object.keys(by).length, 2);
});

test('資金繰り表：予算を入れた科目は来月から予算の額で予定にし、その科目の定型仕訳は重ねない。減価償却費は除く', () => {
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
  const phone = createTemplate({
    name: '電話代',
    repeatDay: 10,
    lines: [
      { side: 'debit', accountId: b.byName['通信費'].id, subAccountId: null, amount: 5000, taxCategory: 'purchase_10', memo: '' },
      { side: 'credit', accountId: b.byName['普通預金'].id, subAccountId: null, amount: 5000, taxCategory: 'none', memo: '' },
    ],
  });
  const budgets = [
    createBudget({ periodId: b.period.id, accountId: b.byName['売上高'].id, months: { '2026-10': 999, '2026-11': 300000, '2026-12': 300000 } }),
    createBudget({ periodId: b.period.id, accountId: b.byName['地代家賃'].id, months: { '2026-11': 90000 } }),
    createBudget({ periodId: b.period.id, accountId: b.byName['減価償却費'].id, months: { '2026-11': 10000 } }),
  ];
  const plan = cashPlan({ accounts: b.accounts, period: b.period, journals: [], templates: [rent, phone], budgets, today: '2026-10-15' });
  const [oct, nov, dec] = plan.months.slice(9);
  assert.deepEqual([oct.plan, oct.values.sales_in], [false, 0]); // 今月までは実績だけ（予算は使わない）
  assert.deepEqual([nov.values.sales_in, nov.values.expense_out], [300000, 90000 + 5000]); // 家賃は予算の9万、電話代は定型仕訳
  assert.deepEqual([dec.values.sales_in, dec.values.expense_out], [300000, 5000]); // 家賃の予算の無い月は0
  const without = cashPlan({ accounts: b.accounts, period: b.period, journals: [], templates: [rent, phone], today: '2026-10-15' });
  assert.equal(without.months[10].values.expense_out, 85000);
});

async function setupRepo() {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('individual').map((a) => createAccount(a));
  const period = createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト商店', entityType: 'individual' }), period, accounts });
  const byName = Object.fromEntries(accounts.map((a) => [a.name, a]));
  return { repo, byName, period };
}

test('予算の保存：まとめて検証して保存、0だけの科目は消して tombstone、誤りがあれば何も保存しない', async () => {
  const { repo, byName, period } = await setupRepo();
  let res = await repo.saveBudgets(period.id, [
    { accountId: byName['売上高'].id, months: { '2026-01': 100000, '2026-02': 0 } },
    { accountId: byName['消耗品費'].id, months: { '2026-01': 3000 } },
    { accountId: byName['通信費'].id, months: {} },
  ]);
  assert.deepEqual(res, { saved: 2, deleted: 0 });
  let list = await repo.listBudgets(period.id);
  assert.equal(list.length, 2);
  assert.deepEqual(list.find((x) => x.accountId === byName['売上高'].id).months, { '2026-01': 100000 });
  const supplyId = list.find((x) => x.accountId === byName['消耗品費'].id).id;
  res = await repo.saveBudgets(period.id, [
    { accountId: byName['売上高'].id, months: { '2026-01': 120000 } },
    { accountId: byName['消耗品費'].id, months: { '2026-01': 0 } },
  ]);
  assert.deepEqual(res, { saved: 1, deleted: 1 });
  list = await repo.listBudgets(period.id);
  assert.deepEqual(list.map((x) => x.months['2026-01']), [120000]);
  const dump = await repo.dumpAll();
  assert.ok(dump.tombstones.some((t) => t.store === 'budgets' && t.id === supplyId));
  await assert.rejects(repo.saveBudgets(period.id, [{ accountId: byName['売上高'].id, months: { '2026-01': 1 } }, { accountId: byName['現金'].id, months: { '2026-01': 1 } }]), /損益の科目だけ/);
  assert.equal((await repo.listBudgets(period.id))[0].months['2026-01'], 120000);
  // 自分で追加した科目を削除すると、その予算も消える
  const custom = await repo.saveAccount(createAccount({ code: '650', name: '研修費', group: 'sga' }));
  await repo.saveBudgets(period.id, [{ accountId: custom.id, months: { '2026-03': 5000 } }]);
  await repo.deleteAccount(custom.id);
  assert.ok(!(await repo.listBudgets(period.id)).some((x) => x.accountId === custom.id));
  // バックアップ：予算を含み、バージョン4は空で読み込み、不正な予算は拒否
  const backup = createBackup(await repo.dumpAll());
  assert.equal(parseBackup(JSON.stringify(backup)).budgets.length, 1);
  const { budgets: _omit, ...v4 } = backup;
  assert.deepEqual(parseBackup(JSON.stringify({ ...v4, version: 4 })).budgets, []);
  assert.throws(() => parseBackup(JSON.stringify({ ...backup, budgets: [{ ...backup.budgets[0], months: { '2026-01': -5 } }] })), /予算/);
  repo.close();
});

test('スキーマ移行：バージョン4のデータを残したまま予算のストアを追加する', async () => {
  const idb = new IDBFactory();
  await new Promise((resolve, reject) => {
    const open = idb.open(DB_NAME, 4);
    open.onupgradeneeded = () => {
      migrate(open.result, 0, open.transaction);
      open.result.deleteObjectStore('budgets'); // バージョン4の構成にする
      open.transaction.objectStore('templates').put({ id: 't1', name: '家賃', lines: [], repeatDay: null, createdAt: 'x', updatedAt: 'x' });
    };
    open.onsuccess = () => {
      open.result.close();
      resolve();
    };
    open.onerror = () => reject(open.error);
  });
  const repo = await openDB({ indexedDB: idb });
  assert.equal(repo.db.version, DB_VERSION);
  assert.equal((await repo.listTemplates())[0].name, '家賃');
  assert.deepEqual(await repo.listBudgets('p1'), []);
  repo.close();
});
