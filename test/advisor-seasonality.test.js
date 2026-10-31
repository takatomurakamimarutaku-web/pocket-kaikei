import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecastLanding, validateForecast, cleanForecast } from '../js/advisor/forecast.js';
import { seasonalAdvice, adviceSuggestsLastYear } from '../js/advisor/seasonality.js';
import { createPeriod } from '../js/models.js';
import { monthsInPeriod } from '../js/period.js';
import { makeBook } from './helpers.js';

// 前期（2025年）：保険料は3月だけ36万円、賞与は7月・12月、売上は夏に多い。消耗品費は毎月同じ
function books() {
  const b = makeBook('corporation');
  const prevPeriod = createPeriod({ startDate: '2025-01-01', endDate: '2025-12-31' });
  const pj = [];
  for (const m of monthsInPeriod(prevPeriod)) {
    const mm = Number(m.slice(5));
    const sales = [7, 8].includes(mm) ? 3000000 : 1000000;
    pj.push({ ...b.j(`${m}-10`, [['普通預金', sales]], [['売上高', sales]]), periodId: prevPeriod.id });
    pj.push({ ...b.j(`${m}-15`, [['消耗品費', 50000]], [['現金', 50000]]), periodId: prevPeriod.id });
    if (mm === 3) pj.push({ ...b.j(`${m}-20`, [['保険料', 360000]], [['普通預金', 360000]]), periodId: prevPeriod.id });
    if (mm === 7 || mm === 12) pj.push({ ...b.j(`${m}-25`, [['賞与', 800000]], [['普通預金', 800000]]), periodId: prevPeriod.id });
  }
  // 当期：1〜5月が実績（保険料の3月分は入っている）
  const journals = [];
  for (const m of monthsInPeriod(b.period).slice(0, 5)) {
    journals.push(b.j(`${m}-10`, [['普通預金', 1100000]], [['売上高', 1100000]]));
    journals.push(b.j(`${m}-15`, [['消耗品費', 50000]], [['現金', 50000]]));
    if (m === '2026-03') journals.push(b.j(`${m}-20`, [['保険料', 360000]], [['普通預金', 360000]]));
  }
  return { b, prev: { period: prevPeriod, journals: pj }, journals };
}

test('月ごとに入れる：見込みの月はその金額、検証と保存の形', () => {
  const { b, prev, journals } = books();
  const id = b.byName['賞与'].id;
  const input = { actualThrough: '2026-05', methods: { [id]: 'monthly' }, monthly: { [id]: { '2026-07': 900000, '2026-12': 900000 } } };
  assert.deepEqual(validateForecast(input), []);
  const r = forecastLanding({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals, prev, input, today: '2026-06-10' });
  const row = r.rows.find((x) => x.account.id === id);
  assert.equal(row.forecast, 1800000);
  assert.equal(row.forecastMonthly['2026-07'], 900000);
  assert.equal(row.forecastMonthly['2026-08'], 0);
  assert.equal(row.prevMonthly[6], 800000);
  assert.match(validateForecast({ monthly: { a: { '2026-13': 1 } } })[0], /月/);
  assert.match(validateForecast({ monthly: { a: { '2026-07': 1.5 } } })[0], /整数/);
  // 月ごとの金額は「月ごとに入れる」の科目だけ・0円の月は持たない
  assert.deepEqual(cleanForecast({ methods: { a: 'monthly', b: 'average' }, monthly: { a: { '2026-07': 5, '2026-08': 0 }, b: { '2026-07': 9 } } }).monthly, { a: { '2026-07': 5 } });
});

test('前期の推移から、賞与・保険の年払い（特別な月）と売上の季節変動を見つける', () => {
  const { b, prev, journals } = books();
  // 賞与・保険料は直近平均で見込む（＝賞与の月が見込みに入らない）
  const input = { actualThrough: '2026-05', methods: { [b.byName['賞与'].id]: 'average', [b.byName['保険料'].id]: 'average', [b.byName['売上高'].id]: 'average' } };
  const landing = forecastLanding({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals, prev, input, today: '2026-06-10' });
  const advice = seasonalAdvice({ landing });
  const of = (name) => advice.find((a) => a.account.name === name);
  const bonus = of('賞与');
  assert.equal(bonus.kind, 'special');
  assert.deepEqual(bonus.months.map((x) => x.month), ['2026-07', '2026-12']);
  assert.equal(bonus.missing, true);
  assert.match(bonus.reason, /賞与/);
  assert.ok(adviceSuggestsLastYear(bonus, landing.rows.find((r) => r.account.name === '賞与')));
  // 保険料の3月は実績の月なので「見込みに入っていない」ではない
  const ins = of('保険料');
  assert.equal(ins.months[0].month, '2026-03');
  assert.equal(ins.months[0].actual, true);
  assert.equal(ins.missing, false);
  assert.match(ins.reason, /保険/);
  // 売上は季節変動。多い月は7月・8月
  const sales = of('売上高');
  assert.equal(sales.kind, 'seasonal');
  assert.deepEqual(sales.months.map((x) => x.month), ['2026-07', '2026-08']);
  // 毎月同じ科目は出さない
  assert.equal(of('消耗品費'), undefined);
  // 見込みに入っていないものが先
  assert.equal(advice[0].missing, true);
});

test('前期の同じ月×伸び率なら、特別な月も見込みに入る', () => {
  const { b, prev, journals } = books();
  const landing = forecastLanding({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals, prev, input: { actualThrough: '2026-05' }, today: '2026-06-10' });
  const bonus = seasonalAdvice({ landing }).find((a) => a.account.name === '賞与');
  assert.equal(bonus.missing, false);
  assert.ok(bonus.months.every((x) => x.forecast > 0));
});

test('前期の帳簿が無ければ助言しない', () => {
  const { b, journals } = books();
  const landing = forecastLanding({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals, input: { actualThrough: '2026-05' }, today: '2026-06-10' });
  assert.deepEqual(seasonalAdvice({ landing }), []);
});
