import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yayoiOpeningRows, groupYayoiRows, splitYayoiGroups, convertChecks, buildConvertPack, accountListCsv, CONVERT_TARGETS, validateConvertCodes, usedIds } from '../js/convert.js';
import { yayoiRows } from '../js/yayoi.js';
import { mfTaxName, mfInvoice, mfGroups, MF_HEADER, freeeTaxName, freeeGroups, FREEE_HEADER, bugyoGroups, BUGYO_HEADER, bugyoTaxCheckRows } from '../js/convert-formats.js';
import { detectFormat, parseEntries } from '../js/journal-import.js';
import { parseCsv } from '../js/bank-import.js';
import { createSettings, createAccount, createPeriod } from '../js/models.js';
import { templateAccounts } from '../js/accounts.js';
import { openDB, ValidationError } from '../js/db.js';
import { IDBFactory } from 'fake-indexeddb';
import { makeBook } from './helpers.js';

const sjisText = (bytes) => new TextDecoder('shift_jis').decode(bytes);
const fileOf = (pack, prefix) => pack.files.find((f) => f.name.startsWith(prefix));

function book(entityType = 'individual') {
  const b = makeBook(entityType, { subs: [['普通預金', 'みらい銀行'], ['売掛金', 'A社'], ['売掛金', 'B社']] });
  const journals = [
    b.j('2026-05-01', [['消耗品費', 1100, 'purchase_10']], [['現金', 1100]], 'コピー用紙, A4'),
    b.j('2026-05-31', [['売掛金', 330000, 'none', 'A社']], [['売上高', 330000, 'sales_10']], '5月分'),
  ];
  return { b, journals, accountById: new Map(b.accounts.map((a) => [a.id, a])), subById: new Map(b.subAccounts.map((s) => [s.id, s])) };
}

test('期首残高を弥生の期首残高データにする：6列、補助科目ごと、元入金は出さない、0円は出さない', () => {
  const { b, accountById, subById } = book();
  b.opening([
    ['現金', 50000],
    ['普通預金', 1200000, 'みらい銀行'],
    ['売掛金', 220000, 'A社'],
    ['売掛金', 110000, 'B社'],
    ['売掛金', 0, 'B社'],
    ['買掛金', 30000],
    ['元入金', 1550000],
  ]);
  const { rows, skipped } = yayoiOpeningRows(b.period, { accountById, subById });
  assert.deepEqual(rows, [
    ['2026/01/01', '現金', '借方', '', '', 50000],
    ['2026/01/01', '普通預金', '借方', 'みらい銀行', '', 1200000],
    ['2026/01/01', '売掛金', '借方', 'A社', '', 220000],
    ['2026/01/01', '売掛金', '借方', 'B社', '', 110000],
    ['2026/01/01', '買掛金', '貸方', '', '', 30000],
  ]);
  assert.deepEqual(skipped, ['元入金']);
});

test('仕訳を途中で切らずに行数・大きさの上限でファイルを分ける', () => {
  const b = makeBook('individual');
  const journals = [];
  for (let i = 0; i < 5; i++) journals.push(b.j('2026-05-01', [['消耗品費', 100]], [['現金', 100]], `${i}`));
  journals.push(b.j('2026-05-02', [['地代家賃', 600], ['事業主貸', 400]], [['現金', 1000]], '家賃'));
  const rows = yayoiRows(journals, { accountById: new Map(b.accounts.map((a) => [a.id, a])), subById: new Map(), period: b.period });
  const groups = groupYayoiRows(rows);
  assert.equal(groups.length, 6);
  assert.equal(groups[5].length, 2);
  // 5行ずつ：2行の伝票は次のファイルへ
  const files = splitYayoiGroups(groups, { maxRows: 5 });
  assert.deepEqual(files.map((f) => f.length), [5, 2]);
  assert.deepEqual(files[1].map((r) => r[0]), ['2110', '2101']);
  // 上限なしなら1つ
  assert.equal(splitYayoiGroups(groups, {}).length, 1);
  // 大きさの上限（1行がおよそ70バイト）
  assert.ok(splitYayoiGroups(groups, { maxBytes: 150 }).length >= 3);
});

test('書き出す前の確認：オンライン版の複合仕訳20行・製造原価の科目は取り込めない、長い名前は注意', () => {
  const b = makeBook('corporation', { manufacturing: true });
  const debits = Array.from({ length: 21 }, () => ['消耗品費', 100]);
  const journals = [b.j('2026-05-01', debits, [['現金', 2100]], '多い'), b.j('2026-05-02', [['材料仕入高', 500]], [['現金', 500]], '材料')];
  b.byName['現金'].name = '現金（とても長い名前の手元の現金）';
  const ctx = { accountById: new Map(b.accounts.map((a) => [a.id, a])), subById: new Map(), period: b.period };
  const online = convertChecks(journals, { ...ctx, target: 'online' });
  assert.equal(online.errors.length, 2);
  assert.match(online.errors[0], /2026\/05\/01 伝票No\.1：21行の仕訳.*20行まで/);
  assert.match(online.errors[1], /製造原価の科目（材料仕入高）/);
  assert.match(online.warnings[0], /全角12文字まで.*現金（とても長い名前の手元の現金）/);
  // デスクトップ版は行数・製造原価の制限なし
  assert.equal(convertChecks(journals, { ...ctx, target: 'yayoi' }).errors.length, 0);
});

test('移行パック（弥生オンライン）：手順書・期首残高・仕訳（Shift_JIS、カンマは全角）・科目一覧・照合用の試算表', () => {
  const { b, journals } = book();
  b.opening([['現金', 50000], ['元入金', 50000]]);
  const pack = buildConvertPack({ target: 'online', settings: createSettings({ businessName: 'テスト商店', entityType: 'individual' }), period: b.period, accounts: b.accounts, subAccounts: b.subAccounts, journals });
  assert.deepEqual(pack.files.map((f) => f.name), ['00_移行の手順.txt', '01_期首残高_弥生インポート形式.csv', '02_仕訳_弥生インポート形式.csv', '03_勘定科目と補助科目の一覧.csv', '05_残高試算表_期末（照合用）.csv']);
  assert.equal(pack.journalFiles, 1);
  assert.equal(sjisText(fileOf(pack, '01_').bytes), '2026/01/01,現金,借方,,,50000\r\n');
  const journalText = sjisText(fileOf(pack, '02_').bytes);
  assert.match(journalText, /コピー用紙， A4/);
  assert.ok(!journalText.includes('"'));
  // 書き出した仕訳は、Pocket会計の取り込みでもう一度読める
  const rows = parseCsv(journalText);
  const entries = parseEntries(rows, detectFormat(rows));
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[1].lines.map((l) => [l.side, l.account, l.sub, l.amount]), [['debit', '売掛金', 'A社', 330000], ['credit', '売上高', '', 330000]]);
  const guide = new TextDecoder().decode(fileOf(pack, '00_').bytes);
  assert.match(guide, /弥生会計 オンライン/);
  assert.match(guide, /元入金の期首残高は、移行先が自動で計算する/);
  assert.match(guide, /経理方式は「税込」/);
});

test('移行パック（マネーフォワード）：期首残高は手入力用の一覧、仕訳は分けない、固定資産があれば台帳も入れる', () => {
  const { b, journals } = book('corporation');
  b.opening([['現金', 100000], ['資本金', 100000]]);
  const asset = { id: 'a1', name: 'ノートパソコン', category: 'tools', accountId: b.byName['工具器具備品'].id, acquiredOn: '2026-04-01', startedOn: '2026-04-01', cost: 300000, method: 'straight', usefulLife: 4, businessRatio: 100, disposedOn: null, quantity: 1 };
  const pack = buildConvertPack({ target: 'mf', settings: createSettings({ entityType: 'corporation' }), period: b.period, accounts: b.accounts, subAccounts: b.subAccounts, journals, assets: [asset], periods: [b.period] });
  assert.ok(fileOf(pack, '01_期首残高の一覧'));
  assert.match(new TextDecoder().decode(fileOf(pack, '01_').bytes), /資本金,,貸方,100000/);
  assert.ok(fileOf(pack, '04_固定資産台帳'));
  assert.equal(pack.assetCount, 1);
  assert.match(new TextDecoder().decode(fileOf(pack, '00_').bytes), /［会計帳簿］→［仕訳帳］/);
  assert.ok(fileOf(pack, '02_仕訳_マネーフォワード形式'));
});

test('勘定科目の一覧：科目の行と補助科目の行、区分・残高の側・既定の税区分', () => {
  const { b } = book();
  const lines = accountListCsv(b.accounts, b.subAccounts, 'individual').split('\r\n');
  assert.equal(lines[0].replace(/^﻿/, ''), 'コード,勘定科目,補助科目,区分,残高の側,既定の税区分,使用');
  assert.ok(lines.some((l) => /^\d*,売掛金,A社,/.test(l)));
  assert.ok(lines.some((l) => /,売上高,,.*,貸方,課税売上10%,使う$/.test(l)));
});

test('移行先の定義：オンライン版はShift_JIS向けの制限をすべて持つ', () => {
  assert.deepEqual([CONVERT_TARGETS.online.maxRows, CONVERT_TARGETS.online.maxBytes, CONVERT_TARGETS.online.maxLines, CONVERT_TARGETS.online.noComma], [1000, 1_000_000, 20, true]);
  assert.equal(CONVERT_TARGETS.next.maxRows, 5000);
});

test('マネーフォワードの税区分：税込の名称、共通対応・非課税対応、経過措置はインボイスの列', () => {
  assert.equal(mfTaxName('none'), '対象外');
  assert.equal(mfTaxName('sales_10'), '課税売上 10%');
  assert.equal(mfTaxName('sales_8r'), '課税売上 (軽)8%');
  assert.equal(mfTaxName('purchase_10'), '課税仕入 10%');
  assert.equal(mfTaxName('purchase_8r_c'), '共通課税仕入 (軽)8%');
  assert.equal(mfTaxName('purchase_10_e'), '非課税対応仕入 10%');
  assert.equal(mfTaxName('purchase_10_ni'), '課税仕入 10%');
  assert.equal(mfTaxName('purchase_return_10'), '課税仕入-返還等 10%');
  assert.equal(mfTaxName('sales_return_8r'), '課税売上-返還等 (軽)8%');
  assert.equal(mfTaxName('sales_baddebt_10'), '課税売上-貸倒 10%');
  assert.equal(mfTaxName('sales_recovered_10'), '課税売上-貸倒回収 10%');
  assert.equal(mfTaxName('sales_export'), '輸売 0%');
  assert.equal(mfTaxName('sales_exempt'), '非課税売上');
  assert.equal(mfTaxName('purchase_exempt'), '非課税仕入');
  assert.equal(mfTaxName('sales_securities'), '非課税売上-有価証券譲渡');
  assert.equal(mfTaxName('import_tax'), '輸入仕入-消費税額 7.8%');
  assert.equal(mfInvoice('purchase_10', '2026-11-01'), '');
  assert.equal(mfInvoice('purchase_10_ni', '2026-09-30'), '80％控除');
  assert.equal(mfInvoice('purchase_10_ni', '2026-10-01'), '70％控除');
  assert.equal(mfInvoice('purchase_8r_ni', '2031-10-01'), '控除なし');
});

test('freee の税区分：税込、軽減は8%(軽)、経過措置は(控80)(控70)', () => {
  assert.equal(freeeTaxName('none', '2026-05-01'), '対象外');
  assert.equal(freeeTaxName('sales_10', '2026-05-01'), '課税売上10%');
  assert.equal(freeeTaxName('sales_8r', '2026-05-01'), '課税売上8%(軽)');
  assert.equal(freeeTaxName('purchase_10', '2026-05-01'), '課対仕入10%');
  assert.equal(freeeTaxName('purchase_8r_c', '2026-05-01'), '共対仕入8%(軽)');
  assert.equal(freeeTaxName('purchase_10_ni', '2026-09-30'), '課対仕入(控80)10%');
  assert.equal(freeeTaxName('purchase_8r_ni', '2026-10-01'), '課対仕入(控70)8%(軽)');
  assert.equal(freeeTaxName('purchase_10_ni', '2023-09-30'), '課対仕入10%');
  assert.equal(freeeTaxName('purchase_return_10', '2026-05-01'), '課対仕返10%');
  assert.equal(freeeTaxName('sales_return_10', '2026-05-01'), '課税売返10%');
  assert.equal(freeeTaxName('sales_exempt', '2026-05-01'), '非課売上');
});

test('マネーフォワード形式・freee形式の仕訳：列数、複合仕訳は同じ番号、決算整理の印、税額は空欄', () => {
  const b = makeBook('individual', { subs: [['普通預金', 'みらい銀行']] });
  const journals = [
    b.j('2026-11-02', [['消耗品費', 1100, 'purchase_10_ni']], [['現金', 1100]], '紙'),
    b.j('2026-06-27', [['地代家賃', 66000, 'purchase_10'], ['事業主貸', 44000]], [['普通預金', 110000, 'none', 'みらい銀行']], '家賃'),
    { ...b.j('2026-12-31', [['減価償却費', 50000]], [['工具器具備品', 50000]], '減価償却'), adjusting: true },
  ];
  const ctx = { accountById: new Map(b.accounts.map((a) => [a.id, a])), subById: new Map(b.subAccounts.map((s) => [s.id, s])) };
  const mf = mfGroups(journals, ctx);
  assert.equal(MF_HEADER.length, 27);
  assert.ok(mf.flat().every((r) => r.length === 27));
  // 日付順：家賃（6/27）が先
  assert.deepEqual(mf[0].map((r) => [r[0], r[1], r[2], r[3], r[8], r[10], r[11], r[16]]), [
    [2, '2026/06/27', '地代家賃', '', 66000, '普通預金', 'みらい銀行', 110000],
    [2, '2026/06/27', '事業主貸', '', 44000, '', '', ''],
  ]);
  assert.deepEqual([mf[1][0][6], mf[1][0][7], mf[1][0][9]], ['課税仕入 10%', '70％控除', '']);
  assert.equal(mf[2][0][22], '決算整理');
  const fr = freeeGroups(journals, ctx);
  assert.equal(FREEE_HEADER.length, 33);
  assert.ok(fr.flat().every((r) => r.length === 33 && r[0] === '[明細行]'));
  assert.deepEqual(fr[0][1].slice(1, 4), ['2026/06/27', 2, '']);
  assert.deepEqual([fr[0][1][4], fr[0][1][15], fr[0][1][18], fr[0][1][29]], ['事業主貸', 44000, '', '']);
  assert.deepEqual([fr[1][0][16], fr[1][0][17]], ['課対仕入(控70)10%', '']);
  assert.equal(fr[2][0][3], 1);
  assert.equal(fr[0][0][32], '家賃');
});

test('移行パック（freee）：見出しの[表題行]つきの UTF-8、期首残高は手入力用の一覧、手順書は口座の作成から', () => {
  const { b, journals } = book();
  const pack = buildConvertPack({ target: 'freee', settings: createSettings({ entityType: 'individual' }), period: b.period, accounts: b.accounts, subAccounts: b.subAccounts, journals });
  const bytes = fileOf(pack, '02_仕訳_freee形式').bytes;
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.startsWith('[表題行],日付,伝票番号,決算整理仕訳,借方勘定科目'));
  assert.equal(text.trim().split('\r\n').length, 3);
  assert.match(text, /"コピー用紙, A4"/);
  assert.ok(fileOf(pack, '01_期首残高の一覧'));
  const guide = new TextDecoder().decode(fileOf(pack, '00_').bytes);
  assert.match(guide, /口座を作ります/);
  assert.match(guide, /［取引入力］→［振替伝票］/);
});

test('勘定奉行の OBC受入形式：受入記号の見出し、伝票の先頭行だけ「*」と日付、科目はコード、税区分は空欄', () => {
  const b = makeBook('individual', { subs: [['普通預金', 'みらい銀行']] });
  const journals = [
    b.j('2026-06-27', [['地代家賃', 66000, 'purchase_10'], ['事業主貸', 44000]], [['普通預金', 110000, 'none', 'みらい銀行']], '家賃'),
    b.j('2026-05-01', [['消耗品費', 1100, 'purchase_8r']], [['現金', 1100]], '紙'),
  ];
  const id = (name) => b.accounts.find((a) => a.name === name).id;
  const bank = b.subAccounts.find((s) => s.name === 'みらい銀行');
  const codes = { accounts: { [id('地代家賃')]: '8310', [id('事業主貸')]: '1900', [id('普通預金')]: '1110', [id('消耗品費')]: '8200', [id('現金')]: '1000' }, subs: { [bank.id]: '1' } };
  assert.equal(BUGYO_HEADER[0], 'OBCD001');
  assert.equal(BUGYO_HEADER.length, 13);
  const groups = bugyoGroups(journals, { codes });
  assert.ok(groups.flat().every((r) => r.length === 13));
  assert.deepEqual(groups[0], [['*', '2026-05-01', '', '8200', '', '', 1100, '', '1000', '', '', 1100, '紙']]);
  assert.deepEqual(groups[1], [
    ['*', '2026-06-27', '', '8310', '', '', 66000, '', '1110', '1', '', 110000, '家賃'],
    ['', '', '', '1900', '', '', 44000, '', '', '', '', '', '家賃'],
  ]);
  // 税区分を確かめる明細：科目の初期値と違うもの（消耗品費の軽減税率）
  const ctx = { accountById: new Map(b.accounts.map((a) => [a.id, a])), subById: new Map(b.subAccounts.map((s) => [s.id, s])) };
  const tax = bugyoTaxCheckRows(journals, ctx);
  assert.deepEqual(tax.map((r) => [r[3], r[5]]), [['消耗品費', 1100]]);
});

test('勘定奉行：コードのない科目は書き出せない、コードの形の確認、パックは Shift_JIS で税区分の確認つき', () => {
  const { b, journals, accountById, subById } = book();
  assert.deepEqual(validateConvertCodes({ accounts: { a: '8310', b: '' } }), []);
  assert.match(validateConvertCodes({ accounts: { a: '83-10' } })[0], /半角の英数字/);
  assert.match(validateConvertCodes({ subs: { a: '12345678901' } })[0], /10桁/);
  const none = convertChecks(journals, { target: 'bugyo', accountById, subById, period: b.period, codes: {} });
  assert.match(none.errors[0], /勘定科目コードが入っていない科目があります：.*消耗品費/);
  const used = usedIds(journals, b.period);
  const codes = { accounts: Object.fromEntries([...used.accounts].map((id, i) => [id, String(1000 + i)])) };
  const ok = convertChecks(journals, { target: 'bugyo', accountById, subById, period: b.period, codes });
  assert.deepEqual(ok.errors, []);
  const settings = createSettings({ entityType: 'individual', convertCodes: { bugyo: codes } });
  const pack = buildConvertPack({ target: 'bugyo', settings, period: b.period, accounts: b.accounts, subAccounts: b.subAccounts, journals });
  const text = sjisText(fileOf(pack, '02_仕訳_勘定奉行OBC受入形式').bytes);
  assert.ok(text.startsWith('OBCD001,CSJS005,CSJS200,CSJS201'));
  assert.equal(text.trim().split('\r\n').length, 3);
  assert.ok(fileOf(pack, '01_期首残高の一覧'));
  assert.match(new TextDecoder().decode(fileOf(pack, '03_').bytes), /移行先の科目コード/);
  const guide = new TextDecoder().decode(fileOf(pack, '00_').bytes);
  assert.match(guide, /仕訳伝票データ受入/);
  assert.match(guide, /OBC受入形式/);
});

test('移行先のコードの対応表を設定に保存する（空欄は外す・形の誤りは保存しない）', async () => {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('individual').map((a) => createAccount(a));
  await repo.setup({ settings: createSettings({ businessName: 'テスト' }), period: createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' }), accounts });
  const saved = await repo.saveConvertCodes('bugyo', { accounts: { [accounts[0].id]: '1000', [accounts[1].id]: '' } });
  assert.deepEqual(saved.convertCodes, { bugyo: { accounts: { [accounts[0].id]: '1000' }, subs: {}, departments: {} } });
  await assert.rejects(repo.saveConvertCodes('bugyo', { accounts: { x: 'あ' } }), ValidationError);
  assert.equal((await repo.getSettings()).convertCodes.bugyo.accounts[accounts[0].id], '1000');
});
