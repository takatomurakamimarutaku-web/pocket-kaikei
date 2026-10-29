import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYen, formatYen, formatYenBlank, MAX_AMOUNT } from '../js/money.js';

test('parseYen：全角・カンマ・円記号を整数にする', () => {
  assert.deepEqual(parseYen('1,000'), { ok: true, value: 1000 });
  assert.deepEqual(parseYen('１０００'), { ok: true, value: 1000 });
  assert.deepEqual(parseYen(' ¥12,345円 '), { ok: true, value: 12345 });
  assert.deepEqual(parseYen('１，２３４'), { ok: true, value: 1234 });
  assert.deepEqual(parseYen(500), { ok: true, value: 500 });
});

test('parseYen：小数・0・マイナス・空・文字・上限超えを拒否する', () => {
  assert.match(parseYen('100.5').error, /1円単位/);
  assert.match(parseYen('0').error, /1円以上/);
  assert.match(parseYen('-100').error, /1円以上/);
  assert.match(parseYen('').error, /入力してください/);
  assert.match(parseYen('abc').error, /数字/);
  assert.match(parseYen(String(MAX_AMOUNT + 1)).error, /1兆円未満/);
  assert.match(parseYen('99999999999999999').error, /大きすぎ/);
  assert.equal(parseYen(1.5).ok, false);
  assert.equal(parseYen(String(MAX_AMOUNT)).ok, true);
});

test('parseYen：期首残高用にマイナス・0を許可できる（△表記も読む）', () => {
  assert.deepEqual(parseYen('-1,000', { allowNegative: true }), { ok: true, value: -1000 });
  assert.deepEqual(parseYen('△1,000', { allowNegative: true }), { ok: true, value: -1000 });
  assert.deepEqual(parseYen('0', { allowZero: true }), { ok: true, value: 0 });
});

test('formatYen：3桁区切り、マイナスは△', () => {
  assert.equal(formatYen(1234567), '1,234,567');
  assert.equal(formatYen(-1000), '△1,000');
  assert.equal(formatYen(0), '0');
  assert.equal(formatYenBlank(0), '');
  assert.equal(formatYenBlank(-5), '△5');
});
