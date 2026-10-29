import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from '../js/db.js';
import { createBackup, parseBackup, BackupError, backupFileName, shouldRemindBackup, BACKUP_VERSION } from '../js/backup.js';
import { templateAccounts } from '../js/accounts.js';
import { createAccount, createPeriod, createSettings, createSubAccount, createJournal } from '../js/models.js';

async function filled() {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('corporation').map((a) => createAccount(a));
  const period = createPeriod({ startDate: '2026-04-01', endDate: '2027-03-31' });
  await repo.setup({ settings: createSettings({ businessName: '株式会社テスト', entityType: 'corporation', taxStatus: 'taxable' }), period, accounts });
  const byName = Object.fromEntries(accounts.map((a) => [a.name, a]));
  const sub = await repo.saveSubAccount(createSubAccount({ accountId: byName['普通預金'].id, name: 'A銀行' }));
  await repo.saveOpeningBalances(period.id, [{ accountId: byName['普通預金'].id, subAccountId: sub.id, amount: 1000 }, { accountId: byName['資本金'].id, amount: 1000 }]);
  await repo.saveJournal(
    createJournal({
      periodId: period.id,
      date: '2026-04-10',
      lines: [
        { side: 'debit', accountId: byName['普通預金'].id, subAccountId: sub.id, amount: 1100, taxCategory: 'none', memo: '売上' },
        { side: 'credit', accountId: byName['売上高'].id, subAccountId: null, amount: 1100, taxCategory: 'sales_10', memo: '売上' },
      ],
    }),
  );
  return { repo, byName };
}

test('書き出し→検証→置き換えの往復でデータが一致する（端末IDはこの端末のまま）', async () => {
  const { repo } = await filled();
  const dump = await repo.dumpAll();
  const text = JSON.stringify(createBackup(dump, { appVersion: '0.1.0', exportedAt: new Date('2026-10-29T00:00:00Z') }));
  const parsed = parseBackup(text);
  assert.equal(parsed.journals.length, 1);
  const other = await openDB({ indexedDB: new IDBFactory() });
  await other.setMeta('deviceId', 'other-device');
  await other.replaceAll(parsed);
  const after = await other.dumpAll();
  assert.deepEqual(after.settings, dump.settings);
  assert.deepEqual(after.journals, dump.journals);
  assert.deepEqual(after.periods, dump.periods);
  assert.equal(after.accounts.length, dump.accounts.length);
  assert.equal(after.deviceId, 'other-device');
  repo.close();
  other.close();
});

test('不正なファイルは BackupError（貸借不一致・参照切れ・未来のバージョン・別アプリ）', async () => {
  const { repo } = await filled();
  const base = createBackup(await repo.dumpAll());
  const bad = (mutate, re) => {
    const obj = structuredClone(base);
    mutate(obj);
    assert.throws(() => parseBackup(JSON.stringify(obj)), (e) => e instanceof BackupError && re.test(e.message));
  };
  assert.throws(() => parseBackup('{'), BackupError);
  bad((o) => (o.format = 'craft-beer-log-backup'), /ポケット会計/);
  bad((o) => (o.version = BACKUP_VERSION + 1), /新しいバージョン/);
  bad((o) => (o.journals[0].lines[0].amount = 1000), /一致しません/);
  bad((o) => (o.journals[0].lines[0].amount = 1100.5), /仕訳/);
  bad((o) => (o.journals[0].lines[0].accountId = 'none'), /仕訳/);
  bad((o) => (o.subAccounts[0].accountId = 'none'), /補助科目/);
  bad((o) => (o.currentPeriodId = 'none'), /会計期間/);
  bad((o) => (o.accounts = o.accounts.filter((a) => a.role !== 'retained_earnings')), /必要な勘定科目/);
  bad((o) => o.accounts.push({ ...o.accounts[0], id: 'dup' }), /コードが重複/);
  bad((o) => (o.settings.entityType = 'x'), /設定/);
  bad((o) => (o.periods[0].openingBalances[0].amount = 900), /期首残高の借方と貸方/);
  repo.close();
});

test('検証に失敗したら既存のデータは変わらない', async () => {
  const { repo } = await filled();
  const before = await repo.dumpAll();
  assert.throws(() => parseBackup('{"format":"pocket-kaikei-backup","version":1}'));
  assert.deepEqual(await repo.dumpAll(), before);
  repo.close();
});

test('ファイル名とバックアップの催促', () => {
  assert.equal(backupFileName(new Date(2026, 9, 29, 9, 5)), 'pocket-kaikei-20261029-0905.json');
  const now = new Date('2026-10-29T00:00:00Z');
  assert.equal(shouldRemindBackup({ lastBackupAt: null, latestJournalUpdatedAt: null, now }), false);
  assert.equal(shouldRemindBackup({ lastBackupAt: null, latestJournalUpdatedAt: '2026-10-28T00:00:00Z', now }), true);
  assert.equal(shouldRemindBackup({ lastBackupAt: '2026-10-01T00:00:00Z', latestJournalUpdatedAt: '2026-09-30T00:00:00Z', now }), false);
  assert.equal(shouldRemindBackup({ lastBackupAt: '2026-10-20T00:00:00Z', latestJournalUpdatedAt: '2026-10-21T00:00:00Z', now }), false);
  assert.equal(shouldRemindBackup({ lastBackupAt: '2026-10-01T00:00:00Z', latestJournalUpdatedAt: '2026-10-21T00:00:00Z', now }), true);
});
