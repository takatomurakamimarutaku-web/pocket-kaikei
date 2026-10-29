import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { depreciationSchedule, depreciationFor, assetRegister, depreciationLines, costAt } from '../js/depreciation.js';
import { splitAsset, disposalLines, bookValueAt, validateCapex, capexDefaults, canAddCapex, canSplit, registerByAccount } from '../js/asset-tools.js';
import { propertyTaxReturn } from '../js/property-tax.js';
import { openDB, ValidationError } from '../js/db.js';
import { templateAccounts, fillHints } from '../js/accounts.js';
import { createAccount, createPeriod, createSettings, createAsset, createJournal } from '../js/models.js';
import { makeBook } from './helpers.js';

const P = (y) => ({ id: `p${y}`, startDate: `${y}-01-01`, endDate: `${y}-12-31` });
const asset = (fields) => ({ id: 'a1', name: '棚', category: 'tools', accountId: 'acc', acquiredOn: '2024-01-01', startedOn: '2024-01-01', cost: 1000000, method: 'straight', usefulLife: 8, businessRatio: 100, quantity: 10, disposedOn: null, ...fields });
const periods = [P(2024), P(2025), P(2026)];

test('一部の除却：分けた期間の期首に取得価額・帳簿価額を割合で分け、前の期間は元のまま', () => {
  const a = asset({});
  const { original, part, errors } = splitAsset(a, periods, { date: '2026-06-30', cost: 400000, quantity: 4 });
  assert.deepEqual(errors, []);
  assert.deepEqual([original.cost, original.quantity, original.splits.length], [600000, 6, 1]);
  assert.deepEqual(original.splits[0], { id: part.id, date: '2026-06-30', periodStart: '2026-01-01', cost: 400000, quantity: 4 });
  // 元の資産：2024・2025 は 125,000（取得価額100万円のまま）、2026 は期首に 750,000 → 450,000、償却 75,000
  const rows = depreciationSchedule(original, periods);
  assert.deepEqual(rows.slice(0, 3).map((r) => r.amount), [125000, 125000, 75000]);
  assert.equal(rows[1].base, 1000000);
  assert.deepEqual([rows[2].opening, rows[2].base, rows[2].splits[0].book], [450000, 600000, 300000]);
  // 分けた資産：期首の帳簿価額 300,000 を引き継ぎ、6月まで 25,000
  assert.deepEqual([part.cost, part.quantity, part.carryOn, part.carryBook, part.splitFrom], [400000, 4, '2026-01-01', 300000, 'a1']);
  const disposed = { ...part, disposedOn: '2026-06-30' };
  assert.deepEqual(depreciationSchedule(disposed, periods).map((r) => r.amount), [25000]);
  assert.equal(bookValueAt(part, periods, '2026-06-30'), 275000);
  // 台帳：2025 は元の資産だけ（取得価額100万円）、2026 は2つ（期首の合計＝前期末 750,000）
  const r2025 = assetRegister([original, disposed], periods, P(2025));
  assert.deepEqual(r2025.map((x) => [x.asset.id, x.cost, x.opening, x.closing]), [['a1', 1000000, 875000, 750000]]);
  const r2026 = assetRegister([original, disposed], periods, P(2026));
  assert.deepEqual(r2026.map((x) => [x.cost, x.opening, x.row.amount]).sort((x, y) => y[0] - x[0]), [[600000, 450000, 75000], [400000, 300000, 25000]]);
  assert.equal(r2026.reduce((s, x) => s + x.opening, 0), 750000);
  assert.deepEqual(registerByAccount(r2026).map((x) => x.cost), [1000000]);
  assert.equal(costAt(original, P(2025)), 1000000);
  assert.equal(costAt(original, P(2026)), 600000);
});

test('一部の除却：定率法で改定取得価額に切り替え済みなら、改定取得価額も分ける', () => {
  const a = asset({ method: 'declining', usefulLife: 5, acquiredOn: '2022-01-01', startedOn: '2022-01-01', quantity: 1 });
  const ps = [P(2022), P(2023), P(2024), P(2025), P(2026)];
  // 400,000・240,000・144,000、2025 に保証額を下回り 216,000×0.5＝108,000
  assert.deepEqual(depreciationSchedule(a, ps).map((r) => r.amount), [400000, 240000, 144000, 108000, 107999]);
  const { original, part } = splitAsset(a, ps, { date: '2026-03-31', cost: 500000, quantity: null });
  assert.deepEqual([part.carryBook, part.carryRevisedBase, part.quantity, original.quantity], [54000, 108000, 1, 1]);
  assert.equal(depreciationFor(original, ps, P(2026)).amount, 53999);
  const p = depreciationSchedule({ ...part, disposedOn: '2026-03-31' }, ps);
  assert.deepEqual([p[0].amount, p[0].switched, p[0].closing], [13500, true, 40500]);
});

test('一部の除却：使い始めた期間に分けるときは引き継がず、同じ日から計算する（特別償却も分ける）', () => {
  const a = asset({ acquiredOn: '2026-04-01', startedOn: '2026-04-01', cost: 1200000, usefulLife: 4, quantity: 1 });
  const { original, part } = splitAsset(a, [P(2026)], { date: '2026-10-31', cost: 300000 });
  assert.equal(part.carryOn, null);
  assert.equal(depreciationFor(original, [P(2026)], P(2026)).amount, 168750); // 900,000×0.25×9/12
  assert.equal(depreciationFor({ ...part, disposedOn: '2026-10-31' }, [P(2026)], P(2026)).amount, 43750); // 300,000×0.25×7/12
  const sp = splitAsset({ ...a, specialRate: 30, specialName: '中小企業投資促進税制' }, [P(2026)], { date: '2026-10-31', cost: 300000 }).part;
  assert.equal(sp.specialRate, 30);
});

test('一部の除却の入力の誤り', () => {
  const a = asset({});
  const err = (input, target = a) => splitAsset(target, periods, input).errors.join(' ');
  assert.match(err({ date: '2026-06-30', cost: 1000000 }), /今の取得価額より小さく/);
  assert.match(err({ date: '2026-06-30', cost: 0 }), /1円以上/);
  assert.match(err({ date: '2026-06-30', cost: 100, quantity: 10 }), /1〜9/);
  assert.match(err({ date: '2023-12-31', cost: 100 }), /使い始めた日以後/);
  assert.match(err({ date: '2027-01-10', cost: 100 }), /会計期間がありません/);
  assert.match(err({ date: '2026-06-30', cost: 100 }, { ...a, method: 'lump3', cost: 150000 }), /一部の売却・除却ができません/);
  assert.match(err({ date: '2026-06-30', cost: 100 }, { ...a, disposalType: 'retire', disposedOn: '2026-05-01' }), /できません/);
  assert.equal(canSplit(a), true);
  assert.equal(canSplit({ ...a, splitFrom: 'x' }), false);
});

test('一部の除却の仕訳（法人）：分けた資産の減価償却累計額を消し、帳簿価額を除却損にする。決算の償却は元と分けた分の合計', () => {
  const b = makeBook('corporation', { startDate: '2026-01-01', endDate: '2026-12-31' });
  fillHints('corporation', b.accounts);
  const a = asset({ accountId: b.byName['工具器具備品'].id });
  const { original, part } = splitAsset(a, periods, { date: '2026-06-30', cost: 400000, quantity: 4 });
  const r = disposalLines({ asset: part, periods, accounts: b.accounts, entityType: 'corporation', date: '2026-06-30', type: 'retire', lossAccountId: b.byName['固定資産除却損'].id });
  assert.deepEqual(r.errors, []);
  assert.deepEqual([r.book, r.accumulated, r.loss], [275000, 125000, 275000]);
  const dep = depreciationLines({ assets: [original, { ...part, disposedOn: '2026-06-30', disposalType: 'retire' }], periods, period: P(2026), accounts: b.accounts, entityType: 'corporation' });
  assert.equal(dep.total, 100000);
});

test('一部の除却と償却資産申告書：元の資産は減らした取得価額、分けた分は除却した翌年度に減少', () => {
  const a = asset({ acquiredOn: '2024-01-10', startedOn: '2024-01-10' });
  const { original, part } = splitAsset(a, periods, { date: '2026-06-30', cost: 400000, quantity: 4 });
  const list = [original, { ...part, disposedOn: '2026-06-30', disposalType: 'retire' }];
  const y2026 = propertyTaxReturn({ assets: list, year: 2026 });
  assert.equal(y2026.total, 1000000);
  const y2027 = propertyTaxReturn({ assets: list, year: 2027 });
  assert.equal(y2027.total, 600000);
  assert.equal(y2027.decreases.length, 1);
});

test('資本的支出：元の資産と種類・耐用年数を同じにする', () => {
  const parent = asset({ quantity: 1 });
  assert.equal(canAddCapex(parent), true);
  assert.equal(canAddCapex({ ...parent, method: 'lump3' }), false);
  const child = { ...asset({}), ...capexDefaults(parent, '2026-05-01'), id: 'c1', cost: 300000 };
  assert.deepEqual([child.name, child.category, child.usefulLife, child.parentId, child.startedOn], ['棚（資本的支出）', 'tools', 8, 'a1', '2026-05-01']);
  assert.deepEqual(validateCapex(child, parent), []);
  assert.match(validateCapex({ ...child, usefulLife: 5 }, parent).join(), /同じ種類・耐用年数/);
  assert.match(validateCapex({ ...child, startedOn: '2023-12-31' }, parent).join(), /使い始めた日以後/);
  assert.match(validateCapex(child, { ...parent, parentId: 'x' }).join(), /追加できません/);
  assert.match(validateCapex(child, null).join(), /見つかりません/);
  // 旧定額法の資産への平成19年4月以後の支出は、新たな資産として定額法
  const old = asset({ acquiredOn: '2005-01-01', startedOn: '2005-01-01', quantity: 1 });
  assert.deepEqual(validateCapex({ ...child, ...capexDefaults(old, '2026-05-01'), cost: 300000 }, old), []);
  // 資本的支出の償却は新たな資産と同じ（使い始めた月から）
  assert.deepEqual(depreciationSchedule(child, [P(2026)]).slice(0, 2).map((r) => r.amount), [25000, 37500]);
});

async function setupRepo() {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('corporation').map((a) => createAccount(a));
  const period = createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト株式会社', entityType: 'corporation' }), period, accounts });
  const byName = Object.fromEntries(accounts.map((a) => [a.name, a]));
  return { repo, accounts, byName, period };
}

test('保存：一部の除却は資産2件と仕訳を一緒に保存し、取り消すと元に戻る。分けた資産は計算の項目を変えられない', async () => {
  const { repo, accounts, byName, period } = await setupRepo();
  const ps = [period];
  const a = await repo.saveAsset(createAsset({ name: '机', category: 'tools', accountId: byName['工具器具備品'].id, acquiredOn: '2026-01-01', startedOn: '2026-01-01', cost: 1000000, method: 'straight', usefulLife: 8, quantity: 10 }));
  // 「売却・除却する」以外で分けた記録を入れても保存しない
  await assert.rejects(repo.saveAsset({ ...a, splits: [{ id: 'x', date: '2026-02-01', periodStart: '2026-01-01', cost: 1 }] }), (e) => e instanceof ValidationError && /売却・除却する/.test(e.errors.cost));
  const { original, part } = splitAsset(a, ps, { date: '2026-06-30', cost: 300000, quantity: 3 });
  const disposedPart = { ...part, disposedOn: '2026-06-30', disposalType: 'retire', salePrice: null };
  const r = disposalLines({ asset: disposedPart, periods: ps, accounts, entityType: 'corporation', date: '2026-06-30', type: 'retire', lossAccountId: byName['固定資産除却損'].id });
  assert.deepEqual(r.errors, []);
  const journal = createJournal({ periodId: period.id, date: '2026-06-30', lines: r.lines });
  const res = await repo.partialDisposeAsset(original, disposedPart, journal);
  assert.equal(res.journal.sourceId, part.id);
  const list = await repo.listAssets();
  assert.equal(list.length, 2);
  const o = list.find((x) => x.id === a.id);
  assert.deepEqual([o.cost, o.quantity, o.splits.length], [700000, 7, 1]);
  // 計算の項目は変えられない。名前は変えられる
  await assert.rejects(repo.saveAsset({ ...o, cost: 800000 }), (e) => e instanceof ValidationError && /変えられません/.test(e.errors.cost));
  await assert.rejects(repo.saveAsset({ ...res.part, usefulLife: 5 }), ValidationError);
  assert.equal((await repo.saveAsset({ ...o, name: '机（本店）' })).name, '机（本店）');
  // 削除はできない
  await assert.rejects(repo.deleteAsset(a.id), (e) => e instanceof ValidationError && /取り消して/.test(e.errors[0]));
  await assert.rejects(repo.deleteAsset(part.id), ValidationError);
  // 取り消し：分けた資産を削除し、取得価額・数量を戻す
  const back = await repo.undoDisposal(part.id);
  assert.deepEqual([back.cost, back.quantity, back.splits.length, back.name], [1000000, 10, 0, '机（本店）']);
  assert.equal((await repo.listAssets()).length, 1);
  assert.equal(await repo.getJournal(res.journal.id), undefined);
  const dump = await repo.dumpAll();
  assert.ok(dump.tombstones.some((t) => t.store === 'assets' && t.id === part.id));
  repo.close();
});

test('保存：資本的支出は元の資産と同じ種類・耐用年数。元の資産は資本的支出があると削除できない', async () => {
  const { repo, byName } = await setupRepo();
  const parent = await repo.saveAsset(createAsset({ name: '店舗内装', category: 'building_equipment', accountId: byName['建物附属設備'].id, acquiredOn: '2026-01-01', startedOn: '2026-01-01', cost: 2000000, method: 'straight', usefulLife: 15 }));
  const child = createAsset({ ...capexDefaults(parent, '2026-08-01'), cost: 500000 });
  await assert.rejects(repo.saveAsset({ ...child, usefulLife: 10 }), (e) => e instanceof ValidationError && /同じ種類・耐用年数/.test(e.errors.parentId));
  await assert.rejects(repo.saveAsset({ ...child, parentId: 'nothing' }), (e) => e instanceof ValidationError && /見つかりません/.test(e.errors.parentId));
  const saved = await repo.saveAsset(child);
  assert.equal(saved.parentId, parent.id);
  await assert.rejects(repo.deleteAsset(parent.id), (e) => e instanceof ValidationError && /資本的支出/.test(e.errors[0]));
  await repo.deleteAsset(saved.id);
  await repo.deleteAsset(parent.id);
  assert.equal((await repo.listAssets()).length, 0);
  repo.close();
});
