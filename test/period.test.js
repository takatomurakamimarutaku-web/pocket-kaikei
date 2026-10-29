import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidDate, addMonths, individualPeriod, defaultCorporateEnd, validatePeriod, isInPeriod, monthsInPeriod, monthRange } from '../js/period.js';

test('isValidDate：実在しない日付を拒否する（うるう年を含む）', () => {
  assert.equal(isValidDate('2024-02-29'), true);
  assert.equal(isValidDate('2026-02-29'), false);
  assert.equal(isValidDate('2026-13-01'), false);
  assert.equal(isValidDate('2026/01/01'), false);
});

test('addMonths：月末は丸める', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-11-15', 3), '2027-02-15');
});

test('個人は暦年固定、法人は12か月以内', () => {
  assert.deepEqual(individualPeriod(2026), { startDate: '2026-01-01', endDate: '2026-12-31' });
  assert.deepEqual(validatePeriod(individualPeriod(2026), 'individual'), {});
  assert.ok(validatePeriod({ startDate: '2026-04-01', endDate: '2027-03-31' }, 'individual').startDate);
  assert.equal(defaultCorporateEnd('2026-04-01'), '2027-03-31');
  assert.equal(defaultCorporateEnd('2024-03-01'), '2025-02-28');
  assert.deepEqual(validatePeriod({ startDate: '2026-04-01', endDate: '2027-03-31' }, 'corporation'), {});
  assert.deepEqual(validatePeriod({ startDate: '2026-06-15', endDate: '2027-03-31' }, 'corporation'), {}, '設立初年度は短くてよい');
  assert.match(validatePeriod({ startDate: '2026-04-01', endDate: '2027-04-01' }, 'corporation').endDate, /12か月以内/);
  assert.match(validatePeriod({ startDate: '2026-04-01', endDate: '2026-03-31' }, 'corporation').endDate, /開始日以降/);
  assert.ok(validatePeriod({ startDate: 'x', endDate: '2026-03-31' }, 'corporation').startDate);
});

test('期間内判定・月の列挙・月範囲', () => {
  const p = { startDate: '2026-04-01', endDate: '2027-03-31' };
  assert.equal(isInPeriod('2026-04-01', p), true);
  assert.equal(isInPeriod('2027-04-01', p), false);
  const months = monthsInPeriod(p);
  assert.equal(months.length, 12);
  assert.equal(months[0], '2026-04');
  assert.equal(months[11], '2027-03');
  assert.equal(monthsInPeriod({ startDate: '2026-06-15', endDate: '2026-08-10' }).join(), '2026-06,2026-07,2026-08');
  assert.deepEqual(monthRange(p, '2026-05', '2026-06'), { from: '2026-05-01', to: '2026-06-30' });
  assert.deepEqual(monthRange(p), { from: '2026-04-01', to: '2027-03-31' });
  assert.deepEqual(monthRange({ startDate: '2026-06-15', endDate: '2026-08-10' }, '2026-06', '2026-08'), { from: '2026-06-15', to: '2026-08-10' });
});
