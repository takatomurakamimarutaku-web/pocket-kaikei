// 製造原価報告書（法人）：科目の追加・集計・損益計算書への接続・期末棚卸・償却費の科目・保存
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { manufacturingAccounts, templateAccounts, MFG_GROUPS } from '../js/accounts.js';
import { closingRows, manufacturingReport, incomeStatement, buildStatements, MFG_COST_LINE } from '../js/statements.js';
import { monthlyManufacturing, monthlyIncome } from '../js/monthly.js';
import { inventorySets, inventoryJournalLines, findInventoryJournals, carryForwardBalances } from '../js/closing.js';
import { depreciationLines, validateAsset } from '../js/depreciation.js';
import { slotCandidates, QUICK_BY_ID } from '../js/quick.js';
import { manufacturingCsv } from '../js/csv.js';
import { validateJournal } from '../js/journal.js';
import { createAsset, createAccount, createJournal, createPeriod, createSettings } from '../js/models.js';
import { openDB, ValidationError } from '../js/db.js';
import { makeBook } from './helpers.js';

const corp = { startDate: '2026-04-01', endDate: '2027-03-31', manufacturing: true };

test('製造原価の科目：法人テンプレートに足りない分だけ追加し、2回目は何も足さない。コードが使われていれば次の番号', () => {
  const base = templateAccounts('corporation');
  const added = manufacturingAccounts(base);
  assert.equal(added.length, 26);
  assert.ok(added.every((a) => !a.template && a.active));
  assert.deepEqual([...new Set(added.filter((a) => MFG_GROUPS.includes(a.group)).map((a) => a.group))], MFG_GROUPS);
  // 期末の棚卸高は評価勘定（貸方残）
  for (const hint of ['closing_materials', 'closing_wip', 'closing_finished']) assert.equal(added.find((a) => a.hint === hint).normalSide, 'credit');
  assert.deepEqual(manufacturingAccounts([...base, ...added]), []);
  // 利用者が 142 を使っていたら、製品は 145（142〜144 は埋まる）
  const taken = [...base, { code: '142', name: '自分の科目', hint: null }];
  const moved = manufacturingAccounts(taken);
  assert.equal(moved.find((a) => a.hint === 'finished_goods').code, '143');
  assert.equal(new Set([...taken, ...moved].map((a) => a.code)).size, taken.length + moved.length);
});

/** 製造業の1年：材料仕入・賃金・外注加工・電力、製品の売上、期末に棚卸 */
function factoryYear() {
  const book = makeBook('corporation', corp);
  const { j, byName, accounts, period } = book;
  book.opening([
    ['普通預金', 5000000],
    ['原材料', 300000],
    ['仕掛品', 200000],
    ['製品', 400000],
    ['資本金', 5900000],
  ]);
  const journals = [
    j('2026-04-10', [['材料仕入高', 1200000]], [['普通預金', 1200000]]),
    j('2026-04-25', [['賃金', 800000]], [['普通預金', 800000]]),
    j('2026-05-20', [['外注加工費', 300000]], [['普通預金', 300000]]),
    j('2026-05-31', [['電力費', 100000]], [['普通預金', 100000]]),
    j('2026-06-30', [['給料手当', 250000]], [['普通預金', 250000]]),
    j('2026-09-30', [['普通預金', 4000000]], [['売上高', 4000000]]),
  ];
  const tb = closingRows({ accounts, period, journals });
  const bal = (name) => tb.find((r) => r.account.id === byName[name].id).closing;
  const sets = inventorySets(accounts);
  const closing = { goods: 0, materials: 250000, wip: 150000, finished: 500000 };
  const lines = inventoryJournalLines(sets.map((set) => ({ set, balance: bal(set.goods.name), closingAmount: closing[set.kind.id] })));
  const inv = createJournal({ periodId: period.id, no: 99, date: '2027-03-31', lines, source: 'inventory' });
  return { ...book, journals: [...journals, inv], inv };
}

test('製造原価報告書：材料費＝期首材料＋仕入−期末材料、当期製品製造原価＝総製造費用＋期首仕掛品−期末仕掛品', () => {
  const { accounts, period, journals, inv, subAccounts } = factoryYear();
  assert.deepEqual(validateJournal(inv, { accounts, subAccounts, period }), []);
  const r = manufacturingReport(closingRows({ accounts, period, journals }));
  assert.equal(r.used, true);
  const [materials, labor, overhead] = r.items;
  assert.equal(materials.total, 300000 + 1200000 - 250000); // 1,250,000
  assert.equal(labor.total, 800000);
  assert.equal(overhead.total, 300000 + 100000);
  assert.equal(r.totalCost, 2450000);
  assert.equal(r.cost, 2450000 + 200000 - 150000); // 2,500,000
  const label = (l) => r.items.find((x) => x.label === l).amount;
  assert.equal(label('期首仕掛品棚卸高'), 200000);
  assert.equal(label('合計'), 2650000);
  assert.equal(label('期末仕掛品棚卸高'), -150000);
});

test('損益計算書：売上原価に当期製品製造原価が入り、貸借対照表の資産合計＝負債・純資産合計', () => {
  const { accounts, period, journals } = factoryYear();
  const { pl, bs } = buildStatements({ entityType: 'corporation', accounts, period, journals });
  const cogs = pl.items[1];
  const names = cogs.lines.map((l) => l.account.name);
  assert.ok(names.indexOf('当期製品製造原価') > names.indexOf('期首製品棚卸高'));
  assert.ok(names.indexOf('当期製品製造原価') < names.indexOf('期末製品棚卸高'));
  // 売上原価＝期首製品 400,000＋製造原価 2,500,000−期末製品 500,000
  assert.equal(cogs.total, 2400000);
  assert.equal(pl.profits.gross, 4000000 - 2400000);
  assert.equal(pl.netIncome, 1600000 - 250000);
  assert.equal(bs.balanced, true);
  assert.equal(bs.totalAssets, 5000000 - 1200000 - 800000 - 300000 - 100000 - 250000 + 4000000 + 250000 + 150000 + 500000);
  // 繰越：当期純利益を繰越利益剰余金へ
  const { netIncome } = carryForwardBalances({ entityType: 'corporation', accounts, period, journals });
  assert.equal(netIncome, 1350000);
});

test('製造原価の科目がない法人は、売上原価に当期製品製造原価の行を出さない', () => {
  const { accounts, period, j } = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  const rows = closingRows({ accounts, period, journals: [j('2026-05-01', [['仕入高', 1000]], [['現金', 1000]])] });
  assert.equal(manufacturingReport(rows).used, false);
  assert.ok(!incomeStatement('corporation', rows).items[1].lines.some((l) => l.account === MFG_COST_LINE));
});

test('製造原価の月次推移：月の合計が期間の報告書と一致し、損益の月次推移の売上原価にも入る', () => {
  const { accounts, period, journals } = factoryYear();
  const m = monthlyManufacturing({ accounts, period, journals });
  const r = manufacturingReport(closingRows({ accounts, period, journals }));
  assert.equal(m.months.length, 12);
  assert.equal(m.cost.reduce((s, v) => s + v, 0), r.cost);
  assert.equal(m.items.at(-1).total, r.cost);
  assert.equal(m.items[0].values[0], 1200000); // 4月の材料費（仕入）
  const income = monthlyIncome({ entityType: 'corporation', accounts, period, journals });
  assert.equal(income.items[1].total, 2400000);
});

test('期末棚卸：種類ごとに期首の在庫を費用へ、期末の在庫を戻す。登録済みの判定は製造の棚卸高の科目も見る', () => {
  const { accounts, journals, inv, byName } = factoryYear();
  assert.deepEqual(inventorySets(accounts).map((s) => s.kind.id), ['goods', 'materials', 'wip', 'finished']);
  const amount = (side, name) => inv.lines.filter((l) => l.side === side && l.accountId === byName[name].id).reduce((s, l) => s + l.amount, 0);
  assert.equal(amount('debit', '期首材料棚卸高'), 300000);
  assert.equal(amount('credit', '期末仕掛品棚卸高'), 150000);
  assert.equal(amount('debit', '製品'), 500000);
  assert.ok(inv.lines.every((l) => l.memo.startsWith('決算整理 棚卸（')));
  assert.deepEqual(findInventoryJournals(journals, accounts), [inv]);
});

test('償却費の科目：工場の機械は減価償却費（製造）に計上し、販管費・製造経費以外の科目は拒否する', () => {
  const { accounts, byName, period } = makeBook('corporation', corp);
  const machine = createAsset({ name: '旋盤', category: 'machinery', accountId: byName['機械装置'].id, acquiredOn: '2026-04-01', startedOn: '2026-04-01', cost: 1200000, method: 'straight', usefulLife: 10, expenseAccountId: byName['減価償却費（製造）'].id });
  const pc = createAsset({ name: 'パソコン', category: 'tools', accountId: byName['工具器具備品'].id, acquiredOn: '2026-04-01', startedOn: '2026-04-01', cost: 200000, method: 'straight', usefulLife: 4 });
  assert.deepEqual(validateAsset(machine, { entityType: 'corporation', accounts }), {});
  assert.ok(validateAsset({ ...machine, expenseAccountId: byName['売上高'].id }, { entityType: 'corporation', accounts }).expenseAccountId);
  const { lines, errors } = depreciationLines({ assets: [machine, pc], periods: [period], period, accounts, entityType: 'corporation' });
  assert.deepEqual(errors, []);
  const debit = (name) => lines.find((l) => l.side === 'debit' && l.accountId === byName[name].id)?.amount;
  assert.equal(debit('減価償却費（製造）'), 120000); // 1,200,000×0.100
  assert.equal(debit('減価償却費'), 50000); // 200,000×0.250
});

test('かんたん入力：仕入に材料仕入高が出て、製品・材料の棚卸高は出ない。経費に製造経費が出る', () => {
  const { accounts, byName } = makeBook('corporation', corp);
  const purchase = slotCandidates(QUICK_BY_ID.purchase.debit, accounts, byName['現金'].id).map((a) => a.name);
  assert.ok(purchase.includes('材料仕入高'));
  assert.ok(!purchase.includes('期首製品棚卸高') && !purchase.includes('期末材料棚卸高'));
  const expense = slotCandidates(QUICK_BY_ID.expense.debit, accounts, byName['現金'].id).map((a) => a.name);
  assert.ok(expense.includes('外注加工費') && expense.includes('賃金'));
});

test('製造原価報告書のCSV：区分・科目・合計の行', () => {
  const { accounts, period, journals } = factoryYear();
  const csv = manufacturingCsv(manufacturingReport(closingRows({ accounts, period, journals })).items);
  assert.match(csv, /【材料費】/);
  assert.match(csv, /材料費 計,1250000/);
  assert.match(csv, /期末仕掛品棚卸高,-150000/);
  assert.match(csv, /当期製品製造原価,2500000/);
});

test('Repository：製造原価を使うと科目を追加し、もう一度でも重複しない。個人は拒否する', async () => {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('corporation').map((a) => createAccount(a));
  await repo.setup({ settings: createSettings({ businessName: 'テスト製作所', entityType: 'corporation' }), period: createPeriod({ startDate: '2026-04-01', endDate: '2027-03-31' }), accounts });
  const r = await repo.setManufacturing(true);
  assert.equal(r.settings.manufacturing, true);
  assert.equal(r.added.length, 26);
  assert.equal((await repo.listAccounts()).length, accounts.length + 26);
  await repo.setManufacturing(false);
  const again = await repo.setManufacturing(true);
  assert.equal(again.added.length, 0);
  assert.equal((await repo.getSettings()).manufacturing, true);
  repo.close();

  const ind = await openDB({ indexedDB: new IDBFactory() });
  await ind.setup({ settings: createSettings({ businessName: '個人', entityType: 'individual' }), period: createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' }), accounts: templateAccounts('individual').map((a) => createAccount(a)) });
  await assert.rejects(ind.setManufacturing(true), ValidationError);
  ind.close();
});
