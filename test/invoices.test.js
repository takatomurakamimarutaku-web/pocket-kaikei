import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  parseQuantity,
  formatQuantity,
  parseUnitPrice,
  normalizeRegistrationNo,
  isRegistrationNo,
  lineAmount,
  invoiceTotals,
  validateInvoice,
  validateInvoiceSettings,
  nextInvoiceNumber,
  isDuplicateNumber,
  invoiceJournal,
  invoiceDraft,
  copyInvoice,
  postingDate,
  invoicesCsv,
  compareInvoices,
} from '../js/invoices.js';
import { validateJournal } from '../js/journal.js';
import { stackedTaxes } from '../js/tax-return.js';
import { templateAccounts } from '../js/accounts.js';
import { openDB, DB_NAME, DB_VERSION, migrate, ValidationError } from '../js/db.js';
import { createBackup, parseBackup, BACKUP_VERSION } from '../js/backup.js';
import { createSettings, createAccount, createPeriod, createSubAccount } from '../js/models.js';
import { makeBook } from './helpers.js';

const L = (qty100, unitPrice, tax = '10', name = '作業') => ({ name, qty100, unit: '', unitPrice, tax });

/** 検証を通る請求書（科目は makeBook の個人のテンプレート） */
function sampleInvoice(b, fields = {}) {
  return {
    id: 'inv-1',
    kind: 'invoice',
    status: 'draft',
    number: '0001',
    issueDate: '2026-10-31',
    customer: { name: '株式会社ポケット商事', honorific: '御中', subAccountId: null },
    subject: '10月分',
    priceMode: 'exclusive',
    rounding: 'floor',
    lines: [L(100, 100000)],
    note: '',
    deliveryFrom: '2026-10-01',
    deliveryTo: '2026-10-31',
    dueDate: '2026-11-30',
    revenueAccountId: b.byName['売上高'].id,
    estimateId: null,
    journalId: null,
    issuedAt: null,
    voidedAt: null,
    createdAt: '2026-10-31T00:00:00.000Z',
    updatedAt: '2026-10-31T00:00:00.000Z',
    ...fields,
  };
}

test('入力の読み取り：数量（小数第2位まで）・単価（値引きはマイナス）・登録番号', () => {
  assert.deepEqual(parseQuantity('１.５'), { ok: true, value: 150 });
  assert.deepEqual(parseQuantity('1,000'), { ok: true, value: 100000 });
  assert.deepEqual(parseQuantity('0.25'), { ok: true, value: 25 });
  assert.match(parseQuantity('').error, /入力/);
  assert.match(parseQuantity('1.234').error, /小数第2位/);
  assert.match(parseQuantity('0').error, /0より大きい/);
  assert.match(parseQuantity('-1').error, /0より大きい/);
  assert.match(parseQuantity('100000').error, /99,999.99/);
  assert.equal(formatQuantity(150), '1.5');
  assert.equal(formatQuantity(200), '2');
  assert.equal(formatQuantity(1234505), '12,345.05');
  assert.deepEqual(parseUnitPrice('¥1,200'), { ok: true, value: 1200 });
  assert.deepEqual(parseUnitPrice('△500'), { ok: true, value: -500 });
  assert.match(parseUnitPrice('10.5').error, /1円単位/);
  assert.match(parseUnitPrice('abc').error, /数字/);
  assert.equal(normalizeRegistrationNo(' ｔ１２３４-５６７８-９０１２３ '), 'T1234567890123');
  assert.ok(isRegistrationNo('T1234567890123'));
  assert.ok(!isRegistrationNo('T123456789012'));
  assert.ok(!isRegistrationNo('1234567890123'));
});

test('明細の金額：数量×単価（1円未満は切り捨て）。大きな数でも誤差が出ない', () => {
  assert.equal(lineAmount(L(150, 1001)), 1501); // 1501.5 → 1501
  assert.equal(lineAmount(L(100, -500)), -500);
  assert.equal(lineAmount(L(150, -1001)), -1501); // 0 の方向へ
  assert.equal(lineAmount(L(9_999_999, 9_999_999_999)), 999_999_899_900_000); // 99,999.99 × 9,999,999,999（Number の掛け算では誤差が出る大きさ）
});

test('税率ごとの消費税額：端数処理は1枚の請求書につき税率ごとに1回（国税庁 Q&A 問57 の例）', () => {
  // 問57 の例：税込 10%対象 60,000円 → 5,454円、8%対象 40,000円 → 2,962円
  const t = invoiceTotals({ priceMode: 'inclusive', rounding: 'floor', lines: [L(100, 30000, '10'), L(100, 30000, '10'), L(100, 40000, '8r')] });
  assert.deepEqual(
    t.groups.map((g) => [g.code, g.gross, g.tax, g.net]),
    [
      ['10', 60000, 5454, 54546],
      ['8r', 40000, 2962, 37038],
    ],
  );
  assert.equal(t.total, 100000);
  assert.equal(t.tax, 8416);
  assert.ok(t.hasReduced);
  // 商品ごとに端数処理して足すのとは違う：105円×2 は 10円＋10円ではなく 21円
  const ex = invoiceTotals({ priceMode: 'exclusive', rounding: 'floor', lines: [L(100, 105), L(100, 105)] });
  assert.equal(ex.groups[0].tax, 21);
  assert.equal(ex.total, 231);
  // 端数処理の方法：切り捨て・四捨五入・切り上げ
  const one = (rounding) => invoiceTotals({ priceMode: 'exclusive', rounding, lines: [L(100, 1005)] }).groups[0].tax;
  assert.deepEqual([one('floor'), one('round'), one('ceil')], [100, 101, 101]);
  const eight = (rounding) => invoiceTotals({ priceMode: 'exclusive', rounding, lines: [L(100, 333, '8r')] }).groups[0].tax; // 26.64
  assert.deepEqual([eight('floor'), eight('round'), eight('ceil')], [26, 27, 27]);
  // 非課税・対象外は消費税なし。値引きは同じ税率の中で引く
  const mixed = invoiceTotals({ priceMode: 'exclusive', rounding: 'floor', lines: [L(100, 10000), L(100, -1000), L(100, 5000, 'exempt'), L(100, 800, 'none')] });
  assert.deepEqual(
    mixed.groups.map((g) => [g.code, g.net, g.tax, g.gross]),
    [
      ['10', 9000, 900, 9900],
      ['exempt', 5000, 0, 5000],
      ['none', 800, 0, 800],
    ],
  );
  assert.equal(mixed.total, 15700);
  assert.ok(!mixed.hasReduced);
});

test('請求書の検証：記載事項（宛名・取引年月日・明細）と金額', () => {
  const b = makeBook('individual', { subs: [['売掛金', 'A社'], ['普通預金', 'みらい銀行']] });
  const ctx = { accounts: b.accounts, subAccounts: b.subAccounts };
  const inv = sampleInvoice(b);
  assert.deepEqual(validateInvoice(inv, ctx), []);
  assert.deepEqual(validateInvoice({ ...inv, customer: { ...inv.customer, subAccountId: 'sub-0' } }, ctx), []);
  const errs = (patch) => validateInvoice({ ...inv, ...patch }, ctx).join('\n');
  assert.match(errs({ customer: { name: ' ', honorific: '御中' } }), /宛先（相手の名前）/);
  assert.match(errs({ customer: { name: 'A', honorific: 'さま' } }), /敬称/);
  assert.match(errs({ customer: { name: 'A', honorific: '', subAccountId: 'sub-1' } }), /売掛金の補助科目/); // 普通預金の補助は取引先にできない
  assert.match(errs({ number: '' }), /番号を入力/);
  assert.match(errs({ deliveryFrom: '' }), /取引年月日を入力/);
  assert.match(errs({ deliveryTo: '2026-09-30' }), /終わりは始めより後/);
  assert.match(errs({ lines: [] }), /明細を1行以上/);
  assert.match(errs({ lines: [L(100, 1000, '5')] }), /税率を選んで/);
  assert.match(errs({ lines: [{ ...L(100, 1000), name: '' }] }), /品名/);
  assert.match(errs({ lines: [L(100, 1000), L(100, -2000)] }), /税率ごとの合計がマイナス/);
  assert.match(errs({ lines: [L(100, 1000), L(100, -1000, '8r'), L(100, 1000, '8r')] }), /^$/); // 8% の中で相殺して0 はよい
  assert.match(errs({ lines: [L(100, 0)] }), /合計金額は1円以上/);
  assert.match(errs({ revenueAccountId: b.byName['現金'].id }), /売上の科目/);
  assert.match(errs({ priceMode: 'x' }), /税抜・税込/);
  assert.match(errs({ rounding: 'x' }), /端数処理/);
  // 見積書：取引年月日・売上の科目は要らない。状態は下書きだけ
  const est = { ...inv, kind: 'estimate', deliveryFrom: undefined, revenueAccountId: undefined, validUntil: '2026-11-30' };
  assert.deepEqual(validateInvoice(est, ctx), []);
  assert.match(validateInvoice({ ...est, status: 'issued' }, ctx).join(), /状態/);
  assert.match(validateInvoice({ ...inv, kind: 'receipt' }, ctx).join(), /請求書か見積書/);
  // 設定
  assert.deepEqual(validateInvoiceSettings(undefined), []);
  assert.deepEqual(validateInvoiceSettings({ registrationNo: 'T1234567890123', rounding: 'round', priceMode: 'inclusive' }), []);
  assert.match(validateInvoiceSettings({ registrationNo: 'T12' }).join(), /T」と13桁/);
  assert.match(validateInvoiceSettings({ rounding: 'up' }).join(), /端数処理/);
});

test('番号：末尾の数字に1を足す（前の部分と桁数はそのまま）。種類ごとに重ならない', () => {
  assert.equal(nextInvoiceNumber([], 'invoice'), '0001');
  const list = [
    { id: 'a', kind: 'invoice', number: 'INV-0099' },
    { id: 'b', kind: 'invoice', number: '7' },
    { id: 'c', kind: 'estimate', number: 'Q-12' },
    { id: 'd', kind: 'invoice', number: '請求書' },
  ];
  assert.equal(nextInvoiceNumber(list, 'invoice'), 'INV-0100');
  assert.equal(nextInvoiceNumber(list, 'estimate'), 'Q-13');
  assert.ok(isDuplicateNumber(list, { id: 'x', kind: 'invoice', number: ' 7 ' }));
  assert.ok(!isDuplicateNumber(list, { id: 'b', kind: 'invoice', number: '7' })); // 自分自身
  assert.ok(!isDuplicateNumber(list, { id: 'x', kind: 'estimate', number: '7' })); // 種類が違う
  const sorted = [
    { issueDate: '2026-10-01', number: '9' },
    { issueDate: '2026-10-31', number: '10' },
    { issueDate: '2026-10-31', number: '9' },
  ].sort(compareInvoices);
  assert.deepEqual(sorted.map((x) => x.number), ['10', '9', '9']);
});

test('売掛金の仕訳：借方 売掛金（取引先）／貸方 売上（税率ごとに1行・税込）。貸借が一致する', () => {
  const b = makeBook('individual', { subs: [['売掛金', 'A社']] });
  const inv = sampleInvoice(b, { customer: { name: 'A社', honorific: '御中', subAccountId: 'sub-0' }, lines: [L(100, 100000), L(200, 1500, '8r', 'お菓子'), L(100, 3000, 'exempt'), L(100, 500, 'none', '立替金')] });
  const j = invoiceJournal(inv, { accounts: b.accounts, subAccounts: b.subAccounts, periodId: b.period.id });
  assert.equal(j.date, '2026-10-31');
  assert.equal(j.source, 'invoice');
  assert.equal(j.sourceId, 'inv-1');
  assert.deepEqual(
    j.lines.map((l) => [l.side, b.accounts.find((a) => a.id === l.accountId).name, l.subAccountId, l.amount, l.taxCategory]),
    [
      ['debit', '売掛金', 'sub-0', 116740, 'none'],
      ['credit', '売上高', null, 110000, 'sales_10'],
      ['credit', '売上高', null, 3240, 'sales_8r'],
      ['credit', '売上高', null, 3000, 'sales_exempt'],
      ['credit', '売上高', null, 500, 'none'],
    ],
  );
  assert.match(j.lines[0].memo, /A社 請求書No\.0001 10月分/);
  assert.deepEqual(validateJournal(j, { accounts: b.accounts, subAccounts: b.subAccounts, period: b.period }), []);
  // 取引年月日が1日だけなら、その日
  assert.equal(postingDate({ deliveryFrom: '2026-10-15', deliveryTo: '' }), '2026-10-15');
  // 取引先を選ばなければ売掛金（補助なし）
  const plain = invoiceJournal(sampleInvoice(b), { accounts: b.accounts, subAccounts: b.subAccounts, periodId: b.period.id });
  assert.equal(plain.lines[0].subAccountId, null);
  assert.equal(b.accounts.find((a) => a.id === plain.lines[0].accountId).hint, 'receivable');
});

test('売掛金の仕訳を積上げ計算しても、請求書の消費税額と一致する（同じ端数処理なら）', () => {
  const b = makeBook('individual');
  for (const rounding of ['floor', 'round', 'ceil']) {
    for (const priceMode of ['exclusive', 'inclusive']) {
      for (let n = 1; n <= 400; n += 7) {
        const inv = sampleInvoice(b, { priceMode, rounding, lines: [L(100, n * 37 + 1), L(100, n * 13 + 5), L(100, n * 101 + 3, '8r')] });
        const t = invoiceTotals(inv);
        const j = invoiceJournal(inv, { accounts: b.accounts, subAccounts: b.subAccounts, periodId: b.period.id });
        const s = stackedTaxes([j], { from: '2026-01-01', to: '2026-12-31', salesRounding: rounding });
        assert.equal(s.s10, t.groups.find((g) => g.code === '10').tax, `${rounding} ${priceMode} ${n} 10%`);
        assert.equal(s.s8, t.groups.find((g) => g.code === '8r').tax, `${rounding} ${priceMode} ${n} 8%`);
      }
    }
  }
});

test('下書き・複製・見積書から請求書', () => {
  const b = makeBook('individual');
  const settings = createSettings({ businessName: 'テスト商店', taxStatus: 'taxable', invoice: { registrationNo: 'T1234567890123', priceMode: 'inclusive', rounding: 'round', note: '振込手数料はご負担ください' } });
  const d = invoiceDraft({ kind: 'invoice', number: '0001', today: '2026-10-31', settings, accounts: b.accounts });
  assert.equal(d.priceMode, 'inclusive');
  assert.equal(d.rounding, 'round');
  assert.equal(d.note, '振込手数料はご負担ください');
  assert.equal(d.deliveryFrom, '2026-10-31');
  assert.equal(d.revenueAccountId, b.byName['売上高'].id);
  assert.equal(d.lines[0].tax, '10');
  // 免税事業者で登録番号が無ければ、明細の税率の初期値は対象外
  assert.equal(invoiceDraft({ kind: 'estimate', number: '1', today: '2026-10-31', settings: createSettings({ taxStatus: 'exempt' }), accounts: b.accounts }).lines[0].tax, 'none');
  const est = { ...sampleInvoice(b), id: 'est-1', kind: 'estimate', number: 'Q-1', validUntil: '2026-11-30' };
  const fromEst = copyInvoice(est, { kind: 'invoice', number: '0002', today: '2026-11-05', accounts: b.accounts });
  assert.equal(fromEst.kind, 'invoice');
  assert.equal(fromEst.estimateId, 'est-1');
  assert.equal(fromEst.status, 'draft');
  assert.equal(fromEst.issueDate, '2026-11-05');
  assert.deepEqual(fromEst.lines, est.lines);
  assert.equal(fromEst.id, undefined);
});

async function setupRepo({ registered = true } = {}) {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('individual').map((a) => createAccount(a));
  const period = createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト商店', entityType: 'individual', taxStatus: 'taxable' }), period, accounts });
  const byName = Object.fromEntries(accounts.map((a) => [a.name, a]));
  const sub = await repo.saveSubAccount(createSubAccount({ accountId: byName['売掛金'].id, name: 'A社' }));
  if (registered) await repo.saveInvoiceSettings({ registrationNo: 'ｔ1234567890123', issuerName: ' ポケット屋 ', bank: 'みらい銀行 普通 1234567' });
  return { repo, byName, period, sub, b: { byName } };
}

test('Repository：請求書の設定（登録番号を整える・不正な番号は保存しない）', async () => {
  const { repo } = await setupRepo();
  const s = await repo.getSettings();
  assert.equal(s.invoice.registrationNo, 'T1234567890123');
  assert.equal(s.invoice.issuerName, 'ポケット屋');
  assert.equal(s.invoice.rounding, 'floor');
  assert.equal(s.invoice.priceMode, 'exclusive');
  await assert.rejects(repo.saveInvoiceSettings({ registrationNo: 'T999' }), (e) => e instanceof ValidationError && /13桁/.test(e.message));
  repo.close();
});

test('Repository：保存・番号の重なり・発行で売掛金を計上・発行後は変更できない・取消で仕訳を削除', async () => {
  const { repo, byName, period, sub } = await setupRepo();
  const base = sampleInvoice({ byName }, { id: undefined, customer: { name: 'A社', honorific: '御中', subAccountId: sub.id }, lines: [L(100, 100000), L(100, 2000, '8r', 'お菓子')] });
  const saved = await repo.saveInvoice(base);
  assert.ok(saved.id);
  assert.equal(saved.status, 'draft');
  // 同じ種類で同じ番号は保存しない。見積書なら同じ番号でもよい
  await assert.rejects(repo.saveInvoice({ ...base, id: undefined }), /もう使われています/);
  const est = await repo.saveInvoice({ ...base, id: undefined, kind: 'estimate', validUntil: '' });
  assert.equal(est.kind, 'estimate');
  // 発行：売掛金の仕訳を登録して発行済み
  const { invoice, journal } = await repo.issueInvoice(saved.id);
  assert.equal(invoice.status, 'issued');
  assert.equal(invoice.journalId, journal.id);
  assert.ok(invoice.issuedAt);
  assert.equal(journal.source, 'invoice');
  assert.equal(journal.voucherNo, 1);
  assert.equal(journal.periodId, period.id);
  assert.deepEqual(journal.lines.map((l) => l.amount), [112160, 110000, 2160]);
  assert.equal(journal.lines[0].subAccountId, sub.id);
  assert.equal((await repo.listJournals(period.id)).length, 1);
  // 発行済みは変更・削除・二重の計上ができない
  await assert.rejects(repo.saveInvoice({ ...invoice, subject: '変更' }), /変更できません/);
  await assert.rejects(repo.deleteInvoice(saved.id), /先に取り消して/);
  await assert.rejects(repo.issueInvoice(saved.id), /もう計上してあります/);
  // 仕訳を消したら、もう一度計上できる
  await repo.deleteJournal(journal.id);
  const again = await repo.issueInvoice(saved.id);
  assert.equal(again.invoice.issuedAt, invoice.issuedAt);
  assert.notEqual(again.journal.id, journal.id);
  // 取消：仕訳を削除して取消にする（訂正・削除の履歴に残る）
  const { invoice: voided, journal: removed } = await repo.voidInvoice(saved.id);
  assert.equal(voided.status, 'void');
  assert.ok(voided.voidedAt);
  assert.equal(removed.id, again.journal.id);
  assert.equal((await repo.listJournals(period.id)).length, 0);
  const history = await repo.listJournalHistory(period.id);
  assert.equal(history.filter((e) => e.action === 'delete' && e.journalId === again.journal.id).length, 1);
  await assert.rejects(repo.issueInvoice(saved.id), /取り消した請求書は発行できません/);
  await assert.rejects(repo.voidInvoice(saved.id), /発行済みの請求書だけ/);
  // 取消・下書きは削除できる（tombstone）
  await repo.deleteInvoice(saved.id);
  assert.equal(await repo.getInvoice(saved.id), undefined);
  const dump = await repo.dumpAll();
  assert.ok(dump.tombstones.some((t) => t.store === 'invoices' && t.id === saved.id));
  repo.close();
});

test('Repository：見積書から作った請求書は見積書に記録し、請求書を消したら外す', async () => {
  const { repo, byName } = await setupRepo();
  const est = await repo.saveInvoice({ ...sampleInvoice({ byName }), id: undefined, kind: 'estimate', number: 'Q-1', validUntil: '2026-11-30' });
  const inv = await repo.saveInvoice({ ...sampleInvoice({ byName }), id: undefined, estimateId: est.id });
  assert.equal((await repo.getInvoice(est.id)).invoiceId, inv.id);
  // 見積書を編集しても請求書の記録は残る
  await repo.saveInvoice({ ...(await repo.getInvoice(est.id)), subject: '見積の件名', invoiceId: null });
  assert.equal((await repo.getInvoice(est.id)).invoiceId, inv.id);
  await repo.deleteInvoice(inv.id);
  assert.equal((await repo.getInvoice(est.id)).invoiceId, null);
  repo.close();
});

test('Repository：取引年月日を含む会計期間が無い・締めてある期間には発行できない', async () => {
  const { repo, byName, period } = await setupRepo();
  const next = await repo.saveInvoice({ ...sampleInvoice({ byName }), id: undefined, number: '0002', deliveryFrom: '2027-01-10', deliveryTo: '' });
  await assert.rejects(repo.issueInvoice(next.id), /会計期間がありません/);
  const inv = await repo.saveInvoice({ ...sampleInvoice({ byName }), id: undefined });
  const { invoice } = await repo.issueInvoice(inv.id);
  await repo.createNextPeriod(createPeriod({ startDate: '2027-01-01', endDate: '2027-12-31' }), []);
  await repo.closePeriod(period.id);
  await assert.rejects(repo.voidInvoice(invoice.id), /締めてあるため取り消せません/);
  const other = await repo.saveInvoice({ ...sampleInvoice({ byName }), id: undefined, number: '0003' });
  await assert.rejects(repo.issueInvoice(other.id), /締めてあるため/);
  repo.close();
});

test('バックアップ：請求書と請求書の設定が往復し、8 から 9 への変換で請求書が空になる。不正な請求書は拒否', async () => {
  const { repo, byName } = await setupRepo();
  const inv = await repo.saveInvoice({ ...sampleInvoice({ byName }), id: undefined });
  await repo.issueInvoice(inv.id);
  const backup = createBackup(await repo.dumpAll());
  assert.equal(backup.version, BACKUP_VERSION);
  assert.equal(BACKUP_VERSION, 9);
  const parsed = parseBackup(JSON.stringify(backup));
  assert.equal(parsed.invoices.length, 1);
  assert.equal(parsed.invoices[0].status, 'issued');
  assert.equal(parsed.settings.invoice.registrationNo, 'T1234567890123');
  const other = await openDB({ indexedDB: new IDBFactory() });
  await other.replaceAll(parsed);
  assert.deepEqual(await other.listInvoices(), await repo.listInvoices());
  other.close();
  // 旧形式（8）：請求書のストアが無い
  const v8 = { ...backup, version: 8 };
  delete v8.invoices;
  delete v8.settings.invoice;
  assert.deepEqual(parseBackup(JSON.stringify(v8)).invoices, []);
  // 不正な請求書・設定
  assert.throws(() => parseBackup(JSON.stringify({ ...backup, invoices: [{ ...backup.invoices[0], lines: [] }] })), /請求書・見積書のデータが不正/);
  assert.throws(() => parseBackup(JSON.stringify({ ...backup, settings: { ...backup.settings, invoice: { registrationNo: 'X' } } })), /請求書の設定が不正/);
  repo.close();
});

test('スキーマ移行：バージョン8のデータを残したまま請求書のストアを追加する', async () => {
  const idb = new IDBFactory();
  await new Promise((resolve, reject) => {
    const open = idb.open(DB_NAME, 8);
    open.onupgradeneeded = () => {
      migrate(open.result, 0, open.transaction);
      open.result.deleteObjectStore('invoices'); // バージョン8の構成にする
      open.transaction.objectStore('departments').put({ id: 'd1', name: '本店', active: true, sortOrder: 0, createdAt: 'x', updatedAt: 'x' });
    };
    open.onsuccess = () => {
      open.result.close();
      resolve();
    };
    open.onerror = () => reject(open.error);
  });
  const repo = await openDB({ indexedDB: idb });
  assert.equal(repo.db.version, DB_VERSION);
  assert.equal(DB_VERSION, 9);
  assert.equal((await repo.listDepartments())[0].id, 'd1');
  assert.deepEqual(await repo.listInvoices(), []);
  repo.close();
});

test('一覧の CSV：税率ごとの合計・消費税・状態（金額は -1000 形式）', () => {
  const b = makeBook('individual');
  const inv = sampleInvoice(b, { status: 'issued', issuedAt: 'x', lines: [L(100, 100000), L(100, 2000, '8r'), L(100, 500, 'none')] });
  const est = { ...sampleInvoice(b), kind: 'estimate', number: 'Q-1', validUntil: '2026-11-30', invoiceId: 'inv-1' };
  const lines = invoicesCsv([inv, est]).replace(/^﻿/, '').trim().split(/\r?\n/);
  assert.equal(lines[0], '種類,番号,発行日,取引年月日,支払期限・有効期限,宛先,件名,10%対象（税込）,10%の消費税,8%対象（税込）,8%の消費税,非課税・対象外,合計（税込）,状態');
  assert.equal(lines[1], '請求書,0001,2026/10/31,2026/10/01〜2026/10/31,2026/11/30,株式会社ポケット商事 御中,10月分,110000,10000,2160,160,500,112660,発行済み');
  assert.equal(lines[2], '見積書,Q-1,2026/10/31,,2026/11/30,株式会社ポケット商事 御中,10月分,110000,10000,0,0,0,110000,請求書を作成済み');
});
