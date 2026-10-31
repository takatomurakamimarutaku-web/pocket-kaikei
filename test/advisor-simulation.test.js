import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateProfit, profitFigures, baseFromPl, taxesAtDelta, movingAnnual } from '../js/advisor/simulation.js';
import { forecastLanding } from '../js/advisor/forecast.js';
import { forecastTaxes } from '../js/advisor/tax-forecast.js';
import { createPeriod } from '../js/models.js';
import { monthsInPeriod } from '../js/period.js';
import { makeBook } from './helpers.js';

test('利益と損益分岐点：売上1,000万・変動費400万・固定費450万', () => {
  const f = profitFigures({ sales: 10000000, variable: 4000000, fixed: 4500000 });
  assert.equal(f.marginal, 6000000);
  assert.equal(f.marginalRate, 600);
  assert.equal(f.profit, 1500000);
  assert.equal(f.point, 7500000);
  assert.equal(f.safety, 250);
});

test('売上10%増・変動費率2ポイント増・固定費50万増、目標利益の必要売上高', () => {
  const r = simulateProfit({ sales: 10000000, variable: 4000000, fixed: 4500000 }, { salesPermille: 100, variableRateDelta: 20, fixedDelta: 500000, targetProfit: 2000000 });
  assert.equal(r.sim.sales, 11000000);
  assert.equal(r.sim.variable, 4620000); // 42%
  assert.equal(r.sim.fixed, 5000000);
  assert.equal(r.sim.profit, 1380000);
  // 必要売上高＝(固定費500万＋目標200万)÷限界利益率58%
  assert.equal(r.required, Math.ceil((7000000 * 1000) / 580));
  // 何も変えなければ元と同じ
  const same = simulateProfit({ sales: 10000000, variable: 4000000, fixed: 4500000 });
  assert.deepEqual(same.sim, same.base);
  assert.equal(same.required, null);
});

test('着地からの分け方は経営分析と同じ（変動費＝売上原価、固定費＝限界利益−経常利益）', () => {
  const b = baseFromPl('corporation', { sales: 10000000, cogs: 3000000, gross: 7000000, operating: 2000000, ordinary: 1800000 });
  assert.deepEqual(b, { sales: 10000000, variable: 3000000, fixed: 5200000 });
  // 売上0でも落ちない
  assert.deepEqual(baseFromPl('corporation', { sales: 0, cogs: 0, gross: 0, operating: -100, ordinary: -100 }), { sales: 0, variable: 0, fixed: 100 });
});

test('税引後：利益の差を仕訳1本にして計算し直す', () => {
  const b = makeBook('corporation');
  const journals = [b.j('2026-03-10', [['普通預金', 20000000]], [['売上高', 20000000]]), b.j('2026-06-20', [['消耗品費', 3000000]], [['現金', 3000000]])];
  const ctx = { settings: { entityType: 'corporation', taxStatus: 'exempt' }, accounts: b.accounts, period: b.period, journals, actualJournals: journals };
  const base = forecastTaxes(ctx).incomeTaxes;
  assert.equal(taxesAtDelta({ ...ctx, delta: 0 }), base);
  assert.ok(taxesAtDelta({ ...ctx, delta: 1000000 }) > base);
  assert.ok(taxesAtDelta({ ...ctx, delta: -1000000 }) < base);
});

test('年計：前期＋当期の月別から、12か月の合計を出す', () => {
  const b = makeBook('corporation');
  const prevPeriod = createPeriod({ startDate: '2025-01-01', endDate: '2025-12-31' });
  const pj = monthsInPeriod(prevPeriod).map((m) => ({ ...b.j(`${m}-10`, [['普通預金', 1000000]], [['売上高', 1000000]]), periodId: prevPeriod.id }));
  const journals = monthsInPeriod(b.period).slice(0, 6).map((m) => b.j(`${m}-10`, [['普通預金', 1200000]], [['売上高', 1200000]]));
  const landing = forecastLanding({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals, prev: { period: prevPeriod, journals: pj }, input: { actualThrough: '2026-06', methods: { [b.byName['売上高'].id]: 'average' } }, today: '2026-07-05' });
  const r = movingAnnual({ accounts: b.accounts, landing, prev: { period: prevPeriod, journals: pj } });
  assert.equal(r.months.length, 12);
  assert.equal(r.sales[0], 11 * 1000000 + 1200000); // 2025-02〜2026-01
  assert.equal(r.sales[5], 6 * 1000000 + 6 * 1200000); // 2025-07〜2026-06
  assert.equal(r.sales[11], 12 * 1200000);
  assert.equal(r.profit[11], 12 * 1200000);
  assert.equal(r.planFrom, 6);
  assert.equal(r.change.sales, Math.round(((14400000 - 12200000) * 1000) / 12200000));
  // 前期が無ければ12か月そろうのは最後の月だけ
  const only = movingAnnual({ accounts: b.accounts, landing, prev: null });
  assert.deepEqual(only.sales.slice(0, 11), Array(11).fill(null));
  assert.equal(only.sales[11], 12 * 1200000);
  assert.equal(only.change, null);
});
