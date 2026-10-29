import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { allocateYen, validateDepartment, compareDepartments, usedDepartmentIds, departmentIncome, MAX_DEPARTMENT_NAME } from '../js/departments.js';
import { validateJournal, rowsToLines, linesToRows, matchJournal } from '../js/journal.js';
import { validateTemplate, linesForTemplate } from '../js/templates.js';
import { incomeStatement } from '../js/statements.js';
import { trialBalance } from '../js/ledger.js';
import { isBsGroup, templateAccounts } from '../js/accounts.js';
import { openDB, DB_NAME, DB_VERSION, migrate, ValidationError } from '../js/db.js';
import { createBackup, parseBackup, BACKUP_VERSION } from '../js/backup.js';
import { journalsCsv, monthlyCsv } from '../js/csv.js';
import { yayoiRows } from '../js/yayoi.js';
import { buildSample } from '../js/sample.js';
import { createDepartment, createSettings, createAccount, createPeriod, createJournal, createTemplate } from '../js/models.js';
import { makeBook } from './helpers.js';

/** 仕訳の明細に部門を付ける（deps は明細の順の部門 id、null は付けない） */
const withDeps = (j, deps) => ({ ...j, lines: j.lines.map((l, i) => (deps[i] ? { ...l, departmentId: deps[i] } : l)) });
const sumOf = (xs) => xs.reduce((s, x) => s + x, 0);
const lineOf = (res, name) => res.items.flatMap((it) => (it.type === 'group' ? it.lines : [])).find((l) => l.account.name === name);
const subtotalOf = (res, label) => res.items.find((it) => it.type === 'subtotal' && it.label === label);

test('配賦（最大剰余法）：合計が必ず元の金額に一致し、重み0には配らない', () => {
  assert.deepEqual(allocateYen(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocateYen(-100, [1, 1, 1]), [-34, -33, -33]);
  assert.deepEqual(allocateYen(1000, [3, 0, 1]), [750, 0, 250]);
  assert.deepEqual(allocateYen(1, [1, 2]), [0, 1]);
  assert.deepEqual(allocateYen(0, [1, 2]), [0, 0]);
  assert.deepEqual(allocateYen(500, [0, 0]), [0, 0]);
  // 金額×重みが Number の精度を超える大きさでも1円も狂わない
  const big = allocateYen(999999999999, [987654321987, 123456789123, 1]);
  assert.equal(sumOf(big), 999999999999);
  assert.ok(big.every(Number.isInteger));
  for (let n = 1; n <= 50; n++) {
    const parts = allocateYen(n * 7 + 3, [5, 3, 2, 0, 9]);
    assert.equal(sumOf(parts), n * 7 + 3);
    assert.equal(parts[3], 0);
  }
});

test('部門の検証・並び順・使っている部門', () => {
  const a = createDepartment({ name: '本店', sortOrder: 1 });
  const b = createDepartment({ name: 'ネット販売', sortOrder: 0 });
  assert.deepEqual(validateDepartment(a, [a, b]), {});
  assert.match(validateDepartment({ ...a, name: '  ' }).name, /入力/);
  assert.match(validateDepartment({ ...a, name: 'あ'.repeat(MAX_DEPARTMENT_NAME + 1) }).name, /20文字以内/);
  assert.match(validateDepartment({ ...a, name: 'ネット販売' }, [a, b]).name, /同じ名前/);
  assert.ok(validateDepartment({ ...a, active: 'yes' }).active);
  assert.ok(validateDepartment({ ...a, sortOrder: -1 }).sortOrder);
  assert.ok(validateDepartment({ ...a, sortOrder: 1.5 }).sortOrder);
  assert.deepEqual([a, b].sort(compareDepartments).map((d) => d.name), ['ネット販売', '本店']);
  assert.deepEqual([...usedDepartmentIds([{ lines: [{ departmentId: a.id }, {}] }, { lines: [{ departmentId: '' }] }])], [a.id]);
});

test('仕訳の検証：部門があるか、使わない部門は元から付いていた明細だけ可', () => {
  const b = makeBook('individual');
  const shop = createDepartment({ name: '店舗' });
  const old = createDepartment({ name: '旧店舗', active: false });
  const departments = [shop, old];
  const ctx = { accounts: b.accounts, subAccounts: b.subAccounts, period: b.period, departments };
  const j = b.j('2026-02-01', [['現金', 1000]], [['売上高', 1000]]);
  assert.deepEqual(validateJournal(withDeps(j, [null, shop.id]), ctx), []);
  assert.match(validateJournal(withDeps(j, [null, 'nope']), ctx)[0], /部門が見つかりません/);
  const inactive = withDeps(j, [null, old.id]);
  assert.match(validateJournal(inactive, ctx)[0], /旧店舗」は使わない設定/);
  assert.deepEqual(validateJournal(inactive, { ...ctx, original: inactive }), []);
  // departments を渡さない検証（画面の途中など）では部門を見ない
  assert.deepEqual(validateJournal(withDeps(j, [null, 'nope']), { ...ctx, departments: null }), []);
  // 定型仕訳
  const t = createTemplate({ name: '店頭売上', lines: linesForTemplate(withDeps(j, [null, shop.id]).lines) });
  assert.equal(t.lines[1].departmentId, shop.id);
  assert.equal(t.lines[0].departmentId, undefined);
  assert.deepEqual(validateTemplate(t, { accounts: b.accounts, subAccounts: [], departments }), []);
  assert.match(validateTemplate(t, { accounts: b.accounts, subAccounts: [], departments: [old] })[0], /部門が見つかりません/);
});

test('画面の行と明細の変換で部門を保ち、部門の無い明細には項目を付けない', () => {
  const b = makeBook('individual');
  const shop = createDepartment({ name: '店舗' });
  const j = withDeps(b.j('2026-02-01', [['消耗品費', 3300]], [['現金', 3300]], '文具'), [shop.id]);
  const rows = linesToRows(j.lines);
  assert.equal(rows[0].debit.departmentId, shop.id);
  assert.equal(rows[0].credit.departmentId, '');
  const { lines } = rowsToLines(rows);
  assert.equal(lines[0].departmentId, shop.id);
  assert.ok(!('departmentId' in lines[1]));
  // 検索：部門名でも見つかる
  const normalize = (s) => s;
  const accountById = new Map(b.accounts.map((a) => [a.id, a]));
  assert.equal(matchJournal(j, '店舗', { accountById, subById: new Map(), normalize, departmentById: new Map([[shop.id, shop]]) }), true);
  assert.equal(matchJournal(j, '店舗', { accountById, subById: new Map(), normalize }), false);
});

function sampleBook(entityType = 'individual') {
  const b = makeBook(entityType, entityType === 'corporation' ? { startDate: '2026-04-01', endDate: '2027-03-31' } : {});
  const design = createDepartment({ name: 'デザイン', sortOrder: 0 });
  const shop = createDepartment({ name: '店舗', sortOrder: 1 });
  const journals = [
    withDeps(b.j('2026-05-10', [['売掛金', 300000]], [['売上高', 300000]]), [null, design.id]),
    withDeps(b.j('2026-05-15', [['現金', 100000]], [['売上高', 100000]]), [null, shop.id]),
    withDeps(b.j('2026-05-16', [['仕入高', 40000]], [['現金', 40000]]), [shop.id]),
    withDeps(b.j('2026-05-20', [[entityType === 'corporation' ? '外注費' : '外注工賃', 50000]], [['普通預金', 50000]]), [design.id]),
    // 共通：家賃・通信費
    b.j('2026-05-27', [['地代家賃', 70001]], [['普通預金', 70001]]),
    b.j('2026-05-28', [['通信費', 9999]], [['普通預金', 9999]]),
    // 部門を付けた貸借対照表の科目は集計しない
    withDeps(b.j('2026-06-01', [['普通預金', 1000]], [['現金', 1000]]), [design.id]),
  ];
  return { b, design, shop, journals, departments: [design, shop] };
}

/** 部門を付けない損益計算書（試算表から） */
function plainIncome(entityType, b, journals) {
  const rows = trialBalance({ accounts: b.accounts, period: b.period, journals })
    .rows.filter((r) => !isBsGroup(r.account.group))
    .map((r) => ({ account: r.account, dc: r.debit - r.credit }));
  return incomeStatement(entityType, rows);
}

test('部門別損益（配賦しない）：部門と共通の列、合計は損益計算書と一致', () => {
  const { b, design, shop, journals, departments } = sampleBook();
  const res = departmentIncome({ entityType: 'individual', accounts: b.accounts, period: b.period, journals, departments });
  assert.deepEqual(res.columns.map((c) => c.label), ['デザイン', '店舗', '共通（部門なし）']);
  assert.deepEqual(res.allocation, { basis: 'none', applied: false, note: '' });
  assert.deepEqual(lineOf(res, '売上高').values, [300000, 100000, 0]);
  assert.deepEqual(lineOf(res, '地代家賃').values, [0, 0, 70001]);
  const income = subtotalOf(res, '青色申告特別控除前の所得金額');
  assert.deepEqual(income.values, [250000, 60000, -80000]);
  assert.equal(income.total, 230000);
  assert.equal(sumOf(income.values), income.total);
  const plain = plainIncome('individual', b, journals);
  assert.equal(res.total.netIncome, plain.netIncome);
  assert.equal(res.statements[0].profits.sales, 300000);
  assert.equal(res.columns[0].department.id, design.id);
  assert.equal(res.columns[1].department.id, shop.id);
  // すべての行で、列の合計＝合計の列
  for (const it of res.items) {
    if (it.type === 'group') for (const l of it.lines) assert.equal(sumOf(l.values), l.total, l.account.name);
    else assert.equal(sumOf(it.values), it.total, it.label);
  }
  // 範囲：5月15日までなら店舗の仕入は入らない
  const part = departmentIncome({ entityType: 'individual', accounts: b.accounts, period: b.period, journals, departments, from: '2026-05-01', to: '2026-05-15' });
  assert.deepEqual(lineOf(part, '仕入高').values, [0, 0]);
  assert.deepEqual(part.columns.map((c) => c.label), ['デザイン', '店舗']);
});

test('部門別損益（売上高の割合・均等）：共通を科目ごとに配り、1円もずれない', () => {
  const { b, journals, departments } = sampleBook();
  const ctx = { entityType: 'individual', accounts: b.accounts, period: b.period, journals, departments };
  const sales = departmentIncome({ ...ctx, allocation: 'sales' });
  assert.deepEqual(sales.columns.map((c) => c.label), ['デザイン', '店舗']);
  assert.equal(sales.allocation.applied, true);
  // 売上高 300,000：100,000 ＝ 3：1
  assert.deepEqual(lineOf(sales, '地代家賃').values, [52501, 17500]);
  assert.deepEqual(lineOf(sales, '通信費').values, [7499, 2500]);
  const income = subtotalOf(sales, '青色申告特別控除前の所得金額');
  assert.equal(sumOf(income.values), 230000);
  assert.equal(income.total, 230000);
  const equal = departmentIncome({ ...ctx, allocation: 'equal' });
  assert.deepEqual(lineOf(equal, '地代家賃').values, [35001, 35000]);
  assert.deepEqual(lineOf(equal, '通信費').values, [5000, 4999]);
  // 部門の売上高が無いと、売上高の割合では配れない
  const noSales = journals.filter((j) => !j.lines.some((l) => l.departmentId && b.accounts.find((a) => a.id === l.accountId).group === 'sales'));
  const res = departmentIncome({ ...ctx, journals: noSales, allocation: 'sales' });
  assert.equal(res.allocation.applied, false);
  assert.match(res.allocation.note, /売上高のある部門がない/);
  assert.equal(res.columns.at(-1).label, '共通（部門なし）');
  // 部門が無ければ共通だけ
  const none = departmentIncome({ ...ctx, departments: [], allocation: 'equal' });
  assert.deepEqual(none.columns.map((c) => c.label), ['共通（部門なし）']);
  assert.match(none.allocation.note, /部門がない/);
});

test('部門別損益：使わない部門は金額がある期間だけ出し、法人は段階利益で集計する', () => {
  const { b, journals, departments } = sampleBook('corporation');
  const [design, shop] = departments;
  const inactive = [design, { ...shop, active: false }];
  const res = departmentIncome({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals, departments: inactive });
  assert.deepEqual(res.columns.map((c) => c.label), ['デザイン', '店舗', '共通（部門なし）']);
  const empty = departmentIncome({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals: journals.filter((j) => !j.lines.some((l) => l.departmentId === shop.id)), departments: inactive });
  assert.deepEqual(empty.columns.map((c) => c.label), ['デザイン', '共通（部門なし）']);
  const op = subtotalOf(res, '営業利益');
  assert.equal(sumOf(op.values), op.total);
  assert.equal(res.total.netIncome, plainIncome('corporation', b, journals).netIncome);
  // CSV：部門名の見出しと合計
  const csv = monthlyCsv(res.items, [], { total: true, labels: res.columns.map((c) => c.label) });
  assert.match(csv, /項目,デザイン,店舗,共通（部門なし）,合計/);
});

async function setupRepo() {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('individual').map((a) => createAccount(a));
  const period = createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト商店', entityType: 'individual' }), period, accounts });
  const byName = Object.fromEntries(accounts.map((a) => [a.name, a]));
  return { repo, byName, period };
}

test('Repository：部門の追加・名前の重複・並び替え・使っている部門は削除できない・tombstone', async () => {
  const { repo, byName, period } = await setupRepo();
  const shop = await repo.saveDepartment(createDepartment({ name: ' 店舗 ' }));
  assert.equal(shop.name, '店舗');
  const net = await repo.saveDepartment(createDepartment({ name: 'ネット', sortOrder: 1 }));
  await assert.rejects(repo.saveDepartment(createDepartment({ name: '店舗' })), (e) => e instanceof ValidationError && /同じ名前/.test(e.errors.name));
  const renamed = await repo.saveDepartment({ ...net, name: 'ネット販売' });
  assert.equal(renamed.createdAt, net.createdAt);
  await repo.reorderDepartments([net.id, shop.id]);
  assert.deepEqual((await repo.listDepartments()).map((d) => d.name), ['ネット販売', '店舗']);
  // 仕訳に付ける。存在しない部門・使わない部門は保存できない
  const j = createJournal({ periodId: period.id, date: '2026-03-01', lines: [
    { side: 'debit', accountId: byName['現金'].id, amount: 5000, taxCategory: 'none', memo: '' },
    { side: 'credit', accountId: byName['売上高'].id, amount: 5000, taxCategory: 'sales_10', memo: '', departmentId: shop.id },
  ] });
  const saved = await repo.saveJournal(j);
  assert.equal(saved.lines[1].departmentId, shop.id);
  await assert.rejects(repo.saveJournal(createJournal({ periodId: period.id, date: '2026-03-01', lines: j.lines.map((l) => (l.departmentId ? { ...l, departmentId: 'x' } : l)) })), /部門が見つかりません/);
  assert.ok((await repo.departmentUsage()).has(shop.id));
  await assert.rejects(repo.deleteDepartment(shop.id), /使われているため削除できません/);
  // 使わないにしても、元から付いていた仕訳は直せる
  await repo.saveDepartment({ ...shop, active: false });
  await repo.saveJournal({ ...saved, lines: saved.lines.map((l) => ({ ...l, memo: '修正' })) });
  await assert.rejects(repo.saveJournal(createJournal({ periodId: period.id, date: '2026-03-02', lines: j.lines })), /使わない設定/);
  // 使っていない部門は削除でき、tombstone が残る
  await repo.deleteDepartment(net.id);
  assert.deepEqual((await repo.listDepartments()).map((d) => d.name), ['店舗']);
  const dump = await repo.dumpAll();
  assert.ok(dump.tombstones.some((t) => t.store === 'departments' && t.id === net.id));
  // バックアップ：部門を含み、往復で同じ。バージョン6は空で読み込む。不正な部門・存在しない部門の仕訳は拒否
  const backup = createBackup(dump);
  assert.equal(backup.version, BACKUP_VERSION);
  assert.ok(BACKUP_VERSION >= 7);
  const parsed = parseBackup(JSON.stringify(backup));
  assert.deepEqual(parsed.departments.map((d) => d.name), ['店舗']);
  const { departments: _omit, ...v6 } = backup;
  const noDepJournals = v6.journals.map((x) => ({ ...x, lines: x.lines.map(({ departmentId: _d, ...l }) => l) }));
  assert.deepEqual(parseBackup(JSON.stringify({ ...v6, journals: noDepJournals, version: 6 })).departments, []);
  assert.throws(() => parseBackup(JSON.stringify({ ...backup, departments: [{ ...backup.departments[0], name: '' }] })), /部門/);
  assert.throws(() => parseBackup(JSON.stringify({ ...backup, departments: [] })), /部門が見つかりません/);
  // 復元で置き換える
  await repo.replaceAll(parsed);
  assert.deepEqual((await repo.listDepartments()).map((d) => d.name), ['店舗']);
  repo.close();
});

test('定型仕訳で使っている部門は削除できない', async () => {
  const { repo, byName } = await setupRepo();
  const dep = await repo.saveDepartment(createDepartment({ name: '店舗' }));
  await repo.saveTemplate(createTemplate({ name: '仕入', lines: [
    { side: 'debit', accountId: byName['仕入高'].id, subAccountId: null, amount: 0, taxCategory: 'purchase_10', memo: '', departmentId: dep.id },
    { side: 'credit', accountId: byName['現金'].id, subAccountId: null, amount: 0, taxCategory: 'none', memo: '' },
  ] }));
  await assert.rejects(repo.deleteDepartment(dep.id), /定型仕訳で使われている/);
  await assert.rejects(repo.saveTemplate(createTemplate({ name: '誤り', lines: [
    { side: 'debit', accountId: byName['仕入高'].id, subAccountId: null, amount: 0, taxCategory: 'purchase_10', memo: '', departmentId: 'none' },
    { side: 'credit', accountId: byName['現金'].id, subAccountId: null, amount: 0, taxCategory: 'none', memo: '' },
  ] })), /部門が見つかりません/);
  repo.close();
});

test('スキーマ移行：バージョン6のデータを残したまま部門のストアを追加する', async () => {
  const idb = new IDBFactory();
  await new Promise((resolve, reject) => {
    const open = idb.open(DB_NAME, 6);
    open.onupgradeneeded = () => {
      migrate(open.result, 0, open.transaction);
      open.result.deleteObjectStore('departments'); // バージョン6の構成にする
      open.result.deleteObjectStore('invoices'); // バージョン9で追加
      open.transaction.objectStore('templates').put({ id: 't1', name: '家賃', lines: [], repeatDay: null, createdAt: 'x', updatedAt: 'x' });
    };
    open.onsuccess = () => {
      open.result.close();
      resolve();
    };
    open.onerror = () => reject(open.error);
  });
  const repo = await openDB({ indexedDB: idb });
  assert.equal(repo.db.version, DB_VERSION);
  assert.ok(DB_VERSION >= 7);
  assert.ok(repo.db.objectStoreNames.contains('departments'));
  assert.equal((await repo.listTemplates())[0].name, '家賃');
  assert.deepEqual(await repo.listDepartments(), []);
  repo.close();
});

test('仕訳帳の CSV・弥生会計の形式に部門を出す（部門が無ければ仕訳帳の列は増やさない）', () => {
  const b = makeBook('individual');
  const shop = createDepartment({ name: '店舗' });
  const j = withDeps(b.j('2026-02-01', [['現金', 1100]], [['売上高', 1100]], '店頭'), [null, shop.id]);
  const accountById = new Map(b.accounts.map((a) => [a.id, a]));
  const departmentById = new Map([[shop.id, shop]]);
  const withDep = journalsCsv([j], { accountById, subById: new Map(), departmentById });
  const head = withDep.replace(/^﻿/, '').split('\r\n')[0].split(',');
  assert.ok(head.includes('借方部門') && head.includes('貸方部門'));
  const row = withDep.replace(/^﻿/, '').split('\r\n')[1].split(',');
  assert.equal(row[head.indexOf('貸方部門')], '店舗');
  assert.equal(row[head.indexOf('借方部門')], '');
  const plain = journalsCsv([j], { accountById, subById: new Map() });
  assert.ok(!plain.includes('部門'));
  // 弥生会計：借方部門は7列目、貸方部門は13列目（0始まりで6・12）
  const [y] = yayoiRows([j], { accountById, subById: new Map(), period: b.period, departmentById });
  assert.equal(y[6], '');
  assert.equal(y[12], '店舗');
});

test('サンプルデータ（個人）に部門が入り、バックアップの検証を通る', () => {
  const data = buildSample('individual');
  assert.deepEqual(data.departments.map((d) => d.name), ['デザイン', '店舗']);
  const parsed = parseBackup(JSON.stringify(createBackup(data)));
  assert.equal(parsed.departments.length, 2);
  const res = departmentIncome({ entityType: 'individual', accounts: parsed.accounts, period: parsed.periods[0], journals: parsed.journals, departments: parsed.departments, allocation: 'sales' });
  assert.equal(res.allocation.applied, true);
  assert.ok(res.statements.every((s) => s.profits.sales > 0));
  assert.deepEqual(buildSample('corporation').departments, []);
});
