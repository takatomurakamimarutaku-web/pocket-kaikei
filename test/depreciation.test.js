import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RATE_TABLE,
  monthsBetween,
  validateAsset,
  depreciationSchedule,
  depreciationFor,
  assetRegister,
  smeUsage,
  smeLimit,
  depreciationLines,
  findDepreciationJournals,
  openingBook,
} from '../js/depreciation.js';
import { makeBook } from './helpers.js';
import { fillHints } from '../js/accounts.js';

const P = (y, m = 1) => {
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const endY = m === 1 ? y : y + 1;
  const endM = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(endY, endM, 0)).getUTCDate();
  return { id: `p${y}`, startDate: start, endDate: `${endY}-${String(endM).padStart(2, '0')}-${last}` };
};
const asset = (fields) => ({ id: 'a1', name: 'パソコン', category: 'tools', accountId: 'acc', acquiredOn: '2026-01-01', startedOn: '2026-01-01', cost: 1000000, method: 'straight', usefulLife: 8, businessRatio: 100, disposedOn: null, ...fields });
const amounts = (rows) => rows.map((r) => r.amount);

test('償却率表：2〜50年がそろい、定額法は 1/耐用年数 を小数3位で切り上げた値', () => {
  for (let n = 2; n <= 50; n++) {
    assert.ok(RATE_TABLE[n], `${n}年`);
    assert.equal(RATE_TABLE[n][0], Math.ceil(1000 / n), `${n}年の定額法`);
  }
  assert.deepEqual(RATE_TABLE[8], [125, 250, 334, 7909]); // 国税庁 No.5410 の計算例
});

test('月数：暦で数え、1か月未満は1か月', () => {
  assert.equal(monthsBetween('2026-01-01', '2026-12-31'), 12);
  assert.equal(monthsBetween('2026-04-10', '2027-03-31'), 12);
  assert.equal(monthsBetween('2026-12-15', '2026-12-31'), 1);
  assert.equal(monthsBetween('2026-07-01', '2026-12-31'), 6);
  assert.equal(monthsBetween('2026-07-02', '2026-12-31'), 6);
  assert.equal(monthsBetween('2026-01-01', '2026-03-05'), 3);
});

test('定額法：国税庁 No.5410 の例（100万円・8年）は毎年125,000円、最後は1円を残す', () => {
  const rows = depreciationSchedule(asset({ startedOn: '2019-01-01', acquiredOn: '2019-01-01' }), [P(2026)]);
  assert.deepEqual(amounts(rows), [125000, 125000, 125000, 125000, 125000, 125000, 125000, 124999]);
  assert.equal(rows.at(-1).closing, 1);
  assert.equal(rows[0].startDate, '2019-01-01');
});

test('200%定率法：国税庁 No.5410 の例（100万円・8年）。6年目から改定償却率に切り替え、最後は1円', () => {
  const rows = depreciationSchedule(asset({ method: 'declining', startedOn: '2019-01-01', acquiredOn: '2019-01-01' }), [P(2026)]);
  assert.deepEqual(amounts(rows), [250000, 187500, 140625, 105468, 79101, 79260, 79260, 78785]);
  assert.equal(rows.at(-1).closing, 1);
  assert.equal(rows.findIndex((r) => r.switched), 5);
});

test('年の途中から使い始めた年は月数で按分（定額法 7月1日 → 6/12）', () => {
  const rows = depreciationSchedule(asset({ startedOn: '2026-07-10', acquiredOn: '2026-07-01', cost: 300000, usefulLife: 4 }), [P(2026)]);
  // 年額 300,000×0.250=75,000、初年 75,000×6/12=37,500
  assert.deepEqual(amounts(rows), [37500, 75000, 75000, 75000, 37499]);
  assert.equal(rows.reduce((s, r) => s + r.amount, 0), 299999);
});

test('法人の事業年度（4月始まり）と、会計期間がない年も12か月で補う', () => {
  const periods = [P(2026, 4)];
  const rows = depreciationSchedule(asset({ startedOn: '2025-10-01', acquiredOn: '2025-10-01', cost: 120000 * 5, usefulLife: 5 }), periods);
  assert.equal(rows[0].startDate, '2025-04-01');
  assert.equal(rows[0].months, 6);
  assert.equal(rows[0].amount, 60000); // 年額 120,000 × 6/12
  assert.equal(rows[1].periodId, 'p2026');
  assert.equal(rows[1].amount, 120000);
});

test('無形固定資産は0円まで償却する', () => {
  const rows = depreciationSchedule(asset({ category: 'intangible', cost: 500000, usefulLife: 5 }), [P(2026)]);
  assert.deepEqual(amounts(rows), [100000, 100000, 100000, 100000, 100000]);
  assert.equal(rows.at(-1).closing, 0);
});

test('一括償却資産：3年で均等（使い始めた月に関係なく1/3）', () => {
  const rows = depreciationSchedule(asset({ method: 'lump3', cost: 150000, startedOn: '2026-11-20', acquiredOn: '2026-11-20', usefulLife: null }), [P(2026)]);
  assert.deepEqual(amounts(rows), [50000, 50000, 50000]);
  const odd = depreciationSchedule(asset({ method: 'lump3', cost: 100001, usefulLife: null }), [P(2026)]);
  assert.deepEqual(amounts(odd), [33333, 33333, 33335]);
});

test('少額減価償却資産・特例：使い始めた年に全額', () => {
  const rows = depreciationSchedule(asset({ method: 'sme', cost: 350000, startedOn: '2026-05-01', acquiredOn: '2026-05-01', usefulLife: null }), [P(2026)]);
  assert.deepEqual(amounts(rows), [350000]);
  assert.equal(rows[0].closing, 0);
});

test('事業で使う割合：経費は割合分（切り捨て）、残りは私用分', () => {
  const r = depreciationFor(asset({ cost: 1000000, usefulLife: 8, businessRatio: 70 }), [P(2026)], P(2026));
  assert.equal(r.amount, 125000);
  assert.equal(r.business, 87500);
  assert.equal(r.private, 37500);
});

test('除却・売却した年は、その月までの月数で計算し、以後は償却しない', () => {
  const rows = depreciationSchedule(asset({ startedOn: '2025-01-01', acquiredOn: '2025-01-01', disposedOn: '2026-03-15' }), [P(2026)]);
  assert.deepEqual(amounts(rows), [125000, 31250]); // 125,000 × 3/12
});

test('検証：方法ごとの金額・期間の制限', () => {
  const ctxInd = { entityType: 'individual', accounts: [{ id: 'acc', group: 'tangible_fixed_assets', normalSide: 'debit' }, { id: 'sw', group: 'intangible_fixed_assets', normalSide: 'debit' }] };
  assert.deepEqual(validateAsset(asset({}), ctxInd), {});
  assert.match(validateAsset(asset({ method: 'small', cost: 100000 }), ctxInd).method, /10万円未満/);
  assert.match(validateAsset(asset({ method: 'lump3', cost: 200000 }), ctxInd).method, /20万円未満/);
  // 少額特例：令和8年3月31日までの取得は30万円未満、4月1日以後は40万円未満
  assert.equal(smeLimit('2026-03-31'), 300000);
  assert.equal(smeLimit('2026-04-01'), 400000);
  assert.match(validateAsset(asset({ method: 'sme', cost: 300000, acquiredOn: '2026-03-31', startedOn: '2026-03-31' }), ctxInd).method, /30万円未満/);
  assert.deepEqual(validateAsset(asset({ method: 'sme', cost: 399999, acquiredOn: '2026-04-01', startedOn: '2026-04-01' }), ctxInd), {});
  assert.match(validateAsset(asset({ method: 'sme', cost: 100000, acquiredOn: '2029-04-01', startedOn: '2029-04-01' }), ctxInd).method, /対象期間/);
  // 建物附属設備は平成28年4月1日以後の取得は定額法のみ
  assert.match(validateAsset(asset({ category: 'building_equipment', method: 'declining' }), ctxInd).method, /定額法/);
  assert.match(validateAsset(asset({ method: 'declining', acquiredOn: '2011-05-01', startedOn: '2011-05-01' }), ctxInd).method, /250%/);
  assert.match(validateAsset(asset({ startedOn: '2007-03-31', acquiredOn: '2007-03-01' }), ctxInd).method, /旧定額法/);
  assert.match(validateAsset(asset({ usefulLife: 51 }), ctxInd).usefulLife, /2〜50/);
  assert.match(validateAsset(asset({ category: 'intangible' }), ctxInd).accountId, /無形/);
  assert.deepEqual(validateAsset(asset({ category: 'intangible', accountId: 'sw' }), ctxInd), {});
  assert.match(validateAsset(asset({ businessRatio: 0 }), ctxInd).businessRatio, /1〜100/);
  assert.match(validateAsset(asset({ startedOn: '2025-12-31' }), ctxInd).startedOn, /取得日以後/);
  assert.match(validateAsset(asset({ cost: 1.5 }), ctxInd).cost, /整数/);
});

test('台帳：期首帳簿価額・償却費・期末帳簿価額、償却の終わった資産は出さない', () => {
  const list = [
    asset({ id: 'a', name: 'A', startedOn: '2025-01-01', acquiredOn: '2025-01-01' }),
    asset({ id: 'b', name: 'B', startedOn: '2010-01-01', acquiredOn: '2010-01-01', usefulLife: 4 }), // 償却済み（1円）
    asset({ id: 'c', name: 'C', method: 'small', cost: 50000, startedOn: '2025-06-01', acquiredOn: '2025-06-01', usefulLife: null }), // 前年に全額
    asset({ id: 'd', name: 'D', startedOn: '2027-01-01', acquiredOn: '2027-01-01' }), // まだ使っていない
  ];
  const reg = assetRegister(list, [P(2026)], P(2026));
  assert.deepEqual(reg.map((x) => x.asset.id), ['b', 'a']);
  const a = reg.find((x) => x.asset.id === 'a');
  assert.deepEqual([a.opening, a.row.amount, a.closing], [875000, 125000, 750000]);
  const b = reg.find((x) => x.asset.id === 'b');
  assert.equal(b.row, null);
  assert.equal(b.closing, 1);
});

test('少額特例の年300万円の上限（1年未満の期間は月数で按分）', () => {
  const list = [asset({ method: 'sme', cost: 2000000, usefulLife: null }), asset({ id: 'x', method: 'sme', cost: 1500000, usefulLife: null })];
  assert.deepEqual(smeUsage(list, P(2026)), { total: 3500000, limit: 3000000, over: true });
  assert.equal(smeUsage(list, { startDate: '2026-04-01', endDate: '2026-09-30' }).limit, 1500000);
});

test('仕訳の明細：個人は直接法で、私用分は事業主貸。貸借が一致する', () => {
  const book = makeBook('individual');
  const accounts = book.accounts.map((a) => fillHints('individual', [a])[0] || a);
  const by = Object.fromEntries(accounts.map((a) => [a.name, a]));
  const list = [asset({ accountId: by['車両運搬具'].id, category: 'vehicle', cost: 2000000, usefulLife: 6, businessRatio: 60 })];
  const { lines, total, errors } = depreciationLines({ assets: list, periods: [book.period], period: book.period, accounts, entityType: 'individual' });
  assert.deepEqual(errors, []);
  // 年額 2,000,000×0.167=334,000、事業分 200,400、私用分 133,600
  assert.equal(total, 334000);
  assert.deepEqual(lines.map((l) => [l.side, accounts.find((a) => a.id === l.accountId).name, l.amount]), [
    ['debit', '減価償却費', 200400],
    ['debit', '事業主貸', 133600],
    ['credit', '車両運搬具', 334000],
  ]);
});

test('仕訳の明細：法人の有形固定資産は減価償却累計額、無形は直接法', () => {
  const book = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  const accounts = book.accounts.map((a) => fillHints('corporation', [a])[0] || a);
  const by = Object.fromEntries(accounts.map((a) => [a.name, a]));
  const list = [
    asset({ id: 't', accountId: by['工具器具備品'].id, startedOn: '2026-04-01', acquiredOn: '2026-04-01', cost: 400000, usefulLife: 4 }),
    asset({ id: 's', accountId: by['ソフトウェア'].id, category: 'intangible', startedOn: '2026-04-01', acquiredOn: '2026-04-01', cost: 500000, usefulLife: 5 }),
  ];
  const { lines } = depreciationLines({ assets: list, periods: [book.period], period: book.period, accounts, entityType: 'corporation' });
  const credit = lines.filter((l) => l.side === 'credit').map((l) => [accounts.find((a) => a.id === l.accountId).name, l.amount]);
  assert.deepEqual(credit, [['減価償却累計額', 100000], ['ソフトウェア', 100000]]);
});

test('減価償却の仕訳は source で見分ける', () => {
  assert.deepEqual(findDepreciationJournals([{ id: 1 }, { id: 2, source: 'depreciation' }]).map((j) => j.id), [2]);
});

test('種類に合う初期値の科目はテンプレートのコードで選ぶ（名前は使わない）', async () => {
  const { defaultAssetAccount } = await import('../js/depreciation.js');
  for (const entityType of ['individual', 'corporation']) {
    const { accounts } = makeBook(entityType);
    const tangible = accounts.filter((a) => a.group === 'tangible_fixed_assets' && a.normalSide === 'debit');
    const id = defaultAssetAccount(entityType, 'tools', tangible);
    assert.equal(accounts.find((a) => a.id === id).name, '工具器具備品');
    const vid = defaultAssetAccount(entityType, 'vehicle', tangible);
    assert.equal(accounts.find((a) => a.id === vid).name, '車両運搬具');
  }
});

test('前の会計ソフトの帳簿価額を引き継ぐ：定額法は引き継いだ期首から取得価額×償却率で続ける', () => {
  const a = asset({ acquiredOn: '2022-01-01', startedOn: '2022-01-01', carryOn: '2026-01-01', carryBook: 600000 });
  const rows = depreciationSchedule(a, [P(2026)]);
  assert.equal(rows[0].startDate, '2026-01-01'); // 引き継ぐ前の年分は出さない
  assert.deepEqual([rows[0].opening, rows[0].amount, rows[0].closing], [600000, 125000, 475000]);
  assert.equal(rows.at(-1).closing, 1); // 最後は1円を残す
  assert.equal(depreciationFor(asset({ acquiredOn: '2022-01-01', startedOn: '2022-01-01' }), [P(2026)], P(2026)).opening, 500000); // 引き継がなければ計算どおり
});

test('前の会計ソフトの帳簿価額を引き継ぐ：定率法は改定取得価額があればそれで計算する', () => {
  const base = { method: 'declining', acquiredOn: '2018-01-01', startedOn: '2018-01-01', carryOn: '2026-01-01', carryBook: 200000 };
  // 200,000×0.250＝50,000 は償却保証額 79,090 未満 → 引き継いだ年に切り替え（200,000×0.334）
  assert.equal(depreciationSchedule(asset(base), [P(2026)])[0].amount, 66800);
  const r = depreciationSchedule(asset({ ...base, carryRevisedBase: 237305 }), [P(2026)])[0];
  assert.deepEqual([r.amount, r.base, r.switched], [79259, 237305, true]);
});

test('前の会計ソフトの帳簿価額を引き継ぐ：1円だけ残っている資産は期首・期末とも1円', () => {
  const a = asset({ acquiredOn: '2010-01-01', startedOn: '2010-01-01', carryOn: '2026-01-01', carryBook: 1 });
  assert.equal(depreciationSchedule(a, [P(2026)]).length, 0);
  assert.equal(openingBook(a, [P(2026)], P(2026)), 1);
});

test('前の会計ソフトの帳簿価額を引き継ぐ：入力の検証', () => {
  const b = makeBook('individual');
  const ctx = { entityType: 'individual', accounts: b.accounts };
  const ok = { accountId: b.byName['工具器具備品'].id, acquiredOn: '2022-01-01', startedOn: '2022-01-01', carryOn: '2026-01-01', carryBook: 600000 };
  assert.deepEqual(validateAsset(asset(ok), ctx), {});
  assert.match(validateAsset(asset({ ...ok, carryOn: '2022-01-01' }), ctx).carryBook, /使い始めた日より後/);
  assert.match(validateAsset(asset({ ...ok, carryBook: 1000001 }), ctx).carryBook, /取得価額以下/);
  assert.match(validateAsset(asset({ ...ok, carryBook: 0 }), ctx).carryBook, /1円以上/);
  assert.match(validateAsset(asset({ ...ok, method: 'lump3', cost: 150000, usefulLife: null }), ctx).carryBook, /定額法・定率法/);
  assert.match(validateAsset(asset({ ...ok, carryRevisedBase: 300000 }), ctx).carryRevisedBase, /定率法/);
  assert.match(validateAsset(asset({ ...ok, disposedOn: '2025-06-30' }), ctx).carryBook, /除却/);
});
