import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { encodeShiftJis } from '../js/sjis.js';
import { yayoiTaxName, yayoiRows, yayoiCsv } from '../js/yayoi.js';
import { detectFormat, parseEntries, suggestAccounts, suggestTax, buildImport, namesIn, journalSignature } from '../js/journal-import.js';
import { parseCsv } from '../js/bank-import.js';
import { openDB, ValidationError } from '../js/db.js';
import { createSettings, createAccount, createPeriod, createJournal } from '../js/models.js';
import { templateAccounts } from '../js/accounts.js';
import { makeBook } from './helpers.js';

const sjis = (t) => new TextDecoder('shift_jis').decode(encodeShiftJis(t).bytes);

test('Shift_JIS：かな・漢字・半角カナ・NEC特殊文字を変換し、ない文字は「?」にして知らせる', () => {
  const text = 'ABC,123 あア漢字ｱｲ①㈱\r\n';
  assert.equal(sjis(text), text);
  assert.deepEqual([...encodeShiftJis('あ').bytes], [0x82, 0xa0]);
  assert.deepEqual([...encodeShiftJis('ⅰ').bytes], [0xfa, 0x40]); // IBM 拡張を優先
  // 似た文字の言い換え（〜 → ～、− → －）
  assert.equal(sjis('9〜17時 −5'), '9～17時 －5');
  const r = encodeShiftJis('絵文字😀と𠮷');
  assert.equal(new TextDecoder('shift_jis').decode(r.bytes), '絵文字?と?');
  assert.deepEqual(r.unmappable, ['😀', '𠮷']);
});

test('弥生会計の税区分：税込の「込」、軽減8%、共通対応・非課税対応、インボイスなしは日付の経過措置の割合', () => {
  assert.equal(yayoiTaxName('none', '2026-05-01'), '対象外');
  assert.equal(yayoiTaxName('sales_10', '2026-05-01'), '課税売上込10%');
  assert.equal(yayoiTaxName('sales_8r', '2026-05-01'), '課税売上込軽減8%');
  assert.equal(yayoiTaxName('purchase_10', '2026-05-01'), '課対仕入込10%');
  assert.equal(yayoiTaxName('purchase_8r_c', '2026-05-01'), '共対仕入込軽減8%');
  assert.equal(yayoiTaxName('purchase_10_e', '2026-05-01'), '非対仕入込10%');
  assert.equal(yayoiTaxName('purchase_10_ni', '2023-09-30'), '課対仕入込10%');
  assert.equal(yayoiTaxName('purchase_10_ni', '2026-09-30'), '課対仕入込10%区分80%');
  assert.equal(yayoiTaxName('purchase_10_ni', '2026-10-01'), '課対仕入込10%区分70%');
  assert.equal(yayoiTaxName('purchase_8r_ni', '2032-01-01'), '課対仕入込軽減8%区分控不');
  assert.equal(yayoiTaxName('purchase_return_10', '2026-05-01'), '課対仕返込10%');
  assert.equal(yayoiTaxName('sales_return_8r', '2026-05-01'), '課税売返込軽減8%');
  assert.equal(yayoiTaxName('sales_baddebt_10', '2026-05-01'), '課税売倒込10%');
  assert.equal(yayoiTaxName('sales_recovered_10', '2026-05-01'), '課税売回込10%');
  assert.equal(yayoiTaxName('sales_export', '2026-05-01'), '輸出売上');
  assert.equal(yayoiTaxName('sales_exempt', '2026-05-01'), '非課売上');
  assert.equal(yayoiTaxName('purchase_exempt', '2026-05-01'), '非課仕入');
  assert.equal(yayoiTaxName('sales_securities', '2026-05-01'), '有価譲渡');
  assert.equal(yayoiTaxName('import_tax', '2026-05-01'), '課対輸税7.8%');
  assert.equal(yayoiTaxName('import_local', '2026-05-01'), '地消貨割2.2%');
});

function sampleBook() {
  const b = makeBook('individual', { subs: [['普通預金', 'みらい銀行'], ['売掛金', 'A社']] });
  const journals = [
    b.j('2026-05-01', [['消耗品費', 1100, 'purchase_10']], [['現金', 1100]], 'コピー用紙'),
    b.j('2026-05-31', [['売掛金', 330000, 'none', 'A社']], [['売上高', 330000, 'sales_10']], '5月分 デザイン料'),
    // 複合仕訳：家賃の家事按分
    b.j('2026-06-27', [['地代家賃', 66000, 'purchase_10'], ['事業主貸', 44000]], [['普通預金', 110000, 'none', 'みらい銀行']], '家賃'),
    { ...b.j('2026-12-31', [['減価償却費', 50000]], [['工具器具備品', 50000]], '減価償却'), adjusting: true },
  ];
  const accountById = new Map(b.accounts.map((a) => [a.id, a]));
  const subById = new Map(b.subAccounts.map((s) => [s.id, s]));
  return { b, journals, accountById, subById };
}

test('弥生会計の形式で書き出す：25列、1行は2000、複合仕訳は2110〜2100〜2101の振替伝票、期末の決算整理は本決', () => {
  const { b, journals, accountById, subById } = sampleBook();
  const rows = yayoiRows(journals, { accountById, subById, period: b.period });
  assert.ok(rows.every((r) => r.length === 25));
  assert.deepEqual(rows[0], ['2000', 1, '', '2026/05/01', '消耗品費', '', '', '課対仕入込10%', 1100, 100, '現金', '', '', '対象外', 1100, '', 'コピー用紙', '', '', 0, '', '', 0, 0, 'no']);
  assert.deepEqual(rows[1].slice(4, 16), ['売掛金', 'A社', '', '対象外', 330000, '', '売上高', '', '', '課税売上込10%', 330000, 30000]);
  // 複合仕訳：2行（借方2・貸方1）
  assert.deepEqual(rows.slice(2, 4).map((r) => [r[0], r[19]]), [['2110', 3], ['2101', 3]]);
  assert.deepEqual(rows[3].slice(4, 16), ['事業主貸', '', '', '対象外', 44000, '', '', '', '', '対象外', 0, '']);
  assert.equal(rows[4][2], '本決');
  const csv = yayoiCsv(journals, { accountById, subById, period: b.period });
  assert.ok(!csv.startsWith('﻿'));
  assert.equal(csv.split('\r\n')[0], '2000,1,,2026/05/01,消耗品費,,,課対仕入込10%,1100,100,現金,,,対象外,1100,,コピー用紙,,,0,,,0,0,no');
});

test('形式の判定：弥生会計の形式・見出しのあるCSV（freee・マネーフォワード）・わからない形式', () => {
  assert.equal(detectFormat(parseCsv('2000,1,,2026/05/01,消耗品費,,,課対仕入込10%,1100,100,現金,,,対象外,1100,,紙,,,0,,,0,0,no')).format, 'yayoi');
  const mf = detectFormat(parseCsv('取引No,取引日,借方勘定科目,借方補助科目,借方部門,借方取引先,借方税区分,借方インボイス,借方金額(円),借方税額,貸方勘定科目,貸方補助科目,貸方部門,貸方取引先,貸方税区分,貸方インボイス,貸方金額(円),貸方税額,摘要,仕訳メモ,タグ,MF仕訳タイプ,決算整理仕訳\n1,2026/05/01,消耗品費,,,,課税仕入 10%,,1100,100,現金,,,,対象外,,1100,0,紙,,,,'));
  assert.equal(mf.format, 'header');
  assert.equal(mf.columns.no, 0);
  assert.equal(mf.columns.debitAmount, 8);
  assert.equal(mf.columns.creditPartner, 13);
  assert.equal(mf.columns.adjusting, 22);
  const freee = detectFormat(parseCsv('"No.","取引日","借方勘定科目","借方金額","借方税区分","借方品目","借方部門","借方メモ","貸方勘定科目","貸方金額","貸方税区分","取引先","摘要","決算整理仕訳"\n1,2026/05/01,消耗品費,1100,課対仕入10%,,,,現金,1100,対象外,文具のヤマダ,紙,'));
  assert.equal(freee.format, 'header');
  assert.equal(freee.columns.no, 0);
  assert.equal(freee.columns.partner, 11);
  assert.equal(detectFormat(parseCsv('日付,内容,金額\n2026/05/01,紙,1100')).format, null);
});

test('弥生会計の形式を読む：複数行の伝票をまとめ、マイナスの金額は反対側、誤りは行番号つき', () => {
  const text = [
    '2000,1,,2026/05/01,消耗品費,,,課対仕入込10%,1100,100,現金,,,対象外,1100,,コピー用紙,,,0,,,0,0,no',
    '2110,2,,2026/06/27,地代家賃,,,課対仕入込10%,66000,6000,普通預金,みらい銀行,,対象外,110000,,家賃,,,3,,,0,0,no',
    '2101,2,,,事業主貸,,,対象外,44000,,,,,対象外,0,,家賃,,,3,,,0,0,no',
    '2000,3,,2026/07/01,現金,,,対象外,-500,,雑収入,,,対象外,-500,,戻し,,,0,,,0,0,no',
    '2000,4,,2026/13/01,現金,,,対象外,1,,雑収入,,,対象外,1,,,,,0,,,0,0,no',
    '9999,5,,2026/07/01,現金,,,対象外,1,,雑収入,,,対象外,1,,,,,0,,,0,0,no',
  ].join('\r\n');
  const rows = parseCsv(text);
  const entries = parseEntries(rows, detectFormat(rows));
  assert.equal(entries.length, 5);
  assert.equal(entries[1].lines.length, 3);
  assert.deepEqual(entries[1].rows, [2, 3]);
  assert.equal(entries[1].date, '2026-06-27');
  assert.deepEqual(entries[1].lines.map((l) => [l.side, l.account, l.sub, l.amount]), [['debit', '地代家賃', '', 66000], ['credit', '普通預金', 'みらい銀行', 110000], ['debit', '事業主貸', '', 44000]]);
  assert.deepEqual(entries[2].lines.map((l) => [l.side, l.account]), [['credit', '現金'], ['debit', '雑収入']]);
  assert.match(entries[3].errors[0], /5行目：取引日付/);
  assert.match(entries[4].errors[0], /6行目：識別フラグ/);
  assert.deepEqual(namesIn(entries).taxes, ['課対仕入込10%', '対象外']);
});

test('見出しのあるCSVを読む：同じ番号の行を1つの仕訳に、取引先は摘要の先頭、決算整理仕訳の印', () => {
  const text = [
    'No.,取引日,借方勘定科目,借方金額,借方税区分,貸方勘定科目,貸方金額,貸方税区分,取引先,摘要,決算整理仕訳',
    '1,2026/05/01,消耗品費,1100,課対仕入10%,現金,1100,対象外,文具のヤマダ,コピー用紙,',
    '2,2026/06/27,地代家賃,66000,課対仕入10%,普通預金,110000,対象外,,家賃,',
    '2,2026/06/27,事業主貸,44000,対象外,,,,,家賃,',
    '3,2026/12/31,減価償却費,50000,対象外,工具器具備品,50000,対象外,,償却,決算整理仕訳',
    ',2026/07/01,現金,100,対象外,雑収入,100,対象外,,番号なし,',
  ].join('\n');
  const rows = parseCsv(text);
  const entries = parseEntries(rows, detectFormat(rows));
  assert.equal(entries.length, 4);
  assert.equal(entries[0].lines[0].memo, '文具のヤマダ コピー用紙');
  assert.equal(entries[1].lines.length, 3);
  assert.equal(entries[2].adjusting, true);
  assert.equal(entries[3].lines.length, 2);
});

test('科目の照らし合わせ：前回の対応 → 同じ名前 → 表記の違い。合わなければ空', () => {
  const b = makeBook('individual');
  const m = suggestAccounts(['消耗品費', '売上', 'ソフトウエア', '仮払消費税等', '謎の科目', '旅費交通費'], b.accounts, { 旅費交通費: b.byName['通信費'].id });
  assert.equal(m.get('消耗品費'), b.byName['消耗品費'].id);
  assert.equal(m.get('売上'), b.byName['売上高'].id);
  assert.equal(m.get('謎の科目'), null);
  assert.equal(m.get('旅費交通費'), b.byName['通信費'].id);
});

test('税区分の照らし合わせ：弥生・freee・マネーフォワードの表記', () => {
  const cases = [
    ['課税売上込10%', 'sales_10'],
    ['課税売上8%(軽)', 'sales_8r'],
    ['課対仕入込軽減8%', 'purchase_8r'],
    ['課対仕入込10%区分80%', 'purchase_10_ni'],
    ['課対仕入(控80)10%', 'purchase_10_ni'],
    ['課対仕入込10%適格', 'purchase_10'],
    ['課税仕入 10%', 'purchase_10'],
    ['共-課仕 10%', 'purchase_10_c'],
    ['非-課仕 (軽)8%', 'purchase_8r_e'],
    ['共対仕返込10%', 'purchase_return_10_c'],
    ['課税売返込10%', 'sales_return_10'],
    ['課税売倒込軽減8%', 'sales_baddebt_8r'],
    ['課税売回込10%', 'sales_recovered_10'],
    ['非課売上', 'sales_exempt'],
    ['非課税仕入', 'purchase_exempt'],
    ['輸出売上', 'sales_export'],
    ['有価譲渡', 'sales_securities'],
    ['課対輸税7.8%', 'import_tax'],
    ['地消貨割2.2%', 'import_local'],
    ['対象外', 'none'],
    ['対外仕入', 'none'],
  ];
  for (const [label, code] of cases) assert.equal(suggestTax(label).code, code, label);
  assert.equal(suggestTax('', 'purchase_10').code, 'purchase_10');
  // 旧税率・控除できない仕入・わからないものは対象外にして知らせる
  for (const label of ['課税売上8%', '課対仕入込5%', '課対仕入込10%区分控不', 'なぞ']) {
    const r = suggestTax(label);
    assert.equal(r.code, 'none', label);
    assert.match(r.note, /対象外にした/);
  }
});

test('往復：書き出した弥生会計の形式を読み込むと、同じ科目・補助科目・金額・税区分の仕訳になる', () => {
  const { b, journals, accountById, subById } = sampleBook();
  const rows = parseCsv(yayoiCsv(journals, { accountById, subById, period: b.period }));
  const entries = parseEntries(rows, detectFormat(rows));
  const names = namesIn(entries);
  const accountMap = suggestAccounts(names.accounts, b.accounts);
  const taxMap = new Map(names.taxes.map((t) => [t, suggestTax(t).code]));
  const { items, newSubs } = buildImport(entries, { accountMap, taxMap, subAccounts: b.subAccounts, accountById });
  assert.deepEqual(newSubs, []);
  assert.equal(items.length, journals.length);
  items.forEach((it, i) => {
    assert.deepEqual(it.errors, []);
    assert.equal(it.date, journals[i].date);
    assert.equal(journalSignature({ date: it.date, lines: it.lines }), journalSignature(journals[i]));
    const tax = (ls) => ls.map((l) => `${l.side}:${l.accountId}:${l.taxCategory}`).sort();
    assert.deepEqual(tax(it.lines), tax(journals[i].lines));
  });
  assert.equal(items[3].adjusting, true);
});

test('仕訳にする：合わない科目は誤り、ない補助科目は作る予定にし、空欄の税区分は科目の既定', () => {
  const b = makeBook('individual');
  const accountById = new Map(b.accounts.map((a) => [a.id, a]));
  const entries = [
    { key: 'a', date: '2026-05-01', adjusting: false, rows: [1], errors: [], lines: [
      { side: 'debit', account: '消耗品費', sub: '', tax: '', amount: 1100, memo: '紙' },
      { side: 'credit', account: '買掛金', sub: '文具のヤマダ', tax: '対象外', amount: 1100, memo: '紙' },
    ] },
    { key: 'b', date: '2026-05-02', adjusting: false, rows: [2], errors: [], lines: [{ side: 'debit', account: '謎', sub: '', tax: '', amount: 1, memo: '' }] },
  ];
  const accountMap = new Map([['消耗品費', b.byName['消耗品費'].id], ['買掛金', b.byName['買掛金'].id], ['謎', null]]);
  const { items, newSubs } = buildImport(entries, { accountMap, taxMap: new Map([['対象外', 'none']]), subAccounts: [], accountById });
  assert.equal(items[0].lines[0].taxCategory, b.byName['消耗品費'].defaultTaxCategory);
  assert.equal(items[0].lines[1].subAccountId, `new:${b.byName['買掛金'].id}:文具のヤマダ`);
  assert.deepEqual(newSubs.map((s) => s.name), ['文具のヤマダ']);
  assert.match(items[1].errors[0], /科目「謎」の対応を選んで/);
});

test('取り込みの保存：補助科目を作って仕訳の参照を置き換え、1件でも不正なら何もしない', async () => {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('individual').map((a) => createAccount(a));
  const period = createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト', entityType: 'individual' }), period, accounts });
  const byName = Object.fromEntries(accounts.map((a) => [a.name, a]));
  const key = `new:${byName['買掛金'].id}:文具のヤマダ`;
  const line = (side, name, amount, sub = null) => ({ side, accountId: byName[name].id, subAccountId: sub, amount, taxCategory: 'none', memo: '取込' });
  const j1 = createJournal({ periodId: period.id, date: '2026-05-01', lines: [line('debit', '消耗品費', 1100), line('credit', '買掛金', 1100, key)], source: 'journal_import' });
  const j2 = createJournal({ periodId: period.id, date: '2026-05-02', lines: [line('debit', '消耗品費', 500), line('credit', '買掛金', 500, key)], source: 'journal_import' });
  const bad = createJournal({ periodId: period.id, date: '2026-05-03', lines: [line('debit', '消耗品費', 1), line('credit', '現金', 2)] });
  await assert.rejects(repo.importJournals([{ key, accountId: byName['買掛金'].id, name: '文具のヤマダ' }], [j1, bad]), (e) => e instanceof ValidationError && /2件目/.test(e.message));
  assert.deepEqual(await repo.listJournals(period.id), []);
  assert.deepEqual(await repo.listSubAccounts(), []);
  const res = await repo.importJournals([{ key, accountId: byName['買掛金'].id, name: '文具のヤマダ' }], [j1, j2]);
  assert.equal(res.subs, 1);
  assert.deepEqual(res.journals.map((j) => j.no), [1, 2]);
  const [sub] = await repo.listSubAccounts();
  assert.equal(sub.name, '文具のヤマダ');
  assert.ok(res.journals.every((j) => j.lines[1].subAccountId === sub.id));
  // 同じ名前の補助科目があれば作らずに使う
  const again = await repo.importJournals([{ key, accountId: byName['買掛金'].id, name: '文具のヤマダ' }], [createJournal({ ...j1, id: undefined, date: '2026-06-01' })].map((j) => ({ ...j, id: crypto.randomUUID() })));
  assert.equal(again.subs, 0);
  assert.equal((await repo.listSubAccounts()).length, 1);
  repo.close();
});
