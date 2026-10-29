import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { householdPlan, householdBases, splitByRatio, isValidRatio, householdEligible, findHouseholdJournals, HOUSEHOLD_SOURCE } from '../js/household.js';
import { validateAccount } from '../js/accounts.js';
import { validateJournal } from '../js/journal.js';
import { summarizeTax } from '../js/tax.js';
import { taxChecks } from '../js/tax-reports.js';
import { trialBalance } from '../js/ledger.js';
import { openDB } from '../js/db.js';
import { createSettings, createJournal, createAccount, createPeriod } from '../js/models.js';
import { templateAccounts } from '../js/accounts.js';
import { makeBook } from './helpers.js';

test('事業割合：1〜99の整数だけ。事業分は1円未満を切り捨て、残りが家事分', () => {
  assert.ok(isValidRatio(1) && isValidRatio(99));
  assert.ok(!isValidRatio(0) && !isValidRatio(100) && !isValidRatio(33.3) && !isValidRatio(null));
  assert.deepEqual(splitByRatio(10000, 30), { business: 3000, private: 7000 });
  // 3,333 × 33% = 1,099.89 → 事業分 1,099、家事分 2,234
  assert.deepEqual(splitByRatio(3333, 33), { business: 1099, private: 2234 });
});

test('家事按分：科目・税区分ごとに家事分を貸方にし、事業主貸の借方に合計する', () => {
  const b = makeBook('individual');
  b.byName['地代家賃'].businessRatio = 30;
  b.byName['水道光熱費'].businessRatio = 25;
  const journals = [
    b.j('2026-01-25', [['地代家賃', 120000, 'purchase_exempt']], [['普通預金', 120000]]),
    b.j('2026-02-25', [['地代家賃', 120000, 'purchase_exempt']], [['普通預金', 120000]]),
    b.j('2026-01-31', [['水道光熱費', 11000, 'purchase_10']], [['普通預金', 11000]]),
    b.j('2026-02-28', [['水道光熱費', 2200, 'purchase_8r']], [['現金', 2200]]),
    // 返金（貸方）は差し引く
    b.j('2026-03-10', [['普通預金', 1000]], [['水道光熱費', 1000, 'purchase_10']]),
    // 割合の無い科目は対象外
    b.j('2026-03-01', [['消耗品費', 5500, 'purchase_10']], [['現金', 5500]]),
  ];
  const plan = householdPlan({ accounts: b.accounts, journals, period: b.period });
  const rent = plan.rows.find((r) => r.account.name === '地代家賃');
  assert.deepEqual([rent.amount, rent.business, rent.private], [240000, 72000, 168000]);
  const util = plan.rows.find((r) => r.account.name === '水道光熱費');
  // 10%：11,000−1,000＝10,000 → 家事 7,500。8%：2,200 → 事業 550・家事 1,650
  assert.deepEqual([util.amount, util.business, util.private], [12200, 3050, 9150]);
  assert.equal(plan.total, 168000 + 9150);
  const debit = plan.lines.find((l) => l.side === 'debit');
  assert.equal(debit.accountId, b.byName['事業主貸'].id);
  assert.equal(debit.amount, plan.total);
  const credits = plan.lines.filter((l) => l.side === 'credit').map((l) => [b.accounts.find((a) => a.id === l.accountId).name, l.taxCategory, l.amount]);
  assert.deepEqual(credits.sort(), [['地代家賃', 'purchase_exempt', 168000], ['水道光熱費', 'purchase_10', 7500], ['水道光熱費', 'purchase_8r', 1650]].sort());
  // 仕訳として正しく、登録後の経費は事業分だけになる
  const journal = createJournal({ periodId: b.period.id, date: '2026-12-31', lines: plan.lines, source: HOUSEHOLD_SOURCE, adjusting: true });
  assert.deepEqual(validateJournal(journal, { accounts: b.accounts, subAccounts: [], period: b.period }), []);
  const all = [...journals, journal];
  const rows = trialBalance({ accounts: b.accounts, period: b.period, journals: all }).rows;
  assert.equal(rows.find((r) => r.account.name === '地代家賃').closing, 72000);
  assert.equal(rows.find((r) => r.account.name === '水道光熱費').closing, 3050);
  // 登録済みの家事按分は按分の元に含めない（二重に按分しない）
  assert.equal(householdBases({ accounts: b.accounts, journals: all, period: b.period }).get(b.byName['地代家賃'].id), 240000);
  assert.equal(findHouseholdJournals(all).length, 1);
  // 消費税：課税仕入れ10%は 10,000 − 7,500 ＝ 2,500 だけ残る。税区分のチェックで警告しない
  const sum = summarizeTax(all, { from: b.period.startDate, to: b.period.endDate });
  assert.equal(sum.rows.find((r) => r.code === 'purchase_10').gross, 10000 - 7500 + 5500);
  assert.equal(taxChecks({ journals: [journal], accounts: b.accounts }).length, 0);
});

test('家事按分：減価償却費は対象外（固定資産台帳で按分）、事業割合の検証は個人の経費だけ', () => {
  const b = makeBook('individual');
  assert.equal(householdEligible(b.byName['減価償却費']), false);
  assert.equal(householdEligible(b.byName['地代家賃']), true);
  const ok = validateAccount({ ...b.byName['地代家賃'], businessRatio: 40 }, b.accounts, { entityType: 'individual' });
  assert.equal(ok.businessRatio, undefined);
  assert.match(validateAccount({ ...b.byName['地代家賃'], businessRatio: 100 }, b.accounts, { entityType: 'individual' }).businessRatio, /1〜99/);
  assert.match(validateAccount({ ...b.byName['普通預金'], businessRatio: 40 }, b.accounts, { entityType: 'individual' }).businessRatio, /経費の科目/);
  assert.match(validateAccount({ ...b.byName['減価償却費'], businessRatio: 40 }, b.accounts, { entityType: 'individual' }).businessRatio, /経費の科目/);
  const c = makeBook('corporation');
  assert.match(validateAccount({ ...c.byName['地代家賃'], businessRatio: 40 }, c.accounts, { entityType: 'corporation' }).businessRatio, /個人/);
});

test('リポジトリ：事業割合をまとめて保存し、不正な値はまとめて拒否する', async () => {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('individual').map((a) => createAccount(a));
  await repo.setup({ settings: createSettings({ businessName: 'テスト', entityType: 'individual' }), period: createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' }), accounts });
  const rent = accounts.find((a) => a.name === '地代家賃');
  const util = accounts.find((a) => a.name === '水道光熱費');
  await repo.saveBusinessRatios({ [rent.id]: 30, [util.id]: 25 });
  let list = await repo.listAccounts();
  assert.equal(list.find((a) => a.id === rent.id).businessRatio, 30);
  await assert.rejects(repo.saveBusinessRatios({ [rent.id]: 50, [util.id]: 120 }), /水道光熱費/);
  list = await repo.listAccounts();
  assert.equal(list.find((a) => a.id === rent.id).businessRatio, 30); // 1件も保存しない
  await repo.saveBusinessRatios({ [util.id]: null });
  list = await repo.listAccounts();
  assert.equal(list.find((a) => a.id === util.id).businessRatio, null);
  repo.close();
});
