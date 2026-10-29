import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { dueDate, validatePaymentTerms, termsLabel, partyBalances, schedule, agingCsv, bucketOf, partyAccounts } from '../js/receivables.js';
import { daysBetween } from '../js/period.js';
import { buildSample } from '../js/sample.js';
import { closingRows } from '../js/statements.js';
import { createBackup, parseBackup, BackupError } from '../js/backup.js';
import { openDB, ValidationError } from '../js/db.js';
import { createSettings, createAccount, createPeriod, createSubAccount } from '../js/models.js';
import { templateAccounts } from '../js/accounts.js';
import { makeBook } from './helpers.js';

const END = { closingDay: 31, months: 1, payDay: 31 };

test('日数：from から to までの日数', () => {
  assert.equal(daysBetween('2026-01-10', '2026-04-15'), 95);
  assert.equal(daysBetween('2026-03-01', '2026-02-28'), -1);
  assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2); // うるう年
});

test('入金予定日：締め日までの発生はその月の締め、過ぎたら翌月。支払日は月末を超えたら月末', () => {
  assert.equal(dueDate('2026-01-05', END), '2026-02-28');
  assert.equal(dueDate('2026-01-31', END), '2026-02-28');
  assert.equal(dueDate('2026-02-28', END), '2026-03-31');
  const t20 = { closingDay: 20, months: 1, payDay: 10 };
  assert.equal(dueDate('2026-01-20', t20), '2026-02-10');
  assert.equal(dueDate('2026-01-21', t20), '2026-03-10');
  // 20日締め 当月末日払い
  assert.equal(dueDate('2026-01-15', { closingDay: 20, months: 0, payDay: 31 }), '2026-01-31');
  assert.equal(dueDate('2026-01-25', { closingDay: 20, months: 0, payDay: 31 }), '2026-02-28');
  // 年をまたぐ・翌々月
  assert.equal(dueDate('2026-12-10', { closingDay: 31, months: 2, payDay: 5 }), '2027-02-05');
  // 30日締めは2月なら末日で締める
  assert.equal(dueDate('2026-02-28', { closingDay: 30, months: 1, payDay: 30 }), '2026-03-30');
  assert.equal(dueDate('2026-01-05', null), null);
});

test('支払条件の検証と表示', () => {
  assert.equal(validatePaymentTerms(null), null);
  assert.equal(validatePaymentTerms(undefined), null);
  assert.equal(validatePaymentTerms(END), null);
  assert.equal(validatePaymentTerms({ closingDay: 20, months: 0, payDay: 31 }), null);
  assert.match(validatePaymentTerms({ closingDay: 20, months: 0, payDay: 10 }), /締め日より後/);
  assert.match(validatePaymentTerms({ closingDay: 0, months: 1, payDay: 31 }), /正しくありません/);
  assert.match(validatePaymentTerms({ closingDay: 31, months: 1.5, payDay: 31 }), /正しくありません/);
  assert.match(validatePaymentTerms('末締め'), /正しくありません/);
  assert.equal(termsLabel(END), '末日締め 翌月末日払い');
  assert.equal(termsLabel({ closingDay: 20, months: 0, payDay: 31 }), '20日締め 当月末日払い');
  assert.equal(termsLabel({ closingDay: 15, months: 2, payDay: 10 }), '15日締め 翌々月10日払い');
});

test('年齢表の区分：30・60・90・180日で区切る', () => {
  assert.equal(bucketOf(0), 'd30');
  assert.equal(bucketOf(30), 'd30');
  assert.equal(bucketOf(31), 'd60');
  assert.equal(bucketOf(90), 'd90');
  assert.equal(bucketOf(91), 'd180');
  assert.equal(bucketOf(181), 'over');
});

function arBook() {
  const b = makeBook('individual', { subs: [['売掛金', 'A社'], ['売掛金', 'B社'], ['買掛金', 'C商事']] });
  b.subAccounts[0].paymentTerms = END;
  const sub = (name) => b.subAccounts.find((s) => s.name === name).id;
  b.period.openingBalances = [
    { accountId: b.byName['売掛金'].id, subAccountId: sub('A社'), amount: 100000 },
    { accountId: b.byName['買掛金'].id, subAccountId: sub('C商事'), amount: 40000 },
  ];
  b.journals = [
    b.j('2026-01-10', [['売掛金', 50000, null, 'A社']], [['売上高', 50000]], '1月分'),
    b.j('2026-02-10', [['売掛金', 70000, null, 'A社']], [['売上高', 70000]], '2月分'),
    b.j('2026-02-28', [['普通預金', 120000]], [['売掛金', 120000, null, 'A社']], 'A社 入金'),
    b.j('2026-03-05', [['普通預金', 5000]], [['売掛金', 5000, null, 'B社']], 'B社 前受け'),
    b.j('2026-03-20', [['売掛金', 8000, null, 'B社']], [['売上高', 8000]], 'B社 売上'),
    b.j('2026-03-25', [['売掛金', 2000]], [['売上高', 2000]], '補助なし'),
    b.j('2026-02-15', [['仕入高', 30000]], [['買掛金', 30000, null, 'C商事']], '仕入'),
    b.j('2026-03-31', [['買掛金', 50000, null, 'C商事']], [['普通預金', 50000]], 'C商事 支払'),
    b.j('2026-05-10', [['普通預金', 30000]], [['売掛金', 30000, null, 'A社']], '基準日より後'),
  ];
  return b;
}

test('取引先ごとの残高：入金は古い発生から消し込む（先入先出）。過入金は次の発生に充てる', () => {
  const b = arBook();
  const r = partyBalances('receivable', { ...b, asOf: '2026-04-15' });
  const a = r.parties.find((p) => p.name === 'A社');
  // 期首 100,000 と 1月分のうち 20,000 を消し込む
  assert.equal(a.opening, 100000);
  assert.equal(a.increase, 120000);
  assert.equal(a.decrease, 120000);
  assert.equal(a.balance, 100000);
  assert.deepEqual(a.open.map((it) => [it.date, it.amount, it.remaining]), [['2026-01-10', 50000, 30000], ['2026-02-10', 70000, 70000]]);
  // 支払条件（末締め翌月末）から予定日・超過日数。発生から91日以上は滞留
  assert.deepEqual(a.open.map((it) => [it.dueDate, it.overdueDays, it.days, it.bucket, it.stale]), [['2026-02-28', 46, 95, 'd180', true], ['2026-03-31', 15, 64, 'd90', false]]);
  assert.equal(a.overdue, 100000);
  assert.equal(a.stale, 30000);
  assert.equal(a.nextDue, null);
  // 過入金 5,000 は次の売上 8,000 に充てる
  const bsha = r.parties.find((p) => p.name === 'B社');
  assert.equal(bsha.balance, 3000);
  assert.equal(bsha.overpaid, 0);
  assert.deepEqual(bsha.open.map((it) => [it.amount, it.remaining, it.dueDate]), [[8000, 3000, null]]);
  // 補助科目のない明細は1つにまとめる
  const none = r.parties.find((p) => p.subAccountId === null);
  assert.equal(none.name, '（補助科目なし）');
  assert.equal(none.balance, 2000);
  // 合計：残高の順に並ぶ。支払条件のない取引先の数
  assert.deepEqual(r.parties.map((p) => p.name), ['A社', 'B社', '（補助科目なし）']);
  assert.equal(r.totals.balance, 105000);
  assert.equal(r.totals.overdue, 100000);
  assert.equal(r.totals.noTerms, 2);
  assert.deepEqual(r.totals.buckets, { d30: 5000, d60: 0, d90: 70000, d180: 30000, over: 0 });
  // 基準日より後の入金を含めると残りが減る
  const later = partyBalances('receivable', { ...b, asOf: '2026-05-31' }).parties.find((p) => p.name === 'A社');
  assert.equal(later.balance, 70000);
  assert.deepEqual(later.open.map((it) => it.remaining), [70000]);
});

test('過入金のまま：残高はマイナス、消し込む発生はない', () => {
  const b = arBook();
  const r = partyBalances('receivable', { ...b, asOf: '2026-03-10' });
  const p = r.parties.find((x) => x.name === 'B社');
  assert.equal(p.balance, -5000);
  assert.equal(p.overpaid, 5000);
  assert.deepEqual(p.open, []);
  assert.equal(r.totals.overpaid, 5000);
});

test('買掛金：貸方が発生、借方が支払。期首残高から消し込む', () => {
  const b = arBook();
  const r = partyBalances('payable', { ...b, asOf: '2026-04-15' });
  assert.equal(r.parties.length, 1);
  const c = r.parties[0];
  assert.equal(c.name, 'C商事');
  assert.equal(c.balance, 20000);
  assert.deepEqual(c.open.map((it) => [it.date, it.remaining]), [['2026-02-15', 20000]]);
  assert.deepEqual(c.payments.map((x) => [x.date, x.amount, x.memo]), [['2026-03-31', 50000, 'C商事 支払']]);
});

test('前期からの繰越は期首の前日の発生として数え、支払条件で予定日を出す', () => {
  const b = arBook();
  const r = partyBalances('receivable', { ...b, asOf: '2026-01-20' });
  const a = r.parties.find((p) => p.name === 'A社');
  assert.deepEqual(a.open.map((it) => [it.date, it.opening, it.dueDate, it.remaining]), [['2025-12-31', true, '2026-01-31', 100000], ['2026-01-10', false, '2026-02-28', 50000]]);
  assert.equal(a.nextDue, '2026-01-31');
});

test('予定の一覧：予定日ごとの合計と、期日を過ぎたもの', () => {
  const b = arBook();
  const r = partyBalances('receivable', { ...b, asOf: '2026-03-15' });
  const s = schedule(r);
  assert.equal(s.overdue.amount, 30000);
  assert.deepEqual(s.overdue.items.map((it) => [it.party.name, it.dueDate]), [['A社', '2026-02-28']]);
  assert.deepEqual(s.days.map((d) => [d.date, d.amount]), [['2026-03-31', 70000]]);
});

test('年齢表の CSV：見出し・取引先ごとの行・合計（マイナスは -1000）', () => {
  const b = arBook();
  const csv = agingCsv(partyBalances('receivable', { ...b, asOf: '2026-03-10' }));
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], '売掛金の年齢表（基準日 2026/03/10）');
  assert.equal(lines[1], '得意先,科目,残高,30日以内,31〜60日,61〜90日,91〜180日,181日以上,期日超過,過入金,支払条件,次の入金予定日');
  assert.equal(lines[2], 'A社,売掛金,100000,70000,30000,0,0,0,30000,0,末日締め 翌月末日払い,2026/03/31');
  assert.equal(lines[3], 'B社,売掛金,-5000,0,0,0,0,0,0,5000,,');
  assert.equal(lines.at(-1), '合計,,95000,70000,30000,0,0,0,30000,5000,,');
});

test('サンプル：取引先ごとの残高の合計は試算表の残高と同じ。残りの合計−過入金＝残高', () => {
  for (const entity of ['individual', 'corporation']) {
    const s = buildSample(entity);
    const period = s.periods[0];
    const rows = closingRows({ accounts: s.accounts, period, journals: s.journals });
    for (const kind of ['receivable', 'payable']) {
      const r = partyBalances(kind, { accounts: s.accounts, subAccounts: s.subAccounts, journals: s.journals, period, asOf: period.endDate });
      const ids = new Set(partyAccounts(kind, s.accounts).map((a) => a.id));
      const closing = rows.filter((x) => ids.has(x.account.id)).reduce((t, x) => t + x.closing, 0);
      assert.equal(r.totals.balance, closing, `${entity} ${kind}`);
      for (const p of r.parties) assert.equal(p.open.reduce((t, it) => t + it.remaining, 0) - p.overpaid, p.balance, `${entity} ${p.name}`);
    }
  }
});

test('支払条件の保存：補助科目に持たせ、誤りは保存しない。バックアップでも検証する', async () => {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('individual').map((a) => createAccount(a));
  const period = createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト', entityType: 'individual' }), period, accounts });
  const ar = accounts.find((a) => a.hint === 'receivable');
  const sub = await repo.saveSubAccount(createSubAccount({ accountId: ar.id, name: 'A社' }));
  const saved = await repo.saveSubAccount({ ...sub, paymentTerms: { closingDay: 20, months: 1, payDay: 10 } });
  assert.deepEqual(saved.paymentTerms, { closingDay: 20, months: 1, payDay: 10 });
  await assert.rejects(repo.saveSubAccount({ ...saved, paymentTerms: { closingDay: 20, months: 0, payDay: 10 } }), (e) => e instanceof ValidationError && /締め日より後/.test(e.errors.paymentTerms));
  assert.deepEqual((await repo.listSubAccounts())[0].paymentTerms, { closingDay: 20, months: 1, payDay: 10 });
  // 外す
  assert.equal((await repo.saveSubAccount({ ...saved, paymentTerms: null })).paymentTerms, null);
  repo.close();

  // バックアップ：サンプルの支払条件はそのまま、壊れた支払条件は読み込まない
  const data = buildSample('individual');
  const json = JSON.stringify(createBackup(data, { appVersion: 'test' }));
  const back = parseBackup(json);
  assert.deepEqual(back.subAccounts.find((s) => s.name === 'A社').paymentTerms, { closingDay: 31, months: 1, payDay: 25 });
  const broken = JSON.parse(json);
  broken.subAccounts.find((s) => s.name === 'A社').paymentTerms = { closingDay: 99, months: 1, payDay: 25 };
  assert.throws(() => parseBackup(JSON.stringify(broken)), BackupError);
});
