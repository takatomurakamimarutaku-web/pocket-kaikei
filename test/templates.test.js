import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { validateTemplate, dayInMonth, repeatLabel, recurringStatus, journalFromTemplate, linesForTemplate, templateAmount, TEMPLATE_SOURCE } from '../js/templates.js';
import { validateJournal } from '../js/journal.js';
import { openDB, DB_NAME, DB_VERSION, migrate } from '../js/db.js';
import { createBackup, parseBackup } from '../js/backup.js';
import { createSettings, createAccount, createPeriod, createTemplate, createSubAccount } from '../js/models.js';
import { templateAccounts } from '../js/accounts.js';
import { makeBook } from './helpers.js';

const rentTemplate = (b, extra = {}) =>
  createTemplate({
    name: '家賃',
    repeatDay: 25,
    lines: [
      { side: 'debit', accountId: b.byName['地代家賃'].id, subAccountId: null, amount: 110000, taxCategory: 'purchase_10', memo: '事務所家賃' },
      { side: 'credit', accountId: b.byName['普通預金'].id, subAccountId: null, amount: 110000, taxCategory: 'none', memo: '事務所家賃' },
    ],
    ...extra,
  });

test('定型仕訳の検証：名前・貸借・金額。毎月作るものは金額が全部入っていて貸借一致', () => {
  const b = makeBook('individual');
  const ctx = { accounts: b.accounts, subAccounts: [] };
  assert.deepEqual(validateTemplate(rentTemplate(b), ctx), []);
  assert.ok(validateTemplate(rentTemplate(b, { name: ' ' }), ctx).includes('名前を入力してください'));
  // 金額0（呼び出し時に入れる）は手で使う定型仕訳ならよい
  const blank = rentTemplate(b, { repeatDay: null, lines: rentTemplate(b).lines.map((l) => ({ ...l, amount: 0 })) });
  assert.deepEqual(validateTemplate(blank, ctx), []);
  assert.ok(validateTemplate({ ...blank, repeatDay: 25 }, ctx).some((e) => /すべての行に金額/.test(e)));
  const unbalanced = rentTemplate(b, { lines: [{ ...rentTemplate(b).lines[0], amount: 100 }, rentTemplate(b).lines[1]] });
  assert.ok(validateTemplate(unbalanced, ctx).some((e) => /一致/.test(e)));
  assert.ok(validateTemplate(rentTemplate(b, { repeatDay: 32 }), ctx).some((e) => /1〜31/.test(e)));
  assert.ok(validateTemplate(rentTemplate(b, { lines: [rentTemplate(b).lines[0]] }), ctx).some((e) => /借方と貸方/.test(e)));
});

test('毎月の日：月末を超える日は月末にする。31は「毎月末日」', () => {
  assert.equal(dayInMonth('2026-02', 31), '2026-02-28');
  assert.equal(dayInMonth('2028-02', 30), '2028-02-29');
  assert.equal(dayInMonth('2026-04', 25), '2026-04-25');
  assert.equal(repeatLabel(31), '毎月末日');
  assert.equal(repeatLabel(5), '毎月5日');
});

test('繰り返し仕訳：その月に作成済みかを判定し、作った仕訳は貸借一致で正しい', () => {
  const b = makeBook('individual');
  const t = rentTemplate(b);
  const manual = createTemplate({ name: '手で使う', lines: t.lines });
  let status = recurringStatus({ templates: [t, manual], journals: [], month: '2026-03', period: b.period });
  assert.equal(status.length, 1);
  assert.equal(status[0].date, '2026-03-25');
  assert.equal(status[0].done, null);
  assert.equal(status[0].inPeriod, true);
  const j = journalFromTemplate(t, { periodId: b.period.id, date: status[0].date });
  assert.equal(j.source, TEMPLATE_SOURCE);
  assert.equal(j.sourceId, t.id);
  assert.deepEqual(validateJournal(j, { accounts: b.accounts, subAccounts: [], period: b.period }), []);
  status = recurringStatus({ templates: [t], journals: [{ ...j, no: 3 }], month: '2026-03', period: b.period });
  assert.equal(status[0].done.no, 3);
  // 別の月は未作成
  assert.equal(recurringStatus({ templates: [t], journals: [j], month: '2026-04', period: b.period })[0].done, null);
  assert.equal(templateAmount(t), 110000);
  assert.deepEqual(Object.keys(linesForTemplate(j.lines)[0]).sort(), ['accountId', 'amount', 'memo', 'side', 'subAccountId', 'taxCategory']);
});

async function setupRepo(idb = new IDBFactory()) {
  const repo = await openDB({ indexedDB: idb });
  const accounts = templateAccounts('individual').map((a) => createAccount(a));
  const period = createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト', entityType: 'individual' }), period, accounts });
  const byName = Object.fromEntries(accounts.map((a) => [a.name, a]));
  return { repo, accounts, byName, period };
}

test('リポジトリ：定型仕訳の保存・一覧・削除（tombstone）。使っている科目・補助科目は削除できない', async () => {
  const { repo, byName } = await setupRepo();
  const sub = await repo.saveSubAccount(createSubAccount({ accountId: byName['普通預金'].id, name: 'A銀行' }));
  const t = rentTemplate({ byName });
  t.lines[1].subAccountId = sub.id;
  await repo.saveTemplate(t);
  await assert.rejects(repo.saveTemplate({ ...t, id: 'x2', name: '' }), /名前/);
  assert.equal((await repo.listTemplates()).length, 1);
  await assert.rejects(repo.deleteSubAccount(sub.id), /定型仕訳/);
  const extra = await repo.saveAccount(createAccount({ code: '799', name: '自分の科目', group: 'sga', normalSide: 'debit' }));
  await repo.saveTemplate({ ...t, id: 'x3', name: '自分の科目', lines: [{ ...t.lines[0], accountId: extra.id }, t.lines[1]] });
  await assert.rejects(repo.deleteAccount(extra.id), /定型仕訳/);
  await repo.deleteTemplate('x3');
  await repo.deleteAccount(extra.id);
  const dump = await repo.dumpAll();
  assert.ok(dump.tombstones.some((x) => x.store === 'templates' && x.id === 'x3'));
  // バックアップに含まれ、読み戻せる
  const parsed = parseBackup(JSON.stringify(createBackup(dump)));
  assert.equal(parsed.templates.length, 1);
  repo.close();
});

test('バックアップ：バージョン3のファイルは定型仕訳を空にして読み込み、不正な定型仕訳は拒否する', async () => {
  const { repo, byName } = await setupRepo();
  const v4 = createBackup(await repo.dumpAll());
  const { templates: _omit, ...rest } = v4;
  assert.deepEqual(parseBackup(JSON.stringify({ ...rest, version: 3 })).templates, []);
  const broken = { ...v4, templates: [{ ...rentTemplate({ byName }), name: '' }] };
  assert.throws(() => parseBackup(JSON.stringify(broken)), /定型仕訳/);
  repo.close();
});

test('スキーマ移行：バージョン3のデータを残したまま定型仕訳のストアを追加する', async () => {
  const idb = new IDBFactory();
  await new Promise((resolve, reject) => {
    const open = idb.open(DB_NAME, 3);
    open.onupgradeneeded = () => {
      migrate(open.result, 0, open.transaction);
      open.result.deleteObjectStore('templates'); // バージョン3の構成にする
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
  assert.deepEqual(await repo.listTemplates(), []);
  repo.close();
});
