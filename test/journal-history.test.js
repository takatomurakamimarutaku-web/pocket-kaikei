import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { openDB, migrate, DB_NAME, DB_VERSION } from '../js/db.js';
import { createSettings, createPeriod, createAccount, createJournal, createSubAccount } from '../js/models.js';
import { templateAccounts } from '../js/accounts.js';
import { searchJournals, isLateInput, describeChange, journalChanged, hasCriteria } from '../js/journal-history.js';
import { createBackup, parseBackup } from '../js/backup.js';
import { normalize } from '../js/search.js';
import { formatYen } from '../js/money.js';

async function setupRepo() {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('individual').map((a) => createAccount(a));
  const period = createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト商店', entityType: 'individual' }), period, accounts });
  const byName = Object.fromEntries(accounts.map((a) => [a.name, a]));
  const line = (side, name, amount, extra = {}) => ({ side, accountId: byName[name].id, subAccountId: null, amount, taxCategory: 'none', memo: '', ...extra });
  return { repo, accounts, byName, period, line };
}

test('訂正・削除の履歴：登録・訂正・削除・削除の取消を残し、内容が同じ保存は残さない', async () => {
  const { repo, period, line } = await setupRepo();
  const j = await repo.saveJournal(createJournal({ periodId: period.id, date: '2026-01-05', lines: [line('debit', '消耗品費', 3300), line('credit', '現金', 3300)] }));
  await repo.saveJournal({ ...j }); // 変更なし
  const edited = await repo.saveJournal({ ...j, date: '2026-01-06', lines: [line('debit', '消耗品費', 4400), line('credit', '現金', 4400)] });
  assert.equal(edited.no, j.no);
  const deleted = await repo.deleteJournal(j.id);
  await repo.restoreJournal(deleted);
  const history = await repo.listJournalHistory(period.id);
  assert.deepEqual(history.map((e) => e.action).sort(), ['create', 'delete', 'restore', 'update']);
  const upd = history.find((e) => e.action === 'update');
  assert.equal(upd.before.lines[0].amount, 3300);
  assert.equal(upd.after.lines[0].amount, 4400);
  assert.equal(upd.journalNo, j.no);
  const del = history.find((e) => e.action === 'delete');
  assert.equal(del.before.date, '2026-01-06');
  assert.equal(del.after, null);
  for (const e of history) assert.ok(e.id && e.createdAt && e.updatedAt);
  // バックアップに含まれ、読み戻せる
  const dump = await repo.dumpAll();
  assert.equal(dump.journalHistory.length, 4);
  const parsed = parseBackup(JSON.stringify(createBackup(dump)));
  assert.equal(parsed.journalHistory.length, 4);
  repo.close();
});

test('複数の仕訳の一括登録（銀行明細の取込）も1件ずつ登録の履歴を残す', async () => {
  const { repo, period, line } = await setupRepo();
  await repo.saveJournals([
    createJournal({ periodId: period.id, date: '2026-02-01', lines: [line('debit', '通信費', 500), line('credit', '普通預金', 500)] }),
    createJournal({ periodId: period.id, date: '2026-02-02', lines: [line('debit', '通信費', 700), line('credit', '普通預金', 700)] }),
  ]);
  assert.equal((await repo.listJournalHistory()).filter((e) => e.action === 'create').length, 2);
  repo.close();
});

test('スキーマ移行：バージョン2のデータを残したまま履歴のストアを追加する', async () => {
  const idb = new IDBFactory();
  await new Promise((resolve, reject) => {
    const open = idb.open(DB_NAME, 2);
    open.onupgradeneeded = () => {
      migrate(open.result, 0, open.transaction);
      open.result.deleteObjectStore('journalHistory'); // バージョン2の構成にする
      open.result.deleteObjectStore('templates');
      open.result.deleteObjectStore('budgets');
      open.transaction.objectStore('journals').put({ id: 'j1', periodId: 'p1', date: '2026-01-01', no: 1, lines: [], createdAt: 'x', updatedAt: 'x' });
    };
    open.onsuccess = () => {
      open.result.close();
      resolve();
    };
    open.onerror = () => reject(open.error);
  });
  const repo = await openDB({ indexedDB: idb });
  assert.equal(repo.db.version, DB_VERSION);
  assert.equal((await repo.getJournal('j1')).no, 1);
  assert.deepEqual(await repo.listJournalHistory(), []);
  repo.close();
});

test('バックアップ：バージョン2のファイルは履歴を空にして読み込み、不正な履歴は拒否する', async () => {
  const { repo } = await setupRepo();
  const dump = await repo.dumpAll();
  const v3 = createBackup(dump);
  const { journalHistory: _omit, templates: _omit2, budgets: _omit3, ...rest } = v3;
  const v2 = { ...rest, version: 2 };
  assert.deepEqual(parseBackup(JSON.stringify(v2)).journalHistory, []);
  const broken = { ...v3, journalHistory: [{ id: 'h1', createdAt: 'x', updatedAt: 'x', journalId: 'j', at: 'x', action: 'edit', before: {}, after: null }] };
  assert.throws(() => parseBackup(JSON.stringify(broken)), /仕訳の変更履歴/);
  repo.close();
});

test('組合せ検索：日付・金額の範囲、取引先（補助科目・摘要）、科目', () => {
  const accountById = new Map([['a1', { name: '消耗品費' }], ['a2', { name: '現金' }], ['a3', { name: '売上高' }]]);
  const sub = createSubAccount({ accountId: 'a3', name: 'A商事' });
  const subById = new Map([[sub.id, sub]]);
  const J = (id, date, amount, extra = {}) => ({ id, date, lines: [{ side: 'debit', accountId: extra.debit || 'a1', subAccountId: null, amount, memo: extra.memo || '' }, { side: 'credit', accountId: extra.credit || 'a2', subAccountId: extra.sub || null, amount, memo: '' }] });
  const js = [J('1', '2026-01-10', 3000, { memo: 'コピー用紙' }), J('2', '2026-02-15', 120000, { debit: 'a2', credit: 'a3', sub: sub.id }), J('3', '2026-03-01', 50000, { memo: 'A商事 打合せ' })];
  const ctx = { accountById, subById, normalize };
  const ids = (c) => searchJournals(js, c, ctx).map((j) => j.id);
  assert.deepEqual(ids({ dateFrom: '2026-02-01', dateTo: '2026-03-31' }), ['2', '3']);
  assert.deepEqual(ids({ amountMin: 10000, amountMax: 100000 }), ['3']);
  assert.deepEqual(ids({ party: 'a商事' }), ['2', '3']);
  assert.deepEqual(ids({ party: 'A商事', amountMin: 100000 }), ['2']);
  assert.deepEqual(ids({ accountId: 'a1', dateTo: '2026-01-31' }), ['1']);
  assert.deepEqual(ids({ text: 'こぴー' }), ['1']);
  assert.equal(hasCriteria({}), false);
  assert.equal(hasCriteria({ amountMin: 0 }), true);
});

test('通常の業務処理期間（2か月）を過ぎた入力・変更の内容の説明', () => {
  assert.equal(isLateInput('2026-01-10', '2026-03-10T09:00:00Z'), false);
  assert.equal(isLateInput('2026-01-10', '2026-03-11T09:00:00Z'), true);
  const accountById = new Map([['a1', { name: '消耗品費' }], ['a2', { name: '現金' }]]);
  const before = { date: '2026-01-05', lines: [{ side: 'debit', accountId: 'a1', amount: 3300, memo: '' }, { side: 'credit', accountId: 'a2', amount: 3300, memo: '' }] };
  const after = { date: '2026-01-06', lines: [{ side: 'debit', accountId: 'a1', amount: 4400, memo: '' }, { side: 'credit', accountId: 'a2', amount: 4400, memo: '' }] };
  const d = describeChange(before, after, { accountById, subById: new Map(), formatYen });
  assert.equal(d[0], '日付 2026/01/05 → 2026/01/06');
  assert.ok(d.includes('削除した行：借方 消耗品費 3,300'));
  assert.ok(d.includes('追加した行：借方 消耗品費 4,400'));
  assert.equal(journalChanged(before, { ...before, updatedAt: 'y' }), false);
});
