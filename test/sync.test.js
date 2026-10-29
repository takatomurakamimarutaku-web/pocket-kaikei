import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { mergeData, shareHistory, hasEntries, SyncError } from '../js/sync.js';
import { runSync } from '../js/sync-run.js';
import { openDB } from '../js/db.js';
import { templateAccounts } from '../js/accounts.js';
import { createAccount, createPeriod, createSettings, createJournal } from '../js/models.js';

const T = (n) => `2026-10-29T00:00:${String(n).padStart(2, '0')}.000Z`;

function base() {
  const accounts = templateAccounts('individual').map((a) => createAccount(a, new Date(T(0))));
  const period = createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31', nextJournalNo: 1 }, new Date(T(0)));
  const settings = createSettings({ businessName: 'テスト', entityType: 'individual' }, new Date(T(0)));
  const byName = Object.fromEntries(accounts.map((a) => [a.name, a]));
  const journal = (no, at, amount = 100, extra = {}) =>
    createJournal(
      {
        periodId: period.id,
        no,
        date: '2026-03-01',
        lines: [
          { side: 'debit', accountId: byName['現金'].id, subAccountId: null, amount, taxCategory: 'none', memo: '' },
          { side: 'credit', accountId: byName['売上高'].id, subAccountId: null, amount, taxCategory: 'none', memo: '' },
        ],
        ...extra,
      },
      new Date(at),
    );
  return { accounts, period, settings, byName, journal };
}
const book = (b, extra = {}) => ({ settings: b.settings, accounts: b.accounts, subAccounts: [], periods: [b.period], journals: [], tombstones: [], ...extra });

test('マージ：同じ id は更新日時が新しい方。片方だけのレコードは両方残す', () => {
  const b = base();
  const j1 = b.journal(1, T(1));
  const j1edited = { ...j1, lines: j1.lines.map((l) => ({ ...l, amount: 200 })), updatedAt: T(5) };
  const j2 = b.journal(2, T(2));
  const { data, changes } = mergeData(book(b, { journals: [j1edited] }), book(b, { journals: [j1, j2] }));
  assert.deepEqual(changes, []);
  assert.equal(data.journals.length, 2);
  assert.equal(data.journals.find((j) => j.id === j1.id).lines[0].amount, 200);
});

test('マージ：削除はより新しい編集が無ければ反映し、削除後に編集されたものは残す', () => {
  const b = base();
  const j1 = b.journal(1, T(1));
  const j2 = b.journal(2, T(2));
  const del = (id, at) => ({ id, store: 'journals', deletedAt: at, createdAt: at, updatedAt: at });
  // この端末で j1 を削除、ドライブ側では j2 を削除後より新しく編集
  const local = book(b, { journals: [j2], tombstones: [del(j1.id, T(3)), del(j2.id, T(3))] });
  const remote = book(b, { journals: [j1, { ...j2, updatedAt: T(4) }] });
  // 上の local は j2 を持ちつつ削除履歴もある不自然な形だが、新しい方を採る規則を確かめる
  const { data } = mergeData(local, remote);
  assert.deepEqual(data.journals.map((j) => j.id), [j2.id]);
  assert.deepEqual(data.tombstones.map((t) => t.id), [j1.id]);
});

test('マージ：2台で同じ番号の仕訳を作ったら、後に作った方を付け直し、次の番号も更新する', () => {
  const b = base();
  const a = b.journal(1, T(1));
  const c = b.journal(1, T(2), 300);
  const { data, changes } = mergeData(book(b, { journals: [a], periods: [{ ...b.period, nextJournalNo: 2 }] }), book(b, { journals: [c], periods: [{ ...b.period, nextJournalNo: 2 }] }), { now: T(9) });
  const nos = Object.fromEntries(data.journals.map((j) => [j.id, j.no]));
  assert.equal(nos[a.id], 1);
  assert.equal(nos[c.id], 2);
  assert.equal(data.journals.find((j) => j.id === c.id).updatedAt, T(9));
  assert.equal(data.periods[0].nextJournalNo, 3);
  assert.equal(changes.length, 1);
});

test('マージ：2台で同じコードの科目を追加したら、後の方を空いているコードに変える', () => {
  const b = base();
  const x = createAccount({ code: '650', name: '研修費', group: 'sga' }, new Date(T(1)));
  const y = createAccount({ code: '650', name: '支払保険料', group: 'sga' }, new Date(T(2)));
  const { data, changes } = mergeData(book(b, { accounts: [...b.accounts, x] }), book(b, { accounts: [...b.accounts, y] }), { now: T(9) });
  assert.equal(data.accounts.find((a) => a.id === x.id).code, '650');
  assert.equal(data.accounts.find((a) => a.id === y.id).code, '651');
  assert.equal(new Set(data.accounts.map((a) => a.code)).size, data.accounts.length);
  assert.match(changes[0], /支払保険料/);
});

test('マージ：個人/法人が違う、会計期間が重なる場合は止める', () => {
  const b = base();
  assert.throws(() => mergeData(book(b), book(b, { settings: { ...b.settings, entityType: 'corporation' } })), SyncError);
  const p2 = createPeriod({ startDate: '2027-01-01', endDate: '2027-12-31' });
  const p3 = createPeriod({ startDate: '2027-01-01', endDate: '2027-12-31' });
  assert.throws(() => mergeData(book(b, { periods: [b.period, p2] }), book(b, { periods: [b.period, p3] })), /重なって/);
});

test('shareHistory・hasEntries', () => {
  const b = base();
  const other = base();
  assert.equal(shareHistory(book(b), book(b)), true);
  assert.equal(shareHistory(book(b), book(other)), false);
  assert.equal(hasEntries(book(b)), false);
  assert.equal(hasEntries(book(b, { journals: [b.journal(1, T(1))] })), true);
});

// ---- 同期の手順（偽のドライブと2台の端末） ----

function fakeDrive() {
  const files = new Map();
  let clock = 0;
  const stamp = () => `2026-10-29T01:00:${String(++clock).padStart(2, '0')}.000Z`;
  return {
    files,
    async findFile() {
      const f = [...files.values()][0];
      return f ? { id: f.id, modifiedTime: f.modifiedTime } : null;
    },
    async getMeta(id) {
      const f = files.get(id);
      if (!f) throw Object.assign(new Error('not found'), { status: 404 });
      return { id, modifiedTime: f.modifiedTime };
    },
    async download(id) {
      return files.get(id).text;
    },
    async create(text) {
      const f = { id: `file-${files.size + 1}`, text, modifiedTime: stamp() };
      files.set(f.id, f);
      return { id: f.id, modifiedTime: f.modifiedTime };
    },
    async update(id, text) {
      const f = files.get(id);
      Object.assign(f, { text, modifiedTime: stamp() });
      return { id, modifiedTime: f.modifiedTime };
    },
  };
}

async function device() {
  return openDB({ indexedDB: new IDBFactory() });
}

async function setupBook(repo) {
  const accounts = templateAccounts('individual').map((a) => createAccount(a));
  const period = createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' });
  await repo.setup({ settings: createSettings({ businessName: 'むらかみ商店', entityType: 'individual' }), period, accounts });
  return { period, byName: Object.fromEntries(accounts.map((a) => [a.name, a])) };
}

const sale = (period, byName, amount, date = '2026-03-01') =>
  createJournal({
    periodId: period.id,
    date,
    lines: [
      { side: 'debit', accountId: byName['現金'].id, subAccountId: null, amount, taxCategory: 'none', memo: '' },
      { side: 'credit', accountId: byName['売上高'].id, subAccountId: null, amount, taxCategory: 'none', memo: '' },
    ],
  });

test('同期：1台目が書き出し、新しい2台目はドライブの内容を取り込み、両方の入力がそろう', async () => {
  const drive = fakeDrive();
  const a = await device();
  const { period, byName } = await setupBook(a);
  await a.saveJournal(sale(period, byName, 1000));
  assert.equal((await runSync({ db: a, drive })).result, 'uploaded');
  assert.ok(await a.getMeta('lastBackupAt'));

  // 2台目：初期設定だけ済ませた（入力なし）状態から同期 → ドライブの内容で置き換え
  const b = await device();
  await setupBook(b);
  assert.equal((await runSync({ db: b, drive })).result, 'replaced');
  assert.equal((await b.listJournals(period.id)).length, 1);
  assert.equal((await b.getCurrentPeriod()).id, period.id);

  // 両方で入力 → 順に同期すると、番号の重なりを直して3件そろう
  await a.saveJournal(sale(period, byName, 2000));
  await b.saveJournal(sale(period, byName, 3000));
  await runSync({ db: a, drive });
  const r = await runSync({ db: b, drive });
  assert.equal(r.result, 'merged');
  assert.equal(r.changes.length, 1);
  await runSync({ db: a, drive });
  for (const repo of [a, b]) {
    const js = await repo.listJournals(period.id);
    assert.deepEqual(js.map((j) => j.lines[0].amount).sort((x, y) => x - y), [1000, 2000, 3000]);
    assert.deepEqual(js.map((j) => j.no).sort(), [1, 2, 3]);
  }
  // 削除も伝わる
  const target = (await a.listJournals(period.id)).find((j) => j.lines[0].amount === 2000);
  await a.deleteJournal(target.id);
  await runSync({ db: a, drive });
  await runSync({ db: b, drive });
  assert.equal((await b.listJournals(period.id)).length, 2);
  // 次の仕訳番号は重ならない
  const next = await b.saveJournal(sale(period, byName, 10));
  assert.equal(next.no, 4);
  a.close();
  b.close();
});

test('同期：別々に始めた帳簿どうしは自動でマージせず、選んだ方で置き換える', async () => {
  const drive = fakeDrive();
  const a = await device();
  const pa = await setupBook(a);
  await a.saveJournal(sale(pa.period, pa.byName, 1000));
  await runSync({ db: a, drive });
  const b = await device();
  const pb = await setupBook(b);
  await b.saveJournal(sale(pb.period, pb.byName, 5000));
  assert.equal((await runSync({ db: b, drive })).result, 'needsChoice');
  // b のデータはそのまま
  assert.equal((await b.listJournals(pb.period.id))[0].lines[0].amount, 5000);
  assert.equal((await runSync({ db: b, drive, mode: 'useRemote' })).result, 'replaced');
  assert.equal((await b.listJournals(pa.period.id))[0].lines[0].amount, 1000);
  a.close();
  b.close();
});

test('同期：ドライブのファイルが壊れていたら何も書き換えない', async () => {
  const drive = fakeDrive();
  const a = await device();
  const { period, byName } = await setupBook(a);
  await a.saveJournal(sale(period, byName, 1000));
  await runSync({ db: a, drive });
  [...drive.files.values()][0].text = '{"format":"x"}';
  await assert.rejects(runSync({ db: a, drive }), SyncError);
  assert.equal((await a.listJournals(period.id)).length, 1);
  a.close();
});

test('同期：書き込む直前にほかの端末が更新していたら、読み直してマージする', async () => {
  const drive = fakeDrive();
  const a = await device();
  const { period, byName } = await setupBook(a);
  await runSync({ db: a, drive });
  const b = await device();
  await setupBook(b);
  await runSync({ db: b, drive });
  await a.saveJournal(sale(period, byName, 111));
  await b.saveJournal(sale(period, byName, 222));
  // a の同期の途中（getMeta の2回目）で b が先に書き込む
  let calls = 0;
  const racing = {
    ...drive,
    async getMeta(id) {
      calls++;
      if (calls === 2) await runSync({ db: b, drive });
      return drive.getMeta(id);
    },
  };
  assert.equal((await runSync({ db: a, drive: racing })).result, 'merged');
  assert.equal((await a.listJournals(period.id)).length, 2);
  a.close();
  b.close();
});
