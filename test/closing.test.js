import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { nextPeriodDates, previousPeriod, nextPeriod, carryForwardBalances, isOpeningStale, inventoryLines, inventoryAccounts, findInventoryJournals, balancesKey } from '../js/closing.js';
import { openingDiff, computeOwnerCapital } from '../js/ledger.js';
import { buildStatements } from '../js/statements.js';
import { validateJournal } from '../js/journal.js';
import { openDB, ValidationError } from '../js/db.js';
import { templateAccounts, findByRole, fillHints } from '../js/accounts.js';
import { createAccount, createPeriod, createSettings, createJournal } from '../js/models.js';
import { parseBackup, createBackup } from '../js/backup.js';
import { makeBook } from './helpers.js';

test('nextPeriodDates：個人は翌年、法人は翌日から12か月（短い初年度の後も）', () => {
  assert.deepEqual(nextPeriodDates({ startDate: '2026-01-01', endDate: '2026-12-31' }, 'individual'), { startDate: '2027-01-01', endDate: '2027-12-31' });
  assert.deepEqual(nextPeriodDates({ startDate: '2026-04-01', endDate: '2027-03-31' }, 'corporation'), { startDate: '2027-04-01', endDate: '2028-03-31' });
  assert.deepEqual(nextPeriodDates({ startDate: '2026-07-15', endDate: '2027-02-28' }, 'corporation'), { startDate: '2027-03-01', endDate: '2028-02-29' });
});

test('previousPeriod・nextPeriod：日付が連続する期間を探す', () => {
  const a = { id: 'a', startDate: '2026-01-01', endDate: '2026-12-31' };
  const b = { id: 'b', startDate: '2027-01-01', endDate: '2027-12-31' };
  assert.equal(previousPeriod([a, b], b), a);
  assert.equal(previousPeriod([a, b], a), null);
  assert.equal(nextPeriod([a, b], a), b);
  assert.equal(nextPeriod([a, b], b), null);
});

function corpBook() {
  const book = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31', subs: [['普通預金', 'A銀行'], ['普通預金', 'B銀行']] });
  book.opening([['現金', 30000], ['普通預金', 700000, 'A銀行'], ['普通預金', 300000, 'B銀行'], ['資本金', 1000000], ['繰越利益剰余金', 30000]]);
  const { j } = book;
  book.journals = [
    j('2026-05-01', [['普通預金', 550000, null, 'A銀行']], [['売上高', 550000]]),
    j('2026-06-01', [['地代家賃', 110000]], [['普通預金', 110000, null, 'B銀行']]),
    j('2027-03-31', [['法人税、住民税及び事業税', 70000]], [['未払法人税等', 70000]]),
  ];
  return book;
}

test('繰越（法人）：BSの残高を補助科目ごとに繰り越し、繰越利益剰余金に当期純利益を加える。期首は貸借一致', () => {
  const { accounts, subAccounts, period, journals, byName } = corpBook();
  const { balances, netIncome } = carryForwardBalances({ entityType: 'corporation', accounts, subAccounts, period, journals });
  assert.equal(netIncome, 550000 - 110000 - 70000);
  const get = (name, subName) => balances.find((b) => b.accountId === byName[name].id && (b.subAccountId || null) === (subName ? subAccounts.find((s) => s.name === subName).id : null))?.amount;
  assert.equal(get('普通預金', 'A銀行'), 1250000);
  assert.equal(get('普通預金', 'B銀行'), 190000);
  assert.equal(get('現金'), 30000);
  assert.equal(get('未払法人税等'), 70000);
  assert.equal(get('繰越利益剰余金'), 30000 + 370000);
  assert.ok(!balances.some((b) => ['売上高', '地代家賃'].includes(accounts.find((a) => a.id === b.accountId).name)));
  const next = createPeriod({ ...nextPeriodDates(period, 'corporation'), openingBalances: balances });
  assert.equal(openingDiff(next, accounts), 0);
  // 次期の期首BSは前期末のBSと同じ資産合計
  const prevBs = buildStatements({ entityType: 'corporation', accounts, period, journals }).bs;
  const nextBs = buildStatements({ entityType: 'corporation', accounts, period: next, journals: [] }).bs;
  assert.equal(nextBs.totalAssets, prevBs.totalAssets);
  assert.ok(nextBs.balanced);
});

test('繰越（法人）：繰越利益剰余金の残高が0でも当期純利益を期首に入れる', () => {
  const { accounts, period, j, opening, byName } = makeBook('corporation');
  opening([['現金', 100], ['資本金', 100]]);
  const journals = [j('2026-03-01', [['現金', 500]], [['売上高', 500]])];
  const { balances } = carryForwardBalances({ entityType: 'corporation', accounts, period, journals });
  assert.equal(balances.find((b) => b.accountId === byName['繰越利益剰余金'].id).amount, 500);
});

test('繰越（個人）：事業主貸・事業主借を0にし、元入金＝前期の元入金＋所得＋事業主借−事業主貸', () => {
  const { accounts, period, j, opening, byName } = makeBook('individual');
  opening([['現金', 100000], ['普通預金', 400000], ['元入金', 500000]]);
  const journals = [
    j('2026-02-01', [['普通預金', 800000]], [['売上高', 800000]]),
    j('2026-03-01', [['通信費', 50000]], [['普通預金', 50000]]),
    j('2026-04-01', [['事業主貸', 200000]], [['普通預金', 200000]]),
    j('2026-05-01', [['現金', 30000]], [['事業主借', 30000]]),
  ];
  const { balances, netIncome } = carryForwardBalances({ entityType: 'individual', accounts, period, journals });
  assert.equal(netIncome, 750000);
  const roles = new Set(balances.map((b) => accounts.find((a) => a.id === b.accountId).role));
  for (const r of ['owner_drawings', 'owner_borrowings', 'owner_capital']) assert.ok(!roles.has(r), r);
  // saveOpeningBalances と同じ計算で元入金を出す
  const capital = computeOwnerCapital(balances, accounts);
  assert.equal(capital, 500000 + 750000 + 30000 - 200000);
  const next = createPeriod({ ...nextPeriodDates(period, 'individual'), openingBalances: [...balances, { accountId: byName['元入金'].id, subAccountId: null, amount: capital }] });
  assert.equal(openingDiff(next, accounts), 0);
});

test('isOpeningStale：前期の仕訳を直すと期首残高との違いを検出する', () => {
  const { accounts, subAccounts, period, journals, j } = corpBook();
  const { balances } = carryForwardBalances({ entityType: 'corporation', accounts, subAccounts, period, journals });
  const next = createPeriod({ ...nextPeriodDates(period, 'corporation'), openingBalances: [...balances].reverse() });
  const ctx = { entityType: 'corporation', accounts, subAccounts, prevPeriod: period, period: next };
  assert.equal(isOpeningStale({ ...ctx, prevJournals: journals }), false);
  assert.equal(isOpeningStale({ ...ctx, prevJournals: [...journals, j('2026-07-01', [['消耗品費', 1000]], [['現金', 1000]])] }), true);
  assert.equal(balancesKey([{ accountId: 'a', amount: 0 }]), '');
});

test('期末棚卸：期首在庫を売上原価へ、期末在庫を商品へ。売上原価は期首＋仕入−期末', () => {
  const { accounts, subAccounts, period, j, opening, byName } = makeBook('individual');
  opening([['商品', 30000], ['現金', 200000], ['元入金', 230000]]);
  const journals = [j('2026-05-01', [['仕入高', 100000]], [['現金', 100000]])];
  const lines = inventoryLines({ accounts, goodsBalance: 30000, closingAmount: 45000 });
  assert.deepEqual(
    lines.map((l) => [l.side, accounts.find((a) => a.id === l.accountId).name, l.amount]),
    [
      ['debit', '期首商品棚卸高', 30000],
      ['credit', '商品', 30000],
      ['debit', '商品', 45000],
      ['credit', '期末商品棚卸高', 45000],
    ],
  );
  const adj = createJournal({ periodId: period.id, no: 99, date: period.endDate, lines });
  assert.deepEqual(validateJournal(adj, { accounts, subAccounts, period }), []);
  const all = [...journals, adj];
  const { pl, bs } = buildStatements({ entityType: 'individual', accounts, period, journals: all });
  const cogs = pl.items.find((i) => i.label === '売上原価');
  assert.equal(cogs.total, 30000 + 100000 - 45000);
  assert.equal(bs.assets[0].lines.find((l) => l.account.name === '商品').amount, 45000);
  assert.ok(bs.balanced);
  assert.deepEqual(findInventoryJournals(all, accounts), [adj]);
  // 在庫が無い場合は行を作らない
  assert.deepEqual(inventoryLines({ accounts, goodsBalance: 0, closingAmount: 0 }), []);
  assert.ok(inventoryAccounts(accounts).goods === byName['商品']);
});

test('fillHints：後から増やした目印（商品）を、目印が null の既存の科目にも補う', () => {
  const { accounts, byName } = makeBook('corporation');
  byName['商品'].hint = null;
  const filled = fillHints('corporation', accounts);
  assert.deepEqual(filled.map((a) => [a.name, a.hint]), [['商品', 'inventory']]);
});

async function setupRepo() {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('corporation').map((a) => createAccount(a));
  const period = createPeriod({ startDate: '2026-04-01', endDate: '2027-03-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト', entityType: 'corporation' }), period, accounts });
  return { repo, accounts, period, byName: Object.fromEntries(accounts.map((a) => [a.name, a])) };
}

test('Repository：次の期間を作って現在の期間にし、重なる期間・不一致の期首残高は拒否する', async () => {
  const { repo, period, byName } = await setupRepo();
  const balances = [
    { accountId: byName['現金'].id, subAccountId: null, amount: 1000 },
    { accountId: byName['資本金'].id, subAccountId: null, amount: 1000 },
  ];
  await assert.rejects(repo.createNextPeriod(createPeriod({ startDate: '2027-01-01', endDate: '2027-12-31' }), balances), /重なる/);
  await assert.rejects(repo.createNextPeriod(createPeriod(nextPeriodDates(period, 'corporation')), balances.slice(0, 1)), ValidationError);
  const next = await repo.createNextPeriod(createPeriod(nextPeriodDates(period, 'corporation')), balances);
  assert.equal(next.nextJournalNo, 1);
  assert.equal((await repo.getCurrentPeriod()).id, next.id);
  assert.deepEqual((await repo.listPeriods()).map((p) => p.startDate), ['2026-04-01', '2027-04-01']);
  // 番号は期間ごとに1から
  const j = await repo.saveJournal(createJournal({ periodId: next.id, date: '2027-05-01', lines: [
    { side: 'debit', accountId: byName['現金'].id, subAccountId: null, amount: 100, taxCategory: 'none', memo: '' },
    { side: 'credit', accountId: byName['売上高'].id, subAccountId: null, amount: 100, taxCategory: 'none', memo: '' },
  ] }));
  assert.equal(j.no, 1);
  await repo.setCurrentPeriod(period.id);
  assert.equal((await repo.getCurrentPeriod()).id, period.id);
  // 期間の日付変更でほかの期間と重なるのは拒否
  await assert.rejects(repo.savePeriodDates(period.id, { startDate: '2026-05-01', endDate: '2027-04-30' }), /重なります/);
  // 2期分のバックアップは復元の検証を通る
  const backup = createBackup(await repo.dumpAll());
  assert.equal(parseBackup(JSON.stringify(backup)).periods.length, 2);
  repo.close();
});

test('バックアップ：会計期間が重なるデータは拒否する', async () => {
  const { repo } = await setupRepo();
  const data = await repo.dumpAll();
  data.periods.push({ ...data.periods[0], id: 'dup', startDate: '2026-10-01', endDate: '2027-09-30' });
  assert.throws(() => parseBackup(JSON.stringify(createBackup(data))), /重なって/);
  repo.close();
});
