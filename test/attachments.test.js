import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  attachmentType,
  validateAttachment,
  attachmentDefaults,
  fillBlank,
  searchAttachments,
  attachmentFileName,
  fitSize,
  formatBytes,
  bytesToBase64,
  base64ToBytes,
  sha256Hex,
  MAX_ATTACHMENT_BYTES,
} from '../js/attachments.js';
import { openDB, DB_NAME, DB_VERSION, migrate } from '../js/db.js';
import { createBackup, parseBackup, verifyAttachments } from '../js/backup.js';
import { createSettings, createAccount, createPeriod, createJournal, createAttachment } from '../js/models.js';
import { templateAccounts } from '../js/accounts.js';
import { attachmentsCsv } from '../js/csv.js';
import { ATTACHMENT_KINDS } from '../js/attachments.js';

const SHA_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const bytes = (text) => new TextEncoder().encode(text);

test('ファイルの種類：type が空なら拡張子から推定し、添付できないものは空', () => {
  assert.equal(attachmentType('receipt.JPG', ''), 'image/jpeg');
  assert.equal(attachmentType('invoice.pdf', 'application/octet-stream'), 'application/pdf');
  assert.equal(attachmentType('a.png', 'image/png'), 'image/png');
  assert.equal(attachmentType('e-invoice.xml', ''), 'application/xml');
  assert.equal(attachmentType('evil.html', 'text/html'), '');
  assert.equal(attachmentType('x.svg', 'image/svg+xml'), '');
});

test('SHA-256・base64：既知の値と一致し、往復で同じバイト列に戻る。大きな配列も変換できる', async () => {
  assert.equal(await sha256Hex(bytes('abc')), SHA_ABC);
  assert.equal(await sha256Hex(bytes('abc').buffer), SHA_ABC);
  assert.equal(bytesToBase64(bytes('abc')), 'YWJj');
  assert.deepEqual([...base64ToBytes('YWJj')], [97, 98, 99]);
  assert.equal(base64ToBytes('YW J'), null);
  assert.equal(base64ToBytes('YWJ'), null);
  assert.equal(base64ToBytes(5), null);
  const big = new Uint8Array(200000).map((_, i) => i % 251);
  assert.deepEqual(base64ToBytes(bytesToBase64(big)), big);
});

test('添付の検証：種類・大きさ・ハッシュ値・日付・金額', () => {
  const ok = createAttachment({ name: 'r.jpg', type: 'image/jpeg', size: 3, sha256: SHA_ABC, date: '2026-05-01', amount: 1100, partner: '文具店' });
  assert.deepEqual(validateAttachment(ok), []);
  assert.match(validateAttachment({ ...ok, kind: 'x' })[0], /種類/);
  assert.match(validateAttachment({ ...ok, type: 'text/html' })[0], /画像・PDF/);
  assert.match(validateAttachment({ ...ok, size: 0 })[0], /空/);
  assert.match(validateAttachment({ ...ok, size: MAX_ATTACHMENT_BYTES + 1 })[0], /大きすぎ/);
  assert.match(validateAttachment({ ...ok, sha256: 'abc' })[0], /ハッシュ/);
  assert.match(validateAttachment({ ...ok, date: '2026-02-30' })[0], /取引年月日/);
  assert.match(validateAttachment({ ...ok, amount: 1.5 })[0], /整数/);
  assert.deepEqual(validateAttachment({ ...ok, date: '', amount: null }), []);
  assert.match(validateAttachment({ ...ok, thumb: 'data:text/html;base64,AA==' })[0], /縮小画像/);
  assert.deepEqual(validateAttachment({ ...ok, thumb: 'data:image/jpeg;base64,AAAA' }), []);
});

test('初期値：金額は借方の合計、取引先は現金・預金以外の補助科目、なければ摘要。空欄だけ補う', () => {
  const subById = new Map([['s-bank', { name: '○○銀行' }], ['s-shop', { name: '文具のヤマダ' }]]);
  const isCash = (id) => id === 'bank';
  const j = {
    date: '2026-05-01',
    lines: [
      { side: 'debit', accountId: 'supplies', amount: 1000, memo: 'コピー用紙' },
      { side: 'debit', accountId: 'tax', amount: 100, memo: '' },
      { side: 'credit', accountId: 'bank', subAccountId: 's-bank', amount: 1100 },
    ],
  };
  assert.deepEqual(attachmentDefaults(j, { subById, isCash }), { date: '2026-05-01', amount: 1100, partner: 'コピー用紙' });
  const withShop = { ...j, lines: [...j.lines.slice(0, 2), { side: 'credit', accountId: 'payable', subAccountId: 's-shop', amount: 1100 }] };
  assert.equal(attachmentDefaults(withShop, { subById, isCash }).partner, '文具のヤマダ');
  assert.deepEqual(attachmentDefaults({ date: '', lines: [] }, { subById }), { date: '', amount: null, partner: '' });
  const filled = fillBlank({ date: '', amount: null, partner: '手入力', memo: 'x' }, { date: '2026-05-02', amount: 500, partner: '自動' });
  assert.deepEqual(filled, { date: '2026-05-02', amount: 500, partner: '手入力', memo: 'x' });
  assert.equal(fillBlank({ date: '', amount: 0, partner: '' }, { amount: 500 }).amount, 0);
});

test('証憑の検索：日付・金額の範囲、取引先、種類、仕訳のない証憑を組み合わせる', () => {
  const list = [
    { id: 'a', date: '2026-04-10', amount: 5500, partner: '株式会社コクゼイ', memo: '', name: 'inv.pdf', kind: 'electronic', journalId: 'j1', createdAt: '1' },
    { id: 'b', date: '2026-05-20', amount: 1100, partner: '文具のヤマダ', memo: 'コピー用紙', name: 'r.jpg', kind: 'paper', journalId: 'j2', createdAt: '2' },
    { id: 'c', date: '', amount: null, partner: '', memo: '', name: 'memo.jpg', kind: 'paper', journalId: 'gone', createdAt: '3' },
    { id: 'd', date: '2026-05-20', amount: 30000, partner: 'こくぜい商事', memo: '', name: 'x.pdf', kind: 'electronic', journalId: null, createdAt: '4' },
  ];
  const ids = (r) => r.map((a) => a.id);
  assert.deepEqual(ids(searchAttachments(list)), ['d', 'b', 'a', 'c']);
  assert.deepEqual(ids(searchAttachments(list, { from: '2026-05-01', to: '2026-05-31' })), ['d', 'b']);
  assert.deepEqual(ids(searchAttachments(list, { min: 1000, max: 6000 })), ['b', 'a']);
  // 取引先は全角・半角、ひらがな・カタカナを区別しない。摘要（メモ）・ファイル名も対象
  assert.deepEqual(ids(searchAttachments(list, { party: 'コクゼイ' })), ['d', 'a']);
  assert.deepEqual(ids(searchAttachments(list, { party: 'ｺﾋﾟｰ' })), ['b']);
  assert.deepEqual(ids(searchAttachments(list, { kind: 'electronic', max: 10000 })), ['a']);
  assert.deepEqual(ids(searchAttachments(list, { unlinked: true, journalIds: new Set(['j1', 'j2']) })), ['d', 'c']);
});

test('ファイル名は国税庁の例と同じ「日付_取引先_金額」。項目がなければ元の名前', () => {
  assert.equal(attachmentFileName({ date: '2026-10-31', partner: '㈱国税商事', amount: 110000, type: 'application/pdf', name: 'a.pdf' }), '20261031_㈱国税商事_110000.pdf');
  assert.equal(attachmentFileName({ date: '2026-10-31', partner: 'A/B 商店', amount: null, type: 'image/jpeg', name: 'a.jpg' }), '20261031_AB商店.jpg');
  assert.equal(attachmentFileName({ date: '', partner: '', amount: null, type: 'image/jpeg', name: 'IMG_0001.jpg' }), 'IMG_0001.jpg');
});

test('撮影した画像の縮小：長辺を上限に合わせ、小さい画像は拡大しない', () => {
  assert.deepEqual(fitSize(4032, 3024, 2400), { width: 2400, height: 1800, scaled: true });
  assert.deepEqual(fitSize(3024, 4032, 2400), { width: 1800, height: 2400, scaled: true });
  assert.deepEqual(fitSize(1600, 1200, 2400), { width: 1600, height: 1200, scaled: false });
  assert.equal(formatBytes(512), '512B');
  assert.equal(formatBytes(350 * 1024), '350KB');
  assert.equal(formatBytes(1.25 * 1024 * 1024), '1.3MB');
});

async function setupRepo() {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('individual').map((a) => createAccount(a));
  const period = createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト商店', entityType: 'individual' }), period, accounts });
  const byName = Object.fromEntries(accounts.map((a) => [a.name, a]));
  const journal = await repo.saveJournal(
    createJournal({
      periodId: period.id,
      date: '2026-05-01',
      lines: [
        { side: 'debit', accountId: byName['消耗品費'].id, amount: 1100, taxCategory: 'none', memo: 'コピー用紙' },
        { side: 'credit', accountId: byName['現金'].id, amount: 1100, taxCategory: 'none', memo: '' },
      ],
    }),
  );
  return { repo, period, journal };
}

test('証憑の保存：ハッシュ値と大きさは中身から計算し、中身は変えられない。情報だけ直せる。削除は tombstone', async () => {
  const { repo, journal } = await setupRepo();
  const meta = createAttachment({ journalId: journal.id, kind: 'electronic', name: 'inv.pdf', type: 'application/pdf', size: 999, sha256: '0'.repeat(64), date: '2026-05-01', amount: 1100, partner: '文具店' });
  const saved = await repo.saveAttachment(meta, bytes('abc'));
  assert.equal(saved.size, 3);
  assert.equal(saved.sha256, SHA_ABC);
  assert.deepEqual([...new Uint8Array(await repo.getAttachmentData(saved.id))], [97, 98, 99]);
  assert.equal((await repo.listAttachmentsByJournal(journal.id)).length, 1);
  await assert.rejects(repo.saveAttachment(meta, bytes('xyz')), /中身は変えられません/);
  await assert.rejects(repo.saveAttachment(createAttachment({ journalId: 'nothing', name: 'a.jpg', type: 'image/jpeg' }), bytes('a')), /仕訳が見つかりません/);
  await assert.rejects(repo.saveAttachment(createAttachment({ name: 'a.html', type: 'text/html' }), bytes('a')), /画像・PDF/);
  // 情報の修正：中身・ハッシュ値・仕訳は変えない
  const updated = await repo.updateAttachment(saved.id, { partner: '文具のヤマダ', amount: 1000, sha256: 'f'.repeat(64), journalId: 'other' });
  assert.equal(updated.partner, '文具のヤマダ');
  assert.equal(updated.amount, 1000);
  assert.equal(updated.sha256, SHA_ABC);
  assert.equal(updated.journalId, journal.id);
  await assert.rejects(repo.updateAttachment(saved.id, { date: '2026-13-01' }), /取引年月日/);
  // 仕訳を削除しても証憑は残る（電子取引のデータは保存期間中残す）
  await repo.deleteJournal(journal.id);
  assert.equal((await repo.listAttachments()).length, 1);
  await repo.deleteAttachment(saved.id);
  assert.deepEqual(await repo.listAttachments(), []);
  assert.equal(await repo.getAttachmentData(saved.id), null);
  assert.ok((await repo.dumpAll()).tombstones.some((t) => t.store === 'attachments' && t.id === saved.id));
  repo.close();
});

test('締めた期間の仕訳には証憑を追加・修正・削除できない', async () => {
  const { repo, period, journal } = await setupRepo();
  const saved = await repo.saveAttachment(createAttachment({ journalId: journal.id, name: 'r.jpg', type: 'image/jpeg' }), bytes('abc'));
  await repo.createNextPeriod(createPeriod({ startDate: '2027-01-01', endDate: '2027-12-31' }), []);
  await repo.closePeriod(period.id);
  await assert.rejects(repo.saveAttachment(createAttachment({ journalId: journal.id, name: 'r2.jpg', type: 'image/jpeg' }), bytes('abc')), /締めてある/);
  await assert.rejects(repo.updateAttachment(saved.id, { memo: 'x' }), /締めてある/);
  await assert.rejects(repo.deleteAttachment(saved.id), /締めてある/);
  repo.close();
});

test('バックアップ：証憑の中身を base64 で含めて復元でき、画像を含めないときはこの端末の証憑を残す', async () => {
  const { repo, journal } = await setupRepo();
  const png = new Uint8Array(70000).map((_, i) => (i * 7) % 256);
  const saved = await repo.saveAttachment(createAttachment({ journalId: journal.id, name: 'r.png', type: 'image/png', thumb: 'data:image/jpeg;base64,AAAA' }), png);
  const full = createBackup(await repo.dumpAll());
  assert.equal(full.counts.attachments, 1);
  assert.equal(typeof full.attachmentData[0].data, 'string');
  const parsed = parseBackup(JSON.stringify(full));
  assert.equal(parsed.attachmentsOmitted, false);
  await verifyAttachments(parsed);
  // 別の端末に復元：中身まで同じ
  const other = await openDB({ indexedDB: new IDBFactory() });
  await other.replaceAll(parsed);
  assert.deepEqual(new Uint8Array(await other.getAttachmentData(saved.id)), png);
  // 画像を含めないバックアップ：証憑は空で、復元しても今ある証憑は消さない
  const light = createBackup(await repo.dumpAll({ attachments: false }), { includeAttachments: false });
  assert.equal(light.attachmentsOmitted, true);
  assert.deepEqual(light.attachments, []);
  const lightParsed = parseBackup(JSON.stringify(light));
  await other.replaceAll(lightParsed);
  assert.equal((await other.listAttachments()).length, 1);
  assert.ok(await other.getAttachmentData(saved.id));
  // 中身が書き換えられていたらハッシュ値の照合で拒否、大きさが違えば読み込みで拒否
  const tampered = { ...full, attachmentData: [{ ...full.attachmentData[0], data: bytesToBase64(png.map((b) => b ^ 1)) }] };
  await assert.rejects(verifyAttachments(parseBackup(JSON.stringify(tampered))), /一致しません/);
  assert.throws(() => parseBackup(JSON.stringify({ ...full, attachmentData: [{ ...full.attachmentData[0], data: 'YWJj' }] })), /証憑の中身/);
  assert.throws(() => parseBackup(JSON.stringify({ ...full, attachmentData: [] })), /証憑の中身/);
  assert.throws(() => parseBackup(JSON.stringify({ ...full, attachmentsOmitted: true })), /証憑/);
  // バージョン5のファイルは証憑を空にして読み込む
  const { attachments: _a, attachmentData: _d, ...v5 } = full;
  const fromV5 = parseBackup(JSON.stringify({ ...v5, version: 5 }));
  assert.deepEqual(fromV5.attachments, []);
  assert.deepEqual(fromV5.attachmentData, []);
  other.close();
  repo.close();
});

test('スキーマ移行：バージョン5のデータを残したまま証憑のストアを追加する', async () => {
  const idb = new IDBFactory();
  await new Promise((resolve, reject) => {
    const open = idb.open(DB_NAME, 5);
    open.onupgradeneeded = () => {
      migrate(open.result, 0, open.transaction);
      open.result.deleteObjectStore('departments'); // バージョン7で追加
      open.result.deleteObjectStore('invoices'); // バージョン9で追加
      open.result.deleteObjectStore('employees'); // バージョン10で追加
      open.result.deleteObjectStore('payrolls');
      open.result.deleteObjectStore('yearEnds');
      open.result.deleteObjectStore('attachments'); // バージョン5の構成にする
      open.result.deleteObjectStore('attachmentData');
      open.transaction.objectStore('budgets').put({ id: 'b1', periodId: 'p1', accountId: 'a1', months: { '2026-01': 1 }, createdAt: 'x', updatedAt: 'x' });
    };
    open.onsuccess = () => {
      open.result.close();
      resolve();
    };
    open.onerror = () => reject(open.error);
  });
  const repo = await openDB({ indexedDB: idb });
  assert.equal(repo.db.version, DB_VERSION);
  assert.equal((await repo.listBudgets('p1'))[0].id, 'b1');
  assert.deepEqual(await repo.listAttachments(), []);
  repo.close();
});

test('索引簿の CSV：取引年月日・金額・取引先・保存用のファイル名・ハッシュ値・伝票No.', () => {
  const a = { id: 'a', date: '2026-10-31', amount: 110000, partner: '㈱国税商事', kind: 'electronic', name: 'inv.pdf', type: 'application/pdf', size: 1234, sha256: SHA_ABC, journalId: 'j1', memo: '10月分', createdAt: '2026-11-01T00:00:00.000Z' };
  const csv = attachmentsCsv([a, { ...a, id: 'b', journalId: 'gone', amount: null, date: '' }], {
    journalById: new Map([['j1', { no: 7, voucherNo: 9, date: '2026-10-31' }]]),
    kindLabels: ATTACHMENT_KINDS,
    fileName: attachmentFileName,
  });
  const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  assert.equal(lines[0], '取引年月日,取引金額,取引先,種類,保存用のファイル名,元のファイル名,大きさ（バイト）,SHA-256,伝票No.,仕訳の日付,メモ,登録日時');
  assert.equal(lines[1], `2026/10/31,110000,㈱国税商事,電子取引のデータ,20261031_㈱国税商事_110000.pdf,inv.pdf,1234,${SHA_ABC},9,2026/10/31,10月分,2026-11-01T00:00:00.000Z`);
  assert.equal(lines[2].split(',').slice(0, 2).join(','), ',');
  assert.equal(lines[2].split(',')[8], '');
});
