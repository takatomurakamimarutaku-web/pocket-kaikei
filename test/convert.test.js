import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yayoiOpeningRows, groupYayoiRows, splitYayoiGroups, convertChecks, buildConvertPack, accountListCsv, CONVERT_TARGETS } from '../js/convert.js';
import { yayoiRows } from '../js/yayoi.js';
import { detectFormat, parseEntries } from '../js/journal-import.js';
import { parseCsv } from '../js/bank-import.js';
import { createSettings } from '../js/models.js';
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
  assert.match(new TextDecoder().decode(fileOf(pack, '00_').bytes), /他社ソフトデータの移行/);
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
