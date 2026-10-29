import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holidaysOf, holidayName, isTaxHoliday, taxDueDate, weekday } from '../js/holidays.js';

test('国民の祝日：2026年（振替休日・国民の休日を含む）', () => {
  assert.deepEqual(Object.keys(holidaysOf(2026)).sort(), [
    '2026-01-01',
    '2026-01-12', // 成人の日（1月の第2月曜）
    '2026-02-11',
    '2026-02-23',
    '2026-03-20', // 春分の日
    '2026-04-29',
    '2026-05-03',
    '2026-05-04',
    '2026-05-05',
    '2026-05-06', // 5/3 が日曜 → 祝日でない最も近い日
    '2026-07-20',
    '2026-08-11',
    '2026-09-21',
    '2026-09-22', // 敬老の日と秋分の日にはさまれた日
    '2026-09-23',
    '2026-10-12',
    '2026-11-03',
    '2026-11-23',
  ]);
  assert.equal(holidayName('2026-05-06'), '休日');
  assert.equal(holidayName('2026-10-12'), 'スポーツの日');
  assert.equal(holidayName('2026-10-13'), null);
});

test('国民の祝日：2027年の春分・秋分、振替休日', () => {
  const y = holidaysOf(2027);
  assert.equal(y['2027-03-21'], '春分の日');
  assert.equal(y['2027-03-22'], '休日'); // 3/21 が日曜
  assert.equal(y['2027-09-23'], '秋分の日');
  assert.equal(y['2027-01-11'], '成人の日');
  assert.equal(y['2027-10-11'], 'スポーツの日');
  assert.equal(weekday('2027-03-21'), 0);
});

test('国税の期限の休日：土日・祝日・1月2日と3日・12月29日〜31日', () => {
  assert.equal(isTaxHoliday('2026-10-10'), true); // 土曜
  assert.equal(isTaxHoliday('2026-10-12'), true); // スポーツの日
  assert.equal(isTaxHoliday('2026-10-13'), false);
  assert.equal(isTaxHoliday('2027-01-04'), false);
  assert.equal(isTaxHoliday('2026-12-29'), true); // 火曜でも休日
  assert.equal(isTaxHoliday('2027-01-02'), true);
  assert.equal(isTaxHoliday('2027-01-03'), true);
});

test('国税の期限：休日なら翌日（続けば休日でない日まで）', () => {
  assert.equal(taxDueDate('2026-07-10'), '2026-07-10'); // 金曜
  assert.equal(taxDueDate('2026-05-10'), '2026-05-11'); // 日曜 → 月曜
  assert.equal(taxDueDate('2026-10-10'), '2026-10-13'); // 土 → 日 → スポーツの日 → 火曜
  assert.equal(taxDueDate('2027-01-10'), '2027-01-12'); // 日 → 成人の日 → 火曜
  assert.equal(taxDueDate('2027-07-10'), '2027-07-12'); // 土曜
  assert.equal(taxDueDate('2026-12-30'), '2027-01-04'); // 年末年始をまたぐ
});
