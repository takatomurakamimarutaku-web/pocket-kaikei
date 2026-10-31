import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetRegister, depreciationLines, validateAsset } from '../js/depreciation.js';
import {
  registerDetail,
  otherStatus,
  sumDetails,
  groupDetails,
  sortDetails,
  matchAsset,
  forecastRanges,
  depreciationForecast,
  monthlyDepreciation,
  monthlyTable,
  disposalList,
} from '../js/asset-reports.js';
import { assetRegisterDoc, movementDoc, forecastDoc, monthlyDoc, acquiredDoc, disposedDoc } from '../js/print-assets.js';
import { layoutDocument, fmt } from '../js/print-layout.js';
import { buildSample } from '../js/sample.js';
import { makeBook } from './helpers.js';

const period = { id: 'p1', startDate: '2026-04-01', endDate: '2027-03-31' };
const periods = [period];

function book() {
  const b = makeBook('corporation', { startDate: period.startDate, endDate: period.endDate });
  const tools = b.byName['工具器具備品'].id;
  const machine = b.byName['機械装置'].id;
  const a = (id, fields) => ({ id, name: id, category: 'tools', accountId: tools, acquiredOn: fields.startedOn, cost: 0, method: 'straight', usefulLife: null, businessRatio: 100, quantity: 1, ...fields });
  const assets = [
    a('old', { assetNo: 'A-2', startedOn: '2025-04-01', cost: 400000, usefulLife: 4, departmentId: 'd1', location: '本店', supplier: '○○電機' }),
    a('new', { assetNo: 'A-10', startedOn: '2026-07-15', cost: 600000, usefulLife: 5, location: '倉庫' }),
    a('sold', { assetNo: 'A-1', startedOn: '2024-04-01', cost: 500000, usefulLife: 5, disposedOn: '2026-09-30', disposalType: 'sell', salePrice: 260000 }),
    a('done', { startedOn: '2020-04-01', cost: 100000, usefulLife: 2 }),
    a('small', { startedOn: '2026-05-10', cost: 80000, method: 'small' }),
    a('lump', { startedOn: '2026-06-01', cost: 150000, method: 'lump3' }),
    a('special', { category: 'machinery', accountId: machine, startedOn: '2026-04-01', cost: 1000000, usefulLife: 10, specialRate: 30, specialName: '中小企業投資促進税制' }),
    a('future', { startedOn: '2027-05-01', cost: 300000, usefulLife: 4 }),
  ];
  return { b, assets, register: assetRegister(assets, periods, period) };
}
const byName = (list, name) => list.find((d) => d.asset.name === name);

test('増減の明細：期首＋増加−償却−減少＝期末、累計額＝取得価額−帳簿価額、状態', () => {
  const { register } = book();
  const ds = register.map((x) => registerDetail(x, period));
  for (const d of ds) {
    assert.equal(d.bookOpening + d.bookIncrease - d.amount - d.bookDecrease, d.bookClosing, d.asset.name);
    assert.equal(d.costOpening + d.costIncrease - d.costDecrease, d.costClosing, d.asset.name);
    assert.equal(d.accumulatedClosing, d.costClosing - d.bookClosing, d.asset.name);
  }
  const old = byName(ds, 'old');
  assert.deepEqual([old.status, old.bookOpening, old.amount, old.bookClosing, old.accumulatedOpening, old.accumulatedClosing], ['active', 300000, 100000, 200000, 100000, 200000]);
  // 期中に取得：期首0、取得価額を増加に。9か月分（7/15〜3/31）
  const n = byName(ds, 'new');
  assert.deepEqual([n.status, n.costOpening, n.costIncrease, n.bookOpening, n.bookIncrease, n.months, n.amount, n.bookClosing], ['new', 0, 600000, 0, 600000, 9, 90000, 510000]);
  // 期中に売却：9月までの6か月分を償却し、売却した日の帳簿価額を減少に。期末は0
  const s = byName(ds, 'sold');
  assert.deepEqual([s.status, s.bookOpening, s.amount, s.bookDecrease, s.bookClosing, s.costDecrease, s.costClosing, s.accumulatedClosing], ['disposed', 300000, 50000, 250000, 0, 500000, 0, 0]);
  // 償却済み（備忘価額1円）は償却0のまま台帳に残る
  const done = byName(ds, 'done');
  assert.deepEqual([done.status, done.bookOpening, done.amount, done.bookClosing, done.accumulatedClosing], ['done', 1, 0, 1, 99999]);
  // 特別償却は普通償却と分けて持つ
  const sp = byName(ds, 'special');
  assert.deepEqual([sp.ordinary, sp.special, sp.amount], [100000, 300000, 400000]);
  // 合計
  const sum = sumDetails(ds);
  assert.equal(sum.count, ds.length);
  assert.equal(sum.bookOpening + sum.bookIncrease - sum.amount - sum.bookDecrease, sum.bookClosing);
  assert.equal(sum.amount, register.reduce((t, x) => t + (x.row?.amount || 0), 0));
  // 台帳に出ない資産の状態
  const { assets } = book();
  assert.equal(otherStatus(assets.find((a) => a.id === 'future'), period), 'future');
  assert.equal(otherStatus({ ...assets[0], disposedOn: '2025-12-31' }, period), 'gone');
});

test('集計の単位・並び順・絞り込み', () => {
  const { b, register } = book();
  const ds = register.map((x) => registerDetail(x, period));
  const accountById = new Map(b.accounts.map((a) => [a.id, a]));
  const departmentById = new Map([['d1', { id: 'd1', name: '営業部' }]]);
  // 科目ごと：コードの順（機械装置 → 工具器具備品）
  const byAcc = groupDetails(ds, 'account', { accountById, departmentById });
  assert.deepEqual(byAcc.map((g) => g.label), ['機械装置', '工具器具備品']);
  assert.equal(byAcc.reduce((t, g) => t + g.sum.amount, 0), sumDetails(ds).amount);
  // 設置場所・部門ごと：指定なしは最後
  assert.deepEqual(groupDetails(ds, 'location').map((g) => g.label), ['倉庫', '本店', '（設置場所の指定なし）']);
  assert.deepEqual(groupDetails(ds, 'department', { departmentById }).map((g) => g.label), ['営業部', '（部門の指定なし）']);
  // 資産番号は数字の大きさで並べる（A-2 が A-10 より先）。番号なしは最後
  assert.deepEqual(sortDetails(ds, 'no').slice(0, 3).map((d) => d.asset.assetNo), ['A-1', 'A-2', 'A-10']);
  assert.equal(sortDetails(ds, 'cost')[0].asset.name, 'special');
  assert.equal(sortDetails(ds, 'date')[0].asset.name, 'done');
  // 絞り込み：状態・文字（複数の語はすべて含む）・部門
  assert.deepEqual(ds.filter((d) => matchAsset(d.asset, d.status, { statuses: ['new'] })).map((d) => d.asset.name).sort(), ['lump', 'new', 'small', 'special']);
  assert.deepEqual(ds.filter((d) => matchAsset(d.asset, d.status, { q: '○○ 本店' })).map((d) => d.asset.name), ['old']);
  assert.deepEqual(ds.filter((d) => matchAsset(d.asset, d.status, { q: 'a-1' })).map((d) => d.asset.name).sort(), ['new', 'sold']);
  assert.deepEqual(ds.filter((d) => matchAsset(d.asset, d.status, { departmentId: 'd1' })).map((d) => d.asset.name), ['old']);
});

test('償却予定表：当期から5年、登録していない年は12か月。当期の列は台帳の償却費と一致し、帳簿価額は償却費の分だけ減る', () => {
  const { assets, register } = book();
  const ranges = forecastRanges(periods, period, 5);
  assert.deepEqual(ranges.map((r) => [r.startDate, r.endDate]), [
    ['2026-04-01', '2027-03-31'],
    ['2027-04-01', '2028-03-31'],
    ['2028-04-01', '2029-03-31'],
    ['2029-04-01', '2030-03-31'],
    ['2030-04-01', '2031-03-31'],
  ]);
  const f = depreciationForecast(assets, periods, period, 5);
  assert.equal(f.totals.amounts[0], register.reduce((t, x) => t + (x.row?.amount || 0), 0));
  // これから使う資産は2年目から、売却した資産は当期だけ
  const fut = f.rows.find((r) => r.asset.id === 'future');
  assert.equal(fut.amounts[0], 0);
  assert.equal(fut.amounts[1], Math.floor((300000 * 250) / 1000 * 11 / 12));
  const sold = f.rows.find((r) => r.asset.id === 'sold');
  assert.deepEqual([sold.amounts, sold.closing], [[50000, 0, 0, 0, 0], [0, 0, 0, 0, 0]]);
  const old = f.rows.find((r) => r.asset.id === 'old');
  assert.deepEqual(old.amounts, [100000, 100000, 99999, 0, 0]);
  assert.deepEqual(old.closing, [200000, 100000, 1, 1, 1]);
  for (const r of f.rows.filter((x) => !['sold', 'future'].includes(x.asset.id))) {
    for (let i = 1; i < 5; i++) assert.equal(r.closing[i], r.closing[i - 1] - r.amounts[i], r.asset.id);
  }
  assert.equal(depreciationForecast(assets, periods, period, 10).ranges.length, 10);
});

test('月次償却：償却する月に均等に割り振り、合計は年額と一致。特別償却は最後の月、少額は使い始めた月', () => {
  const { register } = book();
  const get = (id) => monthlyDepreciation(register.find((x) => x.asset.id === id), period);
  const n = get('new');
  assert.equal(n.months[0], '2026-04');
  assert.deepEqual(n.amounts.slice(0, 3), [0, 0, 0]);
  assert.deepEqual(n.amounts.slice(3), Array(9).fill(10000));
  const s = get('sold');
  assert.deepEqual(s.amounts, [...Array(6).fill(8333).map((v, i) => (i === 2 || i === 5 ? 8334 : v)), ...Array(6).fill(0)]);
  assert.equal(s.amounts.reduce((a, b) => a + b, 0), 50000);
  const sp = get('special');
  assert.equal(sp.amounts.reduce((a, b) => a + b, 0), 400000);
  assert.equal(sp.amounts.at(-1), Math.floor(100000 * 12 / 12) - Math.floor(100000 * 11 / 12) + 300000);
  const sm = get('small');
  assert.deepEqual(sm.amounts.map((v, i) => (v ? i : -1)).filter((i) => i >= 0), [1]);
  assert.equal(sm.amounts[1], 80000);
  const lump = get('lump');
  assert.equal(lump.amounts.filter(Boolean).length, 12);
  const t = monthlyTable(register, period);
  assert.equal(t.total, register.reduce((a, x) => a + (x.row?.amount || 0), 0));
  assert.equal(t.totals.length, 12);
  assert.deepEqual(t.businessTotals, t.totals);
});

test('月次償却（個人の事業割合）：経費になる額も月ごとに分け、合計は年の経費と一致', () => {
  const p = { id: 'i1', startDate: '2026-01-01', endDate: '2026-12-31' };
  const b = makeBook('individual');
  const car = { id: 'car', name: '車', category: 'vehicle', accountId: b.byName['車両運搬具'].id, acquiredOn: '2026-03-10', startedOn: '2026-03-10', cost: 1200000, method: 'straight', usefulLife: 6, businessRatio: 70 };
  const [x] = assetRegister([car], [p], p);
  const m = monthlyDepreciation(x, p);
  assert.equal(m.amounts.reduce((a, c) => a + c, 0), x.row.amount);
  assert.equal(m.business.reduce((a, c) => a + c, 0), x.row.business);
  assert.deepEqual(m.amounts.slice(0, 2), [0, 0]);
});

test('除却資産台帳：売却損益＝売却額−売却した日の帳簿価額', () => {
  const { register } = book();
  const ds = register.map((x) => registerDetail(x, period));
  const list = disposalList(ds);
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].type, list[0].price, list[0].bookDecrease, list[0].gainLoss, list[0].accumulatedAtDisposal], ['sell', 260000, 250000, 10000, 250000]);
  const retire = disposalList([{ ...list[0], asset: { ...list[0].asset, disposalType: 'retire', salePrice: null } }]);
  assert.equal(retire[0].gainLoss, -250000);
});

test('部門を指定した資産：償却費の仕訳に部門を付ける（使わない部門は付けない）。購入先の長さ', () => {
  const { b, assets } = book();
  const departments = [{ id: 'd1', name: '営業部', active: true }];
  const { lines } = depreciationLines({ assets, periods, period, accounts: b.accounts, entityType: 'corporation', departments });
  const oldLines = lines.filter((l) => l.memo === '減価償却 old');
  assert.equal(oldLines.find((l) => l.side === 'debit').departmentId, 'd1');
  assert.equal(oldLines.find((l) => l.side === 'credit').departmentId, undefined);
  assert.ok(lines.filter((l) => l.memo !== '減価償却 old').every((l) => !l.departmentId));
  const off = depreciationLines({ assets, periods, period, accounts: b.accounts, entityType: 'corporation', departments: [{ ...departments[0], active: false }] });
  assert.ok(off.lines.every((l) => !l.departmentId));
  const ctx = { entityType: 'corporation', accounts: b.accounts };
  assert.deepEqual(validateAsset(assets[0], ctx), {});
  assert.ok(validateAsset({ ...assets[0], supplier: 'あ'.repeat(41) }, ctx).supplier);
  assert.ok(validateAsset({ ...assets[0], departmentId: '' }, ctx).departmentId);
});

test('印刷：固定資産台帳・増減明細表・償却予定表・月次償却額一覧表・取得資産台帳・除却資産台帳（A4横、合計は台帳と一致）', () => {
  const { b, assets, register } = book();
  const accountById = new Map(b.accounts.map((a) => [a.id, a]));
  const departmentById = new Map([['d1', { id: 'd1', name: '営業部' }]]);
  const ds = register.map((x) => registerDetail(x, period));
  const head = { company: 'x', printedAt: '2027-05-01' };
  const opts = { accountById, departmentById, individual: false, head };
  const total = sumDetails(ds);
  const lastCells = (doc) => doc.blocks[0].rows.at(-1).cells.map((c) => (typeof c === 'object' && !Array.isArray(c) ? c.text : c));
  const docs = {
    register: assetRegisterDoc(register, { ...opts, period }),
    movement: movementDoc(ds, opts),
    forecast: forecastDoc(assets, periods, period, opts),
    monthly: monthlyDoc(register, period, opts),
    acquired: acquiredDoc(ds, opts),
    disposed: disposedDoc(ds, opts),
  };
  for (const [k, doc] of Object.entries(docs)) {
    assert.equal(doc.blocks[0].rows.at(-1).kind, 'total', k);
    const pages = layoutDocument(doc);
    assert.equal(pages[0].orientation, 'landscape', k);
  }
  assert.ok(lastCells(docs.register).includes(fmt(total.amount)));
  assert.ok(lastCells(docs.register).includes(fmt(total.accumulatedClosing)));
  assert.deepEqual(lastCells(docs.movement).slice(1), [total.costOpening, total.costIncrease, total.costDecrease, total.costClosing, total.bookOpening, total.bookIncrease, total.bookDecrease, total.amount, total.bookClosing, total.accumulatedOpening, total.accumulatedClosing].map((n) => (n ? fmt(n) : '')));
  assert.equal(docs.movement.blocks[0].headGroups.length, 3);
  assert.equal(lastCells(docs.monthly).at(-1), fmt(total.amount));
  assert.ok(lastCells(docs.acquired).includes(fmt(total.costIncrease)));
  assert.equal(lastCells(docs.disposed).at(-1), fmt(10000));
  assert.equal(docs.forecast.blocks[0].columns.length, 3 + 5 + 1);
});

test('印刷の固定資産台帳：サンプルの帳簿で科目ごとに並べ、個人は事業割合と必要経費の列', () => {
  for (const entity of ['individual', 'corporation']) {
    const s = buildSample(entity);
    const p = s.periods[0];
    const register = assetRegister(s.assets, s.periods, p);
    assert.ok(register.length >= 1);
    const accountById = new Map(s.accounts.map((a) => [a.id, a]));
    const individual = entity === 'individual';
    const doc = assetRegisterDoc(register, { period: p, accountById, individual, head: { company: 'x' } });
    const t = doc.blocks[0];
    const labels = t.columns.map((c) => c.label);
    assert.equal(labels.includes('事業\n割合'), individual);
    assert.equal(labels.includes('必要経費\n算入額'), individual);
    assert.ok(labels.includes('減価償却\n累計額'));
    assert.equal(t.rows.filter((r) => !r.kind).length, register.length);
    assert.equal(t.rows.filter((r) => r.kind === 'group').length, new Set(register.map((x) => x.asset.accountId)).size);
  }
});

test('月次償却の仕訳：月ごとの明細の合計は月次償却額と一致し、計上済みの月と残りの月を足すと年額', async () => {
  const { monthlyDepreciationLines, bookedDepreciation, monthEnd } = await import('../js/asset-reports.js');
  const { validateJournal } = await import('../js/journal.js');
  const { createJournal } = await import('../js/models.js');
  const { b, assets, register } = book();
  const ctx = { assets, periods, period, accounts: b.accounts, entityType: 'corporation' };
  const t = monthlyTable(register, period);
  const year = depreciationLines(ctx).total;
  const js = [];
  for (const m of ['2026-04', '2026-05', '2026-06']) {
    const r = monthlyDepreciationLines({ ...ctx, months: [m] });
    assert.deepEqual(r.errors, []);
    assert.equal(r.total, t.totals[t.months.indexOf(m)], m);
    const j = createJournal({ periodId: period.id, date: monthEnd(m, period), lines: r.lines, source: 'depreciation', depMonths: [m], adjusting: false });
    assert.deepEqual(validateJournal(j, { accounts: b.accounts, subAccounts: [], period }), []);
    assert.ok(r.lines.every((l) => l.memo.endsWith(`（${Number(m.slice(5))}月分）`)));
    js.push(j);
  }
  assert.equal(monthEnd('2026-06', period), '2026-06-30');
  const bk = bookedDepreciation(js);
  assert.equal(bk.annual, false);
  assert.deepEqual([...bk.months], ['2026-04', '2026-05', '2026-06']);
  const rest = t.months.filter((m) => !bk.months.has(m));
  const r = monthlyDepreciationLines({ ...ctx, months: rest });
  assert.equal(bk.booked + r.total, year);
  assert.ok(r.lines[0].memo.endsWith('（7月〜3月分）'));
  // 年1回の仕訳（depMonths なし）は期間の全額
  assert.equal(bookedDepreciation([{ source: 'depreciation', lines: [{ side: 'credit', amount: 5 }] }]).annual, true);
});

test('償却しない資産（土地）：償却費0で取得価額のまま台帳に載り、売却は非課税売上で台帳から外れる。青色申告決算書・償却資産申告には載せない', async () => {
  const { disposalLines } = await import('../js/asset-tools.js');
  const { depreciationTable } = await import('../js/blue-return.js');
  const { ptEligibility } = await import('../js/property-tax.js');
  const { depreciationSchedule } = await import('../js/depreciation.js');
  const b = makeBook('corporation', { startDate: period.startDate, endDate: period.endDate });
  const landAcc = b.byName['土地'].id;
  const land = { id: 'land', name: '本社用地', category: 'land', accountId: landAcc, acquiredOn: '2020-05-01', startedOn: '2020-05-01', cost: 30000000, method: 'none', usefulLife: null, businessRatio: 100, quantity: 1 };
  const ctx = { entityType: 'corporation', accounts: b.accounts };
  assert.deepEqual(validateAsset(land, ctx), {});
  assert.ok(validateAsset({ ...land, method: 'straight', usefulLife: 10 }, ctx).method, '土地は償却しない');
  assert.deepEqual(depreciationSchedule(land, periods), []);
  const [x] = assetRegister([land], periods, period);
  const d = registerDetail(x, period);
  assert.deepEqual([d.status, d.bookOpening, d.amount, d.bookClosing, d.accumulatedClosing], ['nondep', 30000000, 0, 30000000, 0]);
  assert.equal(depreciationLines({ assets: [land], periods, period, accounts: b.accounts, entityType: 'corporation' }).lines.length, 0);
  // 期中に取得した土地は期中増加
  const bought = registerDetail(assetRegister([{ ...land, startedOn: '2026-06-01', acquiredOn: '2026-06-01' }], periods, period)[0], period);
  assert.deepEqual([bought.status, bought.bookIncrease, bought.bookClosing], ['new', 30000000, 30000000]);
  // 売却：帳簿価額＝取得価額、売却額は非課税売上、差額は売却益
  const cash = b.byName['普通預金'].id;
  const gainAcc = b.accounts.find((a) => a.group === 'extraordinary_income').id;
  const r = disposalLines({ asset: land, periods, accounts: b.accounts, entityType: 'corporation', date: '2026-10-31', type: 'sell', price: 35000000, receiptAccountId: cash, gainAccountId: gainAcc });
  assert.deepEqual(r.errors, []);
  assert.deepEqual([r.book, r.accumulated, r.gain], [30000000, 0, 5000000]);
  assert.equal(r.lines.find((l) => l.side === 'credit' && l.amount === 35000000).taxCategory, 'sales_exempt');
  const sold = registerDetail(assetRegister([{ ...land, disposedOn: '2026-10-31', disposalType: 'sell', salePrice: 35000000 }], periods, period)[0], period);
  assert.deepEqual([sold.status, sold.bookDecrease, sold.bookClosing], ['disposed', 30000000, 0]);
  assert.equal(assetRegister([{ ...land, disposedOn: '2026-03-31', disposalType: 'sell', salePrice: 1 }], periods, period).length, 0);
  // 予定表：償却0で帳簿価額はそのまま
  const f = depreciationForecast([land], periods, period, 5);
  assert.deepEqual([f.rows[0].amounts, f.rows[0].closing], [[0, 0, 0, 0, 0], Array(5).fill(30000000)]);
  // 青色申告決算書の減価償却費の計算・償却資産申告の対象から外す
  assert.equal(depreciationTable({ assets: [land], periods, period }).rows.length, 0);
  assert.deepEqual([ptEligibility(land).include, ptEligibility(land).fixed], [false, true]);
});
