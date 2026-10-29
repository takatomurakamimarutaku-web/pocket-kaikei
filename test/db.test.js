import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { openDB, DB_VERSION, DB_NAME, ValidationError, migrate } from '../js/db.js';
import { templateAccounts, findByRole } from '../js/accounts.js';
import { createAccount, createPeriod, createSettings, createSubAccount, createJournal, createAsset } from '../js/models.js';

async function setupRepo(entityType = 'individual', period = { startDate: '2026-01-01', endDate: '2026-12-31' }) {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts(entityType).map((a) => createAccount(a));
  const p = createPeriod(period);
  await repo.setup({ settings: createSettings({ businessName: 'テスト商店', entityType }), period: p, accounts });
  const byName = Object.fromEntries(accounts.map((a) => [a.name, a]));
  const line = (side, name, amount, extra = {}) => ({ side, accountId: byName[name].id, subAccountId: null, amount, taxCategory: 'none', memo: '', ...extra });
  return { repo, accounts, byName, period: p, line };
}

test('スキーマ：ストアとインデックスが作成される', async () => {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  assert.equal(repo.db.name, DB_NAME);
  assert.equal(repo.db.version, DB_VERSION);
  assert.deepEqual([...repo.db.objectStoreNames].sort(), ['accounts', 'assets', 'journalHistory', 'journals', 'meta', 'periods', 'subAccounts', 'tombstones']);
  const tx = repo.db.transaction(['journals', 'accounts'], 'readonly');
  assert.deepEqual([...tx.objectStore('journals').indexNames].sort(), ['date', 'periodId']);
  assert.equal(tx.objectStore('accounts').index('code').unique, true);
  repo.close();
});

test('初期設定：設定・端末ID・期間・科目を登録し、2回目は拒否する', async () => {
  const { repo, accounts, period } = await setupRepo();
  assert.equal((await repo.getSettings()).businessName, 'テスト商店');
  assert.match(await repo.getMeta('deviceId'), /^[0-9a-f-]{36}$/);
  assert.equal((await repo.getCurrentPeriod()).id, period.id);
  assert.equal((await repo.listAccounts()).length, accounts.length);
  await assert.rejects(repo.setup({ settings: createSettings({ businessName: 'x' }), period: createPeriod(period), accounts: [] }), /済んでいます/);
  repo.close();
});

test('初期設定：事業者名なし・個人で暦年以外は拒否する', async () => {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  await assert.rejects(
    repo.setup({ settings: createSettings({ businessName: '', entityType: 'individual' }), period: createPeriod({ startDate: '2026-04-01', endDate: '2027-03-31' }), accounts: [] }),
    (e) => e instanceof ValidationError && Boolean(e.errors.businessName && e.errors.startDate),
  );
  assert.equal(await repo.getSettings(), null);
  repo.close();
});

test('設定の更新：個人/法人は変えられない', async () => {
  const { repo } = await setupRepo();
  const s = await repo.updateSettings({ taxStatus: 'taxable', businessName: '新しい名前' });
  assert.equal(s.taxStatus, 'taxable');
  await assert.rejects(repo.updateSettings({ entityType: 'corporation' }), /変更できません/);
  repo.close();
});

test('仕訳の保存：貸借不一致は保存されず、新規は通し番号を採番し、削除しても番号を詰めない', async () => {
  const { repo, period, line } = await setupRepo();
  const bad = createJournal({ periodId: period.id, date: '2026-01-05', lines: [line('debit', '消耗品費', 1000), line('credit', '現金', 900)] });
  await assert.rejects(repo.saveJournal(bad), /一致しません/);
  assert.equal((await repo.listJournals(period.id)).length, 0);
  const j1 = await repo.saveJournal(createJournal({ periodId: period.id, date: '2026-01-05', lines: [line('debit', '消耗品費', 1000), line('credit', '現金', 1000)] }));
  const j2 = await repo.saveJournal(createJournal({ periodId: period.id, date: '2026-01-06', lines: [line('debit', '通信費', 500), line('credit', '現金', 500)] }));
  assert.deepEqual([j1.no, j2.no], [1, 2]);
  const removed = await repo.deleteJournal(j2.id);
  assert.equal(removed.id, j2.id);
  const j3 = await repo.saveJournal(createJournal({ periodId: period.id, date: '2026-01-07', lines: [line('debit', '通信費', 500), line('credit', '現金', 500)] }));
  assert.equal(j3.no, 3);
  // 編集しても番号と作成日時は変わらない
  const edited = await repo.saveJournal({ ...j1, no: 99, date: '2026-01-08' });
  assert.equal(edited.no, 1);
  assert.equal(edited.createdAt, j1.createdAt);
  repo.close();
});

test('仕訳の削除は tombstone を残し、元に戻すと tombstone を消す', async () => {
  const { repo, period, line } = await setupRepo();
  const j = await repo.saveJournal(createJournal({ periodId: period.id, date: '2026-02-01', lines: [line('debit', '現金', 100), line('credit', '売上高', 100)] }));
  const snap = await repo.deleteJournal(j.id);
  let dump = await repo.dumpAll();
  assert.deepEqual(dump.tombstones.map((t) => [t.id, t.store]), [[j.id, 'journals']]);
  assert.ok(dump.tombstones[0].deletedAt);
  await repo.restoreJournal(snap);
  dump = await repo.dumpAll();
  assert.equal(dump.journals.length, 1);
  assert.equal(dump.tombstones.length, 0);
  repo.close();
});

test('期首残高：個人は元入金を自動計算し、手入力の元入金は無視する。PL科目は拒否する', async () => {
  const { repo, period, byName } = await setupRepo();
  const saved = await repo.saveOpeningBalances(period.id, [
    { accountId: byName['現金'].id, amount: 50000 },
    { accountId: byName['普通預金'].id, amount: 450000 },
    { accountId: byName['買掛金'].id, amount: 100000 },
    { accountId: byName['元入金'].id, amount: 1 },
    { accountId: byName['売掛金'].id, amount: 0 },
  ]);
  const capital = saved.openingBalances.find((b) => b.accountId === byName['元入金'].id);
  assert.equal(capital.amount, 400000);
  assert.equal(saved.openingBalances.length, 4, '0円の行は保存しない');
  await assert.rejects(repo.saveOpeningBalances(period.id, [{ accountId: byName['売上高'].id, amount: 100 }]), /損益の科目/);
  await assert.rejects(repo.saveOpeningBalances(period.id, [{ accountId: byName['現金'].id, amount: 1.5 }]), /整数/);
  repo.close();
});

test('科目：追加・コード重複の拒否・使用中の科目は区分を変えられず削除もできない・役割科目は無効化不可', async () => {
  const { repo, period, line, accounts } = await setupRepo('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  const added = await repo.saveAccount(createAccount({ code: '630', name: 'サブスク費', group: 'sga', normalSide: 'debit', defaultTaxCategory: 'purchase_10' }));
  await assert.rejects(repo.saveAccount(createAccount({ code: '630', name: '重複', group: 'sga', normalSide: 'debit' })), /使われています/);
  const cash = accounts.find((a) => a.role === 'cash');
  await repo.saveJournal(createJournal({ periodId: period.id, date: '2026-04-02', lines: [{ ...line('debit', '現金', 1000), accountId: added.id }, line('credit', '現金', 1000)] }));
  await assert.rejects(repo.saveAccount({ ...added, group: 'cost_of_sales' }), /使用中/);
  await assert.rejects(repo.deleteAccount(added.id), /使われている/);
  await repo.saveAccount({ ...added, name: 'サブスクリプション費', active: false });
  assert.equal((await repo.getAccount(added.id)).active, false);
  await assert.rejects(repo.saveAccount({ ...cash, active: false }), /無効にできません/);
  await assert.rejects(repo.deleteAccount(cash.id), /テンプレート/);
  const unused = await repo.saveAccount(createAccount({ code: '631', name: '未使用', group: 'sga', normalSide: 'debit' }));
  await repo.deleteAccount(unused.id);
  assert.equal(await repo.getAccount(unused.id), undefined);
  assert.ok((await repo.dumpAll()).tombstones.some((t) => t.id === unused.id));
  // 役割は保存時に書き換えられない
  const re = findByRole(accounts, 'retained_earnings');
  const saved = await repo.saveAccount({ ...re, role: null, name: '繰越利益' });
  assert.equal(saved.role, 'retained_earnings');
  repo.close();
});

test('補助科目：同名の拒否、使用中は削除不可', async () => {
  const { repo, period, line, byName } = await setupRepo();
  const sub = await repo.saveSubAccount(createSubAccount({ accountId: byName['普通預金'].id, name: 'A銀行' }));
  await assert.rejects(repo.saveSubAccount(createSubAccount({ accountId: byName['普通預金'].id, name: 'A銀行' })), /同じ名前/);
  await repo.saveJournal(createJournal({ periodId: period.id, date: '2026-03-01', lines: [line('debit', '普通預金', 100, { subAccountId: sub.id }), line('credit', '売上高', 100)] }));
  await assert.rejects(repo.deleteSubAccount(sub.id), /使われている/);
  repo.close();
});

test('期間の変更：期間外になる仕訳があれば拒否する', async () => {
  const { repo, period, line } = await setupRepo('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  await repo.saveJournal(createJournal({ periodId: period.id, date: '2027-03-01', lines: [line('debit', '現金', 100), line('credit', '売上高', 100)] }));
  await assert.rejects(repo.savePeriodDates(period.id, { startDate: '2026-04-01', endDate: '2027-02-28' }), /1件/);
  const next = await repo.savePeriodDates(period.id, { startDate: '2026-03-01', endDate: '2027-02-28' }).catch((e) => e);
  assert.ok(next instanceof Error);
  repo.close();
});

test('期首残高：法人は借方と貸方が一致しないと保存しない', async () => {
  const { repo, period, byName } = await setupRepo('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  await assert.rejects(
    repo.saveOpeningBalances(period.id, [{ accountId: byName['現金'].id, amount: 1000 }, { accountId: byName['資本金'].id, amount: 900 }]),
    /一致しません（差額 100円）/,
  );
  assert.deepEqual((await repo.getCurrentPeriod()).openingBalances, []);
  const saved = await repo.saveOpeningBalances(period.id, [
    { accountId: byName['現金'].id, amount: 1000 },
    { accountId: byName['減価償却累計額'].id, amount: 100 },
    { accountId: byName['建物'].id, amount: 100 },
    { accountId: byName['資本金'].id, amount: 1000 },
  ]);
  assert.equal(saved.openingBalances.length, 4, '評価勘定は貸方側として一致を判定する');
  repo.close();
});

test('目印：初期設定で付き、科目の保存で消えず、目印の導入前のデータには起動時に補う', async () => {
  const { repo, byName } = await setupRepo('corporation');
  assert.equal((await repo.getAccount(byName['売掛金'].id)).hint, 'receivable');
  // 画面から hint を渡さなくても、保存前の目印を残す
  const { hint, ...rest } = await repo.getAccount(byName['売掛金'].id);
  assert.equal(hint, 'receivable');
  await repo.saveAccount({ ...rest, name: '売掛金（得意先）' });
  assert.equal((await repo.getAccount(byName['売掛金'].id)).hint, 'receivable');
  assert.equal(await repo.fillAccountHints(), 0);

  // 目印の導入前（hint プロパティ無し）の状態を作る
  const tx = repo.db.transaction('accounts', 'readwrite');
  for (const a of await new Promise((r) => (tx.objectStore('accounts').getAll().onsuccess = (e) => r(e.target.result)))) {
    delete a.hint;
    tx.objectStore('accounts').put(a);
  }
  await new Promise((r) => (tx.oncomplete = r));
  assert.ok((await repo.fillAccountHints()) > 0);
  assert.equal((await repo.getAccount(byName['役員借入金'].id)).hint, 'officer_loan');
  assert.equal(await repo.fillAccountHints(), 0);
  repo.close();
});

test('目印：目印の導入前のバックアップを復元すると、テンプレートの科目に目印を補う', async () => {
  const { repo, byName } = await setupRepo('individual');
  const data = await repo.dumpAll();
  data.accounts = data.accounts.map(({ hint, ...a }) => a);
  await repo.replaceAll(data);
  assert.equal((await repo.getAccount(byName['仕入高'].id)).hint, 'purchases');
  repo.close();
});

test('スキーマ移行：バージョン1のデータを残したまま固定資産のストアを追加する', async () => {
  const idb = new IDBFactory();
  await new Promise((resolve, reject) => {
    const open = idb.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      migrate(open.result, 0, open.transaction);
      open.result.deleteObjectStore('assets'); // バージョン1の構成にする
      open.result.deleteObjectStore('journalHistory');
      open.transaction.objectStore('meta').put({ key: 'settings', value: { businessName: '旧データ' } });
    };
    open.onsuccess = () => {
      open.result.close();
      resolve();
    };
    open.onerror = () => reject(open.error);
  });
  const repo = await openDB({ indexedDB: idb });
  assert.equal(repo.db.version, DB_VERSION);
  assert.ok(repo.db.objectStoreNames.contains('assets'));
  assert.ok(repo.db.objectStoreNames.contains('journalHistory'));
  assert.equal((await repo.getSettings()).businessName, '旧データ');
  assert.deepEqual(await repo.listAssets(), []);
  repo.close();
});

test('固定資産：検証して保存、法人は事業割合100%、削除は tombstone、使っている科目は削除できない', async () => {
  const { repo, byName } = await setupRepo('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  const a = createAsset({ name: ' 複合機 ', accountId: byName['工具器具備品'].id, acquiredOn: '2026-05-01', startedOn: '2026-05-10', cost: 600000, usefulLife: 5, businessRatio: 50 });
  const saved = await repo.saveAsset(a);
  assert.equal(saved.name, '複合機');
  assert.equal(saved.businessRatio, 100);
  await assert.rejects(repo.saveAsset({ ...a, cost: 0 }), (e) => e instanceof ValidationError && Boolean(e.errors.cost));
  const custom = createAccount({ code: '207', name: '器具', group: 'tangible_fixed_assets' });
  await repo.saveAccount(custom);
  await repo.saveAsset({ ...a, accountId: custom.id });
  await assert.rejects(repo.deleteAccount(custom.id), /固定資産台帳/);
  await repo.deleteAsset(a.id);
  assert.deepEqual(await repo.listAssets(), []);
  const dump = await repo.dumpAll();
  assert.ok(dump.tombstones.some((t) => t.store === 'assets' && t.id === a.id));
  repo.close();
});

test('振り分けルール：設定に保存し、不正なルールは保存しない', async () => {
  const { repo, byName } = await setupRepo();
  const rule = { keyword: ' NTT ', direction: 'out', accountId: byName['通信費'].id, subAccountId: null, taxCategory: 'purchase_10' };
  const saved = await repo.saveBankRules([rule]);
  assert.equal(saved.bankRules.length, 1);
  assert.equal(saved.bankRules[0].keyword, 'NTT');
  assert.ok(saved.bankRules[0].id);
  assert.deepEqual((await repo.getSettings()).bankRules, saved.bankRules);
  await assert.rejects(repo.saveBankRules([rule, { ...rule, accountId: byName['現金'].id }]), (e) => e instanceof ValidationError && /2件目/.test(e.errors[0]));
  assert.equal((await repo.getSettings()).bankRules.length, 1);
});

test('消費税の申告設定：按分の方法を保存し（省略は一括比例配分方式）、不正な値は拒否する', async () => {
  const { repo, period } = await setupRepo();
  const base = { method: 'general', businessType: 5, interimNational: 0, interimLocal: 0 };
  assert.equal((await repo.saveTaxReturnSettings(period.id, base)).taxReturn.allocation, 'proportional');
  assert.equal((await repo.saveTaxReturnSettings(period.id, { ...base, allocation: 'individual' })).taxReturn.allocation, 'individual');
  await assert.rejects(repo.saveTaxReturnSettings(period.id, { ...base, allocation: 'x' }), ValidationError);
  // 仕入の用途区分を使う設定
  assert.equal((await repo.updateSettings({ taxUseSplit: true })).taxUseSplit, true);
  repo.close();
});

test('固定資産の売却：資産と仕訳を一緒に保存し、取り消すと仕訳を削除（tombstone）して項目を空にする', async () => {
  const { repo, byName, period, line } = await setupRepo();
  const a = await repo.saveAsset(createAsset({ name: '車', category: 'vehicle', accountId: byName['車両運搬具'].id, acquiredOn: '2026-01-01', startedOn: '2026-01-01', cost: 300000, usefulLife: 4 }));
  const journal = createJournal({ periodId: period.id, date: '2026-06-30', lines: [line('debit', '普通預金', 110000), line('credit', '車両運搬具', 110000, { taxCategory: 'sales_10' })] });
  const { asset, journal: j } = await repo.disposeAsset({ ...a, disposedOn: '2026-06-30', disposalType: 'sell', salePrice: 110000 }, journal);
  assert.equal(asset.disposalType, 'sell');
  assert.equal(j.source, 'asset_disposal');
  assert.equal(j.sourceId, a.id);
  assert.equal(j.no, 1);
  // 不正な仕訳なら資産も保存しない
  await assert.rejects(repo.disposeAsset({ ...a, disposedOn: '2026-07-31', disposalType: 'retire' }, { ...journal, id: 'x', lines: [line('debit', '雑費', 100)] }), ValidationError);
  assert.equal((await repo.getAsset(a.id)).disposedOn, '2026-06-30');
  const undone = await repo.undoDisposal(a.id);
  assert.deepEqual([undone.disposedOn, undone.disposalType, undone.salePrice], [null, null, null]);
  assert.equal(await repo.getJournal(j.id), undefined);
  assert.ok((await repo.dumpAll()).tombstones.some((t) => t.store === 'journals' && t.id === j.id));
  repo.close();
});
