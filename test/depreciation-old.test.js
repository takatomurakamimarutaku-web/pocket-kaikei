import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OLD_RATE_TABLE, DECLINING_250_TABLE, RATE_TABLE, methodVariant, methodLabel, ratesFor, depreciationSchedule, validateAsset } from '../js/depreciation.js';

const P = (y) => ({ id: `p${y}`, startDate: `${y}-01-01`, endDate: `${y}-12-31` });
const asset = (fields) => ({ id: 'a1', name: '機械', category: 'machinery', accountId: 'acc', acquiredOn: '2001-01-01', startedOn: '2001-01-01', cost: 5000000, method: 'straight', usefulLife: 5, businessRatio: 100, disposedOn: null, ...fields });
const amounts = (rows) => rows.map((r) => r.amount);
const ctx = { entityType: 'individual', accounts: [{ id: 'acc', group: 'tangible_fixed_assets', normalSide: 'debit' }, { id: 'sw', group: 'intangible_fixed_assets', normalSide: 'debit' }] };

test('償却率表：旧定額法・旧定率法・250%定率法が2〜50年そろう（国税庁の償却率表と照合した値）', () => {
  for (let n = 2; n <= 50; n++) {
    assert.ok(OLD_RATE_TABLE[n] && DECLINING_250_TABLE[n], `${n}年`);
    // 250%定率法の償却率は 定額法の償却率×2.5（小数3位未満を四捨五入した値）
    assert.ok(Math.abs(DECLINING_250_TABLE[n][0] - (1000 / n) * 2.5) <= 1 || n === 2 || n === 3, `${n}年の250%`);
  }
  assert.deepEqual(OLD_RATE_TABLE[5], [200, 369]); // No.2105 の計算例
  assert.deepEqual(OLD_RATE_TABLE[10], [100, 206]);
  assert.deepEqual(DECLINING_250_TABLE[10], [250, 334, 4448]);
  assert.deepEqual(DECLINING_250_TABLE[50], [50, 53, 1072]);
});

test('方法の区分：使い始めた日・取得日で旧定額法・旧定率法・250%・200%定率法を選ぶ', () => {
  assert.equal(methodVariant(asset({ startedOn: '2007-03-31', acquiredOn: '2007-03-01' })), 'old_straight');
  assert.equal(methodVariant(asset({ startedOn: '2007-04-01', acquiredOn: '2007-03-01' })), 'straight');
  assert.equal(methodVariant(asset({ method: 'declining', startedOn: '2007-03-31', acquiredOn: '2007-03-01' })), 'old_declining');
  // 平成19年3月31日以前に取得し4月1日以後に使い始めたものは、使い始めた日に取得したとみなす
  assert.equal(methodVariant(asset({ method: 'declining', startedOn: '2007-04-01', acquiredOn: '2007-03-01' })), 'declining250');
  assert.equal(methodVariant(asset({ method: 'declining', startedOn: '2012-04-01', acquiredOn: '2012-03-31' })), 'declining250');
  assert.equal(methodVariant(asset({ method: 'declining', startedOn: '2012-04-01', acquiredOn: '2012-04-01' })), 'declining200');
  assert.equal(methodLabel(asset({ startedOn: '2007-03-31', acquiredOn: '2007-03-01' })), '旧定額法');
  assert.equal(methodLabel(asset({ method: 'declining', acquiredOn: '2010-01-01', startedOn: '2010-01-01' })), '定率法');
  assert.equal(methodLabel(asset({ method: 'lump3' })), '一括償却');
  assert.deepEqual(ratesFor(asset({ method: 'declining', acquiredOn: '2010-01-01', startedOn: '2010-01-01', usefulLife: 10 })), { rate: 250, revised: 334, guarantee: 4448 });
  assert.deepEqual(ratesFor(asset({ method: 'declining', acquiredOn: '2020-01-01', startedOn: '2020-01-01', usefulLife: 10 })), { rate: 200, revised: 250, guarantee: 6552 });
});

test('旧定額法：国税庁 No.2105 の例（500万円・5年）。95%までは90万円ずつ、翌年から5年で1円まで均等に償却', () => {
  const rows = depreciationSchedule(asset({}), [P(2001)]);
  assert.deepEqual(amounts(rows), [900000, 900000, 900000, 900000, 900000, 250000, 50000, 50000, 50000, 50000, 49999]);
  assert.equal(rows.at(-1).closing, 1);
  assert.equal(rows[0].base, 4500000); // 償却の基礎になる金額＝取得価額×90%
  assert.equal(rows[0].rate, 200);
  assert.ok(rows.slice(6).every((r) => r.equal && r.base === 250000 && r.rate === null));
  assert.ok(!rows[5].equal);
});

test('旧定率法：国税庁 No.2105 の例（500万円・5年・0.369）。95%到達の翌年から均等償却して12年目に1円', () => {
  const rows = depreciationSchedule(asset({ method: 'declining' }), [P(2001)]);
  // 1円未満は切り捨て（No.5410 の計算例と同じ）。国税庁の No.2105 の例は切り上げているため、7年目は 65,606円（この計算は 65,608円）
  assert.deepEqual(amounts(rows), [1845000, 1164195, 734607, 463537, 292491, 184562, 65608, 50000, 50000, 50000, 50000, 49999]);
  assert.equal(rows[6].closing, 250000);
  assert.equal(rows.at(-1).closing, 1);
  assert.equal(rows.reduce((s, r) => s + r.amount, 0), 4999999);
});

test('旧定額法：無形は残存価額0で0円まで、月の途中の除却は月数で按分（均等償却も）', () => {
  const sw = depreciationSchedule(asset({ category: 'intangible', accountId: 'sw', cost: 1000000 }), [P(2001)]);
  assert.deepEqual(amounts(sw), [200000, 200000, 200000, 200000, 200000]);
  assert.equal(sw.at(-1).closing, 0);
  // 均等償却の2年目（8年目）の6月に除却：50,000×6/12
  const d = depreciationSchedule(asset({ disposedOn: '2008-06-15' }), [P(2001)]);
  assert.deepEqual(amounts(d).slice(6), [50000, 25000]);
  assert.equal(d.length, 8);
});

test('旧定額法：前の帳簿の帳簿価額を引き継ぐ（均等償却の途中でも取得価額×5%から計算）', () => {
  const rows = depreciationSchedule(asset({ carryOn: '2026-01-01', carryBook: 150000 }), [P(2026)]);
  assert.deepEqual(amounts(rows), [50000, 50000, 49999]);
  assert.ok(rows.every((r) => r.equal));
});

test('250%定率法：平成22年取得・100万円・10年。保証額を下回った年から改定償却率で、最後は1円', () => {
  const rows = depreciationSchedule(asset({ method: 'declining', acquiredOn: '2010-01-01', startedOn: '2010-01-01', cost: 1000000, usefulLife: 10 }), [P(2010)]);
  assert.deepEqual(amounts(rows), [250000, 187500, 140625, 105468, 79101, 59326, 44495, 44583, 44583, 44318]);
  assert.equal(rows.findIndex((r) => r.switched), 7);
  assert.equal(rows[7].base, 133485);
  assert.equal(rows[7].rate, 334);
  assert.equal(rows.at(-1).closing, 1);
});

test('特別償却：使い始めた期間に 取得価額×率（月数按分しない）を普通償却に加え、翌年から普通償却で1円まで', () => {
  const a = asset({ acquiredOn: '2026-07-01', startedOn: '2026-07-01', cost: 3000000, usefulLife: 10, specialRate: 30, specialName: '中小企業投資促進税制' });
  const rows = depreciationSchedule(a, [P(2026)]);
  assert.deepEqual([rows[0].ordinary, rows[0].special, rows[0].amount], [150000, 900000, 1050000]);
  assert.deepEqual(amounts(rows).slice(1), [300000, 300000, 300000, 300000, 300000, 300000, 149999]);
  assert.ok(rows.slice(1).every((r) => r.special === 0));
  assert.equal(rows.at(-1).closing, 1);
  // 即時償却（100%）：取得価額−普通償却費。1円を残す
  const now = depreciationSchedule({ ...a, method: 'declining', specialRate: 100, specialName: '中小企業経営強化税制' }, [P(2026)]);
  assert.equal(now.length, 1);
  assert.deepEqual([now[0].ordinary, now[0].special, now[0].closing], [300000, 2699999, 1]);
  // 個人の事業割合は合計にかける
  const ind = depreciationSchedule({ ...a, businessRatio: 80 }, [P(2026)]);
  assert.equal(ind[0].business, 840000);
});

test('特別償却の検証：率・名前・方法・引き継ぎ', () => {
  const ok = asset({ acquiredOn: '2026-07-01', startedOn: '2026-07-01', specialRate: 30, specialName: '中小企業投資促進税制' });
  assert.deepEqual(validateAsset(ok, ctx), {});
  assert.match(validateAsset({ ...ok, specialRate: 0 }, ctx).specialRate, /1〜100/);
  assert.match(validateAsset({ ...ok, specialRate: 101 }, ctx).specialRate, /1〜100/);
  assert.match(validateAsset({ ...ok, specialName: '' }, ctx).specialName, /制度の名前/);
  assert.match(validateAsset({ ...ok, method: 'lump3', cost: 150000, usefulLife: null }, ctx).specialRate, /定額法・定率法/);
  assert.match(validateAsset({ ...ok, acquiredOn: '2006-01-01', startedOn: '2006-01-01' }, ctx).specialRate, /平成19年3月31日以前/);
  assert.match(validateAsset({ ...ok, acquiredOn: '2020-01-01', startedOn: '2020-01-01', carryOn: '2026-01-01', carryBook: 1000 }, ctx).specialRate, /引き継ぐ/);
  assert.match(validateAsset({ ...asset({}), specialName: 'x' }, ctx).specialRate, /率を入力/);
  // 率表の確認：200%定率法は変えていない
  assert.deepEqual(RATE_TABLE[10], [100, 200, 250, 6552]);
});
