import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  decodeBytes,
  parseCsv,
  parseDate,
  parseAmount,
  detectColumns,
  extractTransactions,
  balanceMismatches,
  buildCounterIndex,
  suggestCounter,
  markDuplicates,
  importLines,
  headerSignature,
  validateRule,
  matchRule,
} from '../js/bank-import.js';
import { makeBook } from './helpers.js';
import { openDB, ValidationError } from '../js/db.js';
import { templateAccounts } from '../js/accounts.js';
import { createAccount, createPeriod, createSettings, createJournal } from '../js/models.js';
import { validateJournal } from '../js/journal.js';

// Shift_JIS のバイト列（「日付,摘要」+ 改行）。Node の TextEncoder は UTF-8 だけなので直接書く
const SJIS_HEADER = new Uint8Array([0x93, 0xfa, 0x95, 0x74, 0x2c, 0x93, 0x45, 0x97, 0x76, 0x0d, 0x0a]);

test('文字コード：UTF-8（BOMあり・なし）と Shift_JIS を判定する', () => {
  assert.deepEqual(decodeBytes(new TextEncoder().encode('日付,摘要')), { text: '日付,摘要', encoding: 'utf-8' });
  assert.equal(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('日付')])).text, '日付');
  const sjis = decodeBytes(SJIS_HEADER);
  assert.equal(sjis.encoding, 'shift_jis');
  assert.equal(sjis.text, '日付,摘要\r\n');
});

test('CSVの分解：クォート・セル内のカンマと改行・空行・タブ区切り', () => {
  assert.deepEqual(parseCsv('a,"b,c","d""e"\r\n\r\n"f\ng",h\n'), [['a', 'b,c', 'd"e'], ['f\ng', 'h']]);
  assert.deepEqual(parseCsv('日付\t金額\n2026/4/1\t1,000'), [['日付', '金額'], ['2026/4/1', '1,000']]);
  assert.deepEqual(parseCsv('﻿a,b'), [['a', 'b']]);
});

test('日付：よくある書き方と和暦、存在しない日は null', () => {
  assert.equal(parseDate('2026/4/1'), '2026-04-01');
  assert.equal(parseDate('2026-04-01 10:23'), '2026-04-01');
  assert.equal(parseDate('20260401'), '2026-04-01');
  assert.equal(parseDate('2026年4月1日'), '2026-04-01');
  assert.equal(parseDate('令和8年4月1日'), '2026-04-01');
  assert.equal(parseDate('R8.4.1'), '2026-04-01');
  assert.equal(parseDate('令和元年5月1日'), '2019-05-01');
  assert.equal(parseDate('H31.4.30'), '2019-04-30');
  assert.equal(parseDate('２０２６／０４／０１'), '2026-04-01');
  assert.equal(parseDate('2026/2/30'), null);
  assert.equal(parseDate('合計'), null);
});

test('金額：カンマ・円・¥・符号・全角、空欄は null、読めなければ NaN', () => {
  assert.equal(parseAmount('1,234'), 1234);
  assert.equal(parseAmount('¥1,234円'), 1234);
  assert.equal(parseAmount('-500'), -500);
  assert.equal(parseAmount('+500'), 500);
  assert.equal(parseAmount('１，０００'), 1000);
  assert.equal(parseAmount(''), null);
  assert.ok(Number.isNaN(parseAmount('12.5')));
});

const formats = {
  // 入金・出金が別の列（三井住友銀行の形式に似せた例）
  separate: '年月日,お引出し,お預入れ,お取り扱い内容,残高,メモ\n2026/4/1,,"110,000",ﾌﾘｺﾐ ｶ)ﾎﾟｹｯﾄ,"610,000",\n2026/4/3,"5,500",,ＮＴＴドコモ,"604,500",\n',
  // 符号つきの1列（楽天銀行の形式に似せた例。新しい順）
  signed: '取引日,入出金(円),取引後残高(円),入出金内容\n20260403,-5500,604500,ﾄﾞｺﾓ\n20260401,110000,610000,ﾌﾘｺﾐ ﾎﾟｹｯﾄ\n',
  // 見出しの前に口座情報がある・摘要が2列（三菱UFJ銀行の形式に似せた例）
  preface: '口座番号,1234567\n照会期間,2026/04/01～2026/04/30\n日付,摘要,摘要内容,支払い金額,預かり金額,差引残高,メモ\n2026/4/1,振込,ﾎﾟｹｯﾄ,,"110,000","610,000",\n',
  // ゆうちょ銀行の形式に似せた例
  yucho: '取引日,受入金額（円）,払出金額（円）,詳細１,詳細２,現在（貸付）高\n2026/04/01,110000,,振込,ポケット,610000\n',
};

test('列の推定：銀行ごとの見出しの違いを吸収する', () => {
  const s = detectColumns(parseCsv(formats.separate));
  assert.deepEqual(s, { headerRow: 0, columns: { date: 0, memo: 3, memo2: -1, deposit: 2, withdrawal: 1, amount: -1, balance: 4 } });
  const g = detectColumns(parseCsv(formats.signed));
  assert.equal(g.columns.amount, 1);
  assert.equal(g.columns.balance, 2);
  assert.equal(g.columns.memo, 3);
  const p = detectColumns(parseCsv(formats.preface));
  assert.equal(p.headerRow, 2);
  assert.deepEqual([p.columns.memo, p.columns.memo2, p.columns.withdrawal, p.columns.deposit, p.columns.balance], [1, 2, 3, 4, 5]);
  const y = detectColumns(parseCsv(formats.yucho));
  assert.deepEqual([y.columns.deposit, y.columns.withdrawal, y.columns.memo, y.columns.memo2, y.columns.balance], [1, 2, 3, 4, 5]);
});

test('見出しが無いCSVは中身から日付・金額の列を推定する', () => {
  const rows = parseCsv('2026/4/1,振込 ポケット,110000,610000\n2026/4/3,ドコモ,-5500,604500\n');
  const m = detectColumns(rows);
  assert.equal(m.headerRow, -1);
  assert.deepEqual([m.columns.date, m.columns.memo, m.columns.amount, m.columns.balance], [0, 1, 2, 3]);
  assert.deepEqual(extractTransactions(rows, m).map((t) => t.amount), [110000, -5500]);
});

test('明細の取り出し：入金はプラス・出金はマイナス、新しい順は古い順に、摘要は半角カナを全角に', () => {
  for (const key of ['separate', 'signed']) {
    const rows = parseCsv(formats[key]);
    const txs = extractTransactions(rows, detectColumns(rows));
    assert.deepEqual(txs.map((t) => [t.date, t.amount, t.balance]), [['2026-04-01', 110000, 610000], ['2026-04-03', -5500, 604500]], key);
    assert.deepEqual(balanceMismatches(txs), []);
  }
  const rows = parseCsv(formats.separate);
  assert.equal(extractTransactions(rows, detectColumns(rows))[0].memo, 'フリコミ カ)ポケット');
  const p = parseCsv(formats.preface);
  assert.equal(extractTransactions(p, detectColumns(p))[0].memo, '振込 ポケット');
});

test('明細の取り出し：合計行・繰越行は飛ばし、金額が読めない行は印を付ける。残高の不一致を見つける', () => {
  const rows = parseCsv('日付,摘要,入金,出金,残高\n2026/4/1,前月繰越,,,500000\n2026/4/2,A,abc,,\n2026/4/3,B,,1000,400000\n合計,,0,1000,\n');
  const txs = extractTransactions(rows, detectColumns(rows));
  assert.deepEqual(txs.map((t) => [t.row, t.error]), [[3, '金額が読めません'], [4, null]]);
  const ok = [{ row: 2, amount: 100, balance: 1100 }, { row: 3, amount: -50, balance: 1000 }];
  assert.deepEqual(balanceMismatches(ok), [3]);
});

test('相手科目の候補：過去の口座の仕訳の摘要から（完全一致→含む言葉の長い方）', () => {
  const book = makeBook('individual');
  const by = (n) => book.byName[n].id;
  const journals = [
    book.j('2026-03-01', [['通信費', 5500]], [['普通預金', 5500]], 'ＮＴＴドコモ'),
    book.j('2026-03-05', [['普通預金', 110000]], [['売掛金', 110000]], 'フリコミ カ)ポケット'),
    book.j('2026-03-06', [['普通預金', 1000]], [['現金', 1000]], '預け入れ'), // 口座どうしは学習しない
  ];
  const isBank = (id) => id === by('普通預金') || id === by('現金');
  const index = buildCounterIndex(journals, isBank);
  assert.equal(suggestCounter('ｴﾇﾃｨﾃｨﾄﾞｺﾓ', index), null);
  assert.equal(suggestCounter('ＮＴＴドコモ', index).accountId, by('通信費'));
  assert.equal(suggestCounter('nttドコモ 4月分', index).accountId, by('通信費'));
  assert.equal(suggestCounter('フリコミ カ)ポケット', index).taxCategory, book.byName['売掛金'].defaultTaxCategory);
  assert.equal(suggestCounter('預け入れ', index), null);
});

test('重複の検出：同じ日付・口座・向き・金額の登録済み仕訳の件数まで', () => {
  const book = makeBook('individual');
  const journals = [book.j('2026-04-03', [['通信費', 5500]], [['普通預金', 5500]])];
  const txs = [
    { date: '2026-04-03', amount: -5500 },
    { date: '2026-04-03', amount: -5500 },
    { date: '2026-04-03', amount: 5500 },
  ];
  assert.deepEqual(markDuplicates(txs, journals, { accountId: book.byName['普通預金'].id }), [true, false, false]);
});

test('仕訳の明細：入金は口座が借方、出金は口座が貸方で、検証を通る', () => {
  const book = makeBook('individual');
  const bank = { accountId: book.byName['普通預金'].id };
  const dep = importLines({ amount: 110000, memo: '振込' }, bank, { accountId: book.byName['売上高'].id, taxCategory: 'sales_10' });
  assert.deepEqual(dep.map((l) => [l.side, l.accountId, l.amount, l.taxCategory]), [['debit', bank.accountId, 110000, 'none'], ['credit', book.byName['売上高'].id, 110000, 'sales_10']]);
  const wd = importLines({ amount: -5500, memo: 'ドコモ' }, bank, { accountId: book.byName['通信費'].id, taxCategory: 'purchase_10' });
  assert.deepEqual(wd.map((l) => l.side + l.amount), ['debit5500', 'credit5500']);
  const j = createJournal({ periodId: book.period.id, date: '2026-04-03', lines: wd });
  assert.deepEqual(validateJournal(j, { accounts: book.accounts, subAccounts: [], period: book.period }), []);
});

test('見出しのキー：同じ形式なら同じ', () => {
  const a = parseCsv(formats.separate);
  assert.equal(headerSignature(a, 0), headerSignature(parseCsv(formats.separate.replace('2026/4/1', '2026/5/1')), 0));
});

test('まとめて登録：通し番号を続けて振り、1件でも不正なら何も保存しない', async () => {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('individual').map((a) => createAccount(a));
  const period = createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト', entityType: 'individual' }), period, accounts });
  const by = Object.fromEntries(accounts.map((a) => [a.name, a.id]));
  const bank = { accountId: by['普通預金'] };
  const mk = (date, amount, counter) => createJournal({ periodId: period.id, date, lines: importLines({ amount, memo: 'x' }, bank, { accountId: by[counter] }) });
  const saved = await repo.saveJournals([mk('2026-04-01', 1000, '売上高'), mk('2026-04-02', -500, '通信費')]);
  assert.deepEqual(saved.map((j) => j.no), [1, 2]);
  await assert.rejects(repo.saveJournals([mk('2026-04-03', 100, '売上高'), mk('2027-01-01', 100, '売上高')]), (e) => e instanceof ValidationError && /2件目/.test(e.message));
  assert.equal((await repo.listJournals(period.id)).length, 2);
  const next = await repo.saveJournals([mk('2026-04-04', 100, '売上高')]);
  assert.equal(next[0].no, 3);
  repo.close();
});

test('Shift_JIS のCSVファイル（見出しの前に口座情報）を最後まで読める', async () => {
  const { readFile } = await import('node:fs/promises');
  const bytes = new Uint8Array(await readFile(new URL('./fixtures/bank-sample-sjis.csv', import.meta.url)));
  const { text, encoding } = decodeBytes(bytes);
  assert.equal(encoding, 'shift_jis');
  const rows = parseCsv(text);
  const txs = extractTransactions(rows, detectColumns(rows));
  assert.deepEqual(txs.map((t) => t.amount), [165000, -6380, 55000, -3280, -440]);
  assert.equal(txs[0].memo, '振込 フリコミ カ)マルタク');
  assert.equal(txs[4].memo, '振込手数料');
  assert.deepEqual(balanceMismatches(txs), []);
});

test('振り分けルール：言葉を含み向きが合うルールのうち、言葉の長いものを使う（ひらがな・全角半角は区別しない）', () => {
  const b = makeBook('individual');
  const id = (n) => b.byName[n].id;
  const rules = [
    { id: 'r1', keyword: 'アマゾン', direction: 'out', accountId: id('消耗品費'), taxCategory: 'purchase_10' },
    { id: 'r2', keyword: 'アマゾン ウエブ', direction: 'out', accountId: id('通信費'), taxCategory: 'purchase_10' },
    { id: 'r3', keyword: 'ふりこみ', direction: 'in', accountId: id('売掛金'), taxCategory: 'none' },
  ];
  const ctx = { accounts: b.accounts };
  assert.equal(matchRule({ memo: 'ｶｰﾄﾞ ｱﾏｿﾞﾝ ｼﾞﾔﾊﾟﾝ', amount: -3280 }, rules, ctx).rule.id, 'r1');
  assert.equal(matchRule({ memo: 'カード アマゾン ウエブ サービス', amount: -1200 }, rules, ctx).rule.id, 'r2');
  assert.deepEqual(matchRule({ memo: '振込 フリコミ カ)マルタク', amount: 55000 }, rules, ctx).counter, { accountId: id('売掛金'), subAccountId: null, taxCategory: 'none' });
  assert.equal(matchRule({ memo: 'フリコミ 返金', amount: -100 }, rules, ctx), null); // 入金だけのルールは出金に使わない
  // 無効にした科目のルールは使わない
  const off = b.accounts.map((a) => (a.id === id('消耗品費') ? { ...a, active: false } : a));
  assert.equal(matchRule({ memo: 'アマゾン', amount: -1 }, rules, { accounts: off }), null);
});

test('振り分けルール：検証', () => {
  const b = makeBook('individual');
  const ctx = { accounts: b.accounts, isBankAccount: (aid) => ['cash', 'deposit'].includes(b.accounts.find((a) => a.id === aid)?.role) };
  const ok = { keyword: 'NTT', direction: 'any', accountId: b.byName['通信費'].id, taxCategory: 'purchase_10' };
  assert.deepEqual(validateRule(ok, ctx), {});
  assert.match(validateRule({ ...ok, keyword: '  ' }, ctx).keyword, /言葉/);
  assert.match(validateRule({ ...ok, keyword: 'あ'.repeat(31) }, ctx).keyword, /30文字/);
  assert.match(validateRule({ ...ok, accountId: b.byName['普通預金'].id }, ctx).accountId, /現金・預金/);
  assert.match(validateRule({ ...ok, direction: 'x' }, ctx).direction, /向き/);
  assert.match(validateRule({ ...ok, taxCategory: 'x' }, ctx).taxCategory, /税区分/);
});
