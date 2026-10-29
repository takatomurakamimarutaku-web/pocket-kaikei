import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { parseVoucherNo, isVoucherNo, voucherOf, journalLabel, JOURNAL_ORDERS, validateJournal, MAX_VOUCHER_NO } from '../js/journal.js';
import { describeChange, searchJournals, hasCriteria } from '../js/journal-history.js';
import { generalLedger, subLedgers, NO_SUB } from '../js/ledger.js';
import { ledgerCsv } from '../js/csv.js';
import { yayoiRows } from '../js/yayoi.js';
import { detectFormat, parseEntries, buildImport } from '../js/journal-import.js';
import { parseCsv } from '../js/bank-import.js';
import { openDB, DB_NAME, DB_VERSION, migrate, ValidationError } from '../js/db.js';
import { createBackup, parseBackup, BACKUP_VERSION } from '../js/backup.js';
import { buildSample } from '../js/sample.js';
import { createSettings, createAccount, createPeriod, createJournal } from '../js/models.js';
import { templateAccounts } from '../js/accounts.js';
import { normalize } from '../js/search.js';
import { makeBook } from './helpers.js';

const BOM = '﻿';

test('伝票No の入力：全角数字・カンマも可、1〜9桁の整数だけ', () => {
  assert.deepEqual(parseVoucherNo('12'), { ok: true, value: 12 });
  assert.deepEqual(parseVoucherNo(' １２ '), { ok: true, value: 12 });
  assert.deepEqual(parseVoucherNo('1,234'), { ok: true, value: 1234 });
  assert.match(parseVoucherNo('').error, /入力/);
  assert.match(parseVoucherNo('A-1').error, /数字/);
  assert.match(parseVoucherNo('1.5').error, /数字/);
  assert.match(parseVoucherNo('0').error, /1〜/);
  assert.match(parseVoucherNo(String(MAX_VOUCHER_NO + 1)).error, /1〜/);
  assert.equal(isVoucherNo(MAX_VOUCHER_NO), true);
  assert.equal(isVoucherNo('3'), false);
  // 伝票No の無い古いデータは入力No
  assert.equal(voucherOf({ no: 5 }), 5);
  assert.equal(voucherOf({ no: 5, voucherNo: 9 }), 9);
  assert.equal(journalLabel({ no: 5, voucherNo: 9 }), '伝票No.9');
});

test('仕訳の検証：伝票No は省略可（保存のときに付ける）、付けるなら1以上の整数', () => {
  const b = makeBook('individual');
  const ctx = { accounts: b.accounts, subAccounts: [], period: b.period };
  const j = b.j('2026-02-01', [['現金', 1000]], [['売上高', 1000]]);
  assert.deepEqual(validateJournal(j, ctx), []);
  assert.deepEqual(validateJournal({ ...j, voucherNo: 3 }, ctx), []);
  for (const bad of [0, -1, 1.5, '3']) assert.match(validateJournal({ ...j, voucherNo: bad }, ctx)[0], /伝票No/);
});

test('仕訳帳の並び順：日付順（同じ日は伝票No）・入力順・伝票No順', () => {
  const list = [
    { id: 'a', no: 1, voucherNo: 30, date: '2026-03-01' },
    { id: 'b', no: 2, voucherNo: 10, date: '2026-03-05' },
    { id: 'c', no: 3, voucherNo: 20, date: '2026-03-01' },
    { id: 'd', no: 4, voucherNo: 10, date: '2026-02-01' },
    { id: 'e', no: 5, date: '2026-02-01' }, // 古いデータ（伝票No なし）は入力No
  ];
  const ids = (order) => [...list].sort(JOURNAL_ORDERS[order]).map((x) => x.id).join('');
  assert.equal(ids('date'), 'edcab');
  assert.equal(ids('input'), 'abcde');
  assert.equal(ids('voucher'), 'edbca');
});

test('詳しい検索：伝票No の範囲', () => {
  const b = makeBook('individual');
  const journals = [1, 5, 9].map((v, i) => ({ ...b.j(`2026-02-0${i + 1}`, [['現金', 100]], [['売上高', 100]]), voucherNo: v }));
  const ctx = { accountById: new Map(b.accounts.map((a) => [a.id, a])), subById: new Map(), normalize };
  assert.deepEqual(searchJournals(journals, { voucherFrom: 2, voucherTo: 9 }, ctx).map((j) => j.voucherNo), [5, 9]);
  assert.deepEqual(searchJournals(journals, { voucherTo: 1 }, ctx).map((j) => j.voucherNo), [1]);
  assert.equal(hasCriteria({ voucherFrom: 1 }), true);
  assert.equal(hasCriteria({ voucherFrom: null, voucherTo: null }), false);
});

async function setupRepo() {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('individual').map((a) => createAccount(a));
  const period = createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト商店', entityType: 'individual' }), period, accounts });
  const byName = Object.fromEntries(accounts.map((a) => [a.name, a]));
  const j = (date, amount, extra = {}) =>
    createJournal({
      periodId: period.id,
      date,
      lines: [
        { side: 'debit', accountId: byName['現金'].id, subAccountId: null, amount, taxCategory: 'none', memo: '' },
        { side: 'credit', accountId: byName['売上高'].id, subAccountId: null, amount, taxCategory: 'sales_10', memo: '' },
      ],
      ...extra,
    });
  return { repo, byName, period, j };
}

test('Repository：伝票No を自動で付け、書き換えた番号の次から続ける。同じ番号も可。訂正の履歴に残る', async () => {
  const { repo, period, j } = await setupRepo();
  const a = await repo.saveJournal(j('2026-01-05', 1000));
  const b = await repo.saveJournal(j('2026-01-06', 2000));
  assert.deepEqual([a.no, a.voucherNo, b.no, b.voucherNo], [1, 1, 2, 2]);
  // 自分で付けた番号（大きい番号）の次から続ける
  const c = await repo.saveJournal(j('2026-01-07', 3000, { voucherNo: 100 }));
  const d = await repo.saveJournal(j('2026-01-08', 4000));
  assert.deepEqual([c.no, c.voucherNo, d.no, d.voucherNo], [3, 100, 4, 101]);
  // 小さい番号・同じ番号も付けられる（紙の伝票に合わせる）
  const e = await repo.saveJournal(j('2026-01-09', 5000, { voucherNo: 2 }));
  assert.equal(e.voucherNo, 2);
  assert.equal((await repo.listPeriods()).find((p) => p.id === period.id).nextVoucherNo, 102);
  // 編集：伝票No を省くと元の番号のまま。書き換えると訂正の履歴に残る
  const a2 = await repo.saveJournal({ ...a, voucherNo: undefined, lines: a.lines.map((l) => ({ ...l, memo: '修正' })) });
  assert.equal(a2.voucherNo, 1);
  const a3 = await repo.saveJournal({ ...a2, voucherNo: 50 });
  assert.equal(a3.voucherNo, 50);
  assert.equal(a3.no, 1);
  const hist = (await repo.listJournalHistory(period.id)).filter((x) => x.journalId === a.id && x.action === 'update');
  const accountById = new Map((await repo.listAccounts()).map((x) => [x.id, x]));
  // 同じミリ秒に2回保存すると日時で並べられないので、伝票No を変えた訂正を選ぶ
  const last = hist.find((x) => x.after.voucherNo === 50);
  assert.equal(hist.length, 2);
  assert.ok(describeChange(last.before, last.after, { accountById, subById: new Map(), formatYen: String }).includes('伝票No 1 → 50'));
  // 不正な番号は保存しない
  await assert.rejects(repo.saveJournal(j('2026-01-10', 100, { voucherNo: 0 })), (err) => err instanceof ValidationError && /伝票No/.test(err.errors[0]));
  // バックアップ：伝票No を保ち、往復で同じ
  const backup = createBackup(await repo.dumpAll());
  assert.equal(backup.version, BACKUP_VERSION);
  const parsed = parseBackup(JSON.stringify(backup));
  assert.deepEqual(parsed.journals.map((x) => x.voucherNo).sort((x, y) => x - y), [2, 2, 50, 100, 101]);
  repo.close();
});

test('バックアップ（バージョン7まで）：伝票No が無ければ入力No を付け、期間に次の伝票No を入れる。不正な伝票No は拒否', async () => {
  const { repo, j } = await setupRepo();
  await repo.saveJournal(j('2026-01-05', 1000));
  await repo.saveJournal(j('2026-01-06', 2000));
  const backup = createBackup(await repo.dumpAll());
  const v7 = {
    ...backup,
    version: 7,
    journals: backup.journals.map(({ voucherNo: _v, ...x }) => x),
    periods: backup.periods.map(({ nextVoucherNo: _n, ...p }) => p),
  };
  const parsed = parseBackup(JSON.stringify(v7));
  assert.deepEqual(parsed.journals.map((x) => [x.no, x.voucherNo]).sort(), [[1, 1], [2, 2]]);
  assert.equal(parsed.periods[0].nextVoucherNo, 3);
  assert.throws(() => parseBackup(JSON.stringify({ ...backup, journals: backup.journals.map((x) => ({ ...x, voucherNo: 'A' })) })), /仕訳/);
  assert.throws(() => parseBackup(JSON.stringify({ ...backup, periods: backup.periods.map((p) => ({ ...p, nextVoucherNo: 0 })) })), /会計期間/);
  // 復元したあとも続きの番号を付ける
  await repo.replaceAll(parsed);
  const next = await repo.saveJournal(j('2026-01-07', 3000));
  assert.deepEqual([next.no, next.voucherNo], [3, 3]);
  repo.close();
});

test('スキーマ移行：バージョン7の仕訳に入力No と同じ伝票No を付け、期間に次の伝票No を入れる', async () => {
  const idb = new IDBFactory();
  await new Promise((resolve, reject) => {
    const open = idb.open(DB_NAME, 7);
    open.onupgradeneeded = () => {
      // バージョン7の構成（ストアは同じ。伝票No の無いデータを入れる）
      migrate(open.result, 0, open.transaction);
      open.result.deleteObjectStore('invoices'); // バージョン9で追加
      open.result.deleteObjectStore('employees'); // バージョン10で追加
      open.result.deleteObjectStore('payrolls');
      open.result.deleteObjectStore('yearEnds');
      open.transaction.objectStore('periods').put({ id: 'p1', startDate: '2026-01-01', endDate: '2026-12-31', openingBalances: [], nextJournalNo: 4, createdAt: 'x', updatedAt: 'x' });
      for (const no of [1, 2, 3]) open.transaction.objectStore('journals').put({ id: `j${no}`, periodId: 'p1', no, date: '2026-01-0' + no, lines: [], createdAt: 'x', updatedAt: 'x' });
    };
    open.onsuccess = () => {
      open.result.close();
      resolve();
    };
    open.onerror = () => reject(open.error);
  });
  const repo = await openDB({ indexedDB: idb });
  assert.equal(repo.db.version, DB_VERSION);
  assert.ok(DB_VERSION >= 8);
  const journals = await repo.listJournals('p1');
  assert.deepEqual(journals.map((x) => [x.no, x.voucherNo]).sort(), [[1, 1], [2, 2], [3, 3]]);
  assert.equal((await repo.listPeriods())[0].nextVoucherNo, 4);
  repo.close();
});

test('補助元帳：補助科目ごとの元帳と補助科目なしの元帳。合計は総勘定元帳と一致', () => {
  const b = makeBook('individual', { subs: [['売掛金', 'A社'], ['売掛金', 'B社'], ['売掛金', 'C社'], ['普通預金', 'みらい銀行']] });
  b.opening([['売掛金', 50000, 'A社'], ['売掛金', 20000], ['元入金', 70000]]);
  const journals = [
    b.j('2026-02-01', [['売掛金', 110000, undefined, 'A社']], [['売上高', 110000]], 'A社 2月分'),
    b.j('2026-02-10', [['売掛金', 33000, undefined, 'B社']], [['売上高', 33000]], 'B社 2月分'),
    b.j('2026-03-25', [['普通預金', 160000, undefined, 'みらい銀行']], [['売掛金', 160000, undefined, 'A社']], 'A社 入金'),
    b.j('2026-04-01', [['現金', 5000]], [['売掛金', 5000]], '補助なしの回収'),
  ];
  const ctx = { accountId: b.byName['売掛金'].id, accounts: b.accounts, subAccounts: b.subAccounts, period: b.period, journals };
  const list = subLedgers(ctx);
  assert.deepEqual(list.map((lg) => lg.subName), ['A社', 'B社', '補助科目なし']);
  const [a, bb, none] = list;
  assert.deepEqual([a.carried, a.debit, a.credit, a.closing], [50000, 110000, 160000, 0]);
  assert.deepEqual([bb.carried, bb.closing], [0, 33000]);
  assert.deepEqual([none.carried, none.credit, none.closing], [20000, 5000, 15000]);
  assert.equal(a.subAccount.name, 'A社');
  assert.equal(none.subAccount, null);
  const total = generalLedger(ctx);
  for (const k of ['carried', 'debit', 'credit', 'closing']) assert.equal(list.reduce((s, lg) => s + lg[k], 0), total[k], k);
  // 取引も残高もない補助科目（C社）は includeEmpty のときだけ
  assert.deepEqual(subLedgers({ ...ctx, includeEmpty: true }).map((lg) => lg.subName), ['A社', 'B社', 'C社', '補助科目なし']);
  // 範囲：3月から
  const fromMar = subLedgers({ ...ctx, from: '2026-03-01' });
  assert.equal(fromMar[0].carried, 160000);
  assert.equal(fromMar[0].rows.length, 1);
  // 補助科目なしだけの元帳
  assert.equal(generalLedger({ ...ctx, subAccountId: NO_SUB }).rows.length, 1);
  // CSV：補助科目の列に補助科目名、伝票No と入力No
  const lines = ledgerCsv(list, { carried: '前期繰越' }).slice(BOM.length).trim().split('\r\n');
  assert.equal(lines[0], 'コード,勘定科目,補助科目,日付,伝票No.,相手科目,摘要,借方,貸方,残高,入力No.');
  assert.ok(lines.some((l) => l.includes(',売掛金,B社,2026/02/10,2,売上高,B社 2月分,33000,,33000,2')));
  assert.ok(lines.some((l) => l.includes(',売掛金,補助科目なし,,,前期繰越,,,,20000,')));
});

test('弥生会計の形式・他社の CSV の取り込みで伝票No を受け渡す', () => {
  const b = makeBook('individual');
  const j = { ...b.j('2026-02-01', [['現金', 1100]], [['売上高', 1100]]), voucherNo: 77 };
  const [row] = yayoiRows([j], { accountById: new Map(b.accounts.map((a) => [a.id, a])), subById: new Map(), period: b.period });
  assert.equal(row[1], 77);
  const text = [
    '伝票番号,取引日,借方勘定科目,借方金額,貸方勘定科目,貸方金額,摘要',
    '15,2026/05/01,消耗品費,1100,現金,1100,紙',
    'A-3,2026/05/02,消耗品費,2200,現金,2200,英字入り',
  ].join('\n');
  const rows = parseCsv(text);
  const entries = parseEntries(rows, detectFormat(rows));
  const accountMap = new Map([['消耗品費', b.byName['消耗品費'].id], ['現金', b.byName['現金'].id]]);
  const built = buildImport(entries, { accountMap, taxMap: new Map(), subAccounts: [], accountById: new Map(b.accounts.map((a) => [a.id, a])) });
  assert.deepEqual(built.items.map((it) => it.voucherNo), [15, null]);
  const yayoi = parseCsv('2000,12,,2026/05/01,消耗品費,,,課対仕入込10%,1100,100,現金,,,対象外,1100,,紙,,,0,,,0,0,no');
  assert.equal(parseEntries(yayoi, detectFormat(yayoi))[0].voucherNo, 12);
});

test('サンプルデータ：入力No と伝票No を日付順に振る', () => {
  const data = buildSample('individual');
  assert.ok(data.journals.every((x) => x.voucherNo === x.no));
  assert.equal(data.periods[0].nextVoucherNo, data.journals.length + 1);
  assert.equal(parseBackup(JSON.stringify(createBackup(data))).journals.length, data.journals.length);
});
