// 金額の表示単位（円・千円・百万円）：換算は整数だけで行い、合計は円で計算してから換算する
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toUnit, formatAmount, unitCaption, normalizeUnit, YEN_UNIT, MAX_AMOUNT } from '../js/money.js';
import { trialBalanceDoc, balanceSheetReportDoc, balanceSheetAccountDoc } from '../js/print-forms.js';
import { trialBalance } from '../js/ledger.js';
import { buildStatements } from '../js/statements.js';
import { makeBook } from './helpers.js';

const K = { unit: 'thousand', rounding: 'truncate' };
const KR = { unit: 'thousand', rounding: 'round' };
const M = { unit: 'million', rounding: 'truncate' };
const MR = { unit: 'million', rounding: 'round' };

test('換算：切り捨ては 0 の側へ、四捨五入は 0.5 を 0 から遠い側へ（マイナスも絶対値で同じ）', () => {
  assert.equal(toUnit(1_234_567, K), 1_234);
  assert.equal(toUnit(1_234_567, KR), 1_235);
  assert.equal(toUnit(-1_234_567, K), -1_234);
  assert.equal(toUnit(-1_234_567, KR), -1_235);
  assert.equal(toUnit(1_234_499, KR), 1_234);
  assert.equal(toUnit(1_234_500, KR), 1_235, 'ちょうど 0.5 は切り上げ');
  assert.equal(toUnit(-1_500, KR), -2);
  assert.equal(toUnit(999, K), 0);
  assert.equal(toUnit(999, KR), 1);
  assert.equal(toUnit(12_345_678, M), 12);
  assert.equal(toUnit(12_500_000, MR), 13);
  assert.equal(toUnit(1_234_567, YEN_UNIT), 1_234_567, '円はそのまま');
  assert.equal(toUnit(MAX_AMOUNT, K), 999_999_999, '上限の金額でも整数で割り切れる');
  assert.equal(toUnit(MAX_AMOUNT, MR), 1_000_000);
  for (const n of [0, 1, 999, 1000, 1001, 123_456_789_012, -7, -999_999]) {
    for (const u of [K, KR, M, MR]) assert.ok(Number.isSafeInteger(toUnit(n, u)));
  }
});

test('表示：3桁区切り・マイナスは△。単位未満のマイナスは △0 でマイナスを残す', () => {
  assert.equal(formatAmount(12_345_678, K), '12,345');
  assert.equal(formatAmount(-12_345_678, K), '△12,345');
  assert.equal(formatAmount(-400, K), '△0');
  assert.equal(formatAmount(400, K), '0');
  assert.equal(formatAmount(0, K), '0');
  assert.equal(formatAmount(-1_234, YEN_UNIT), '△1,234');
  assert.equal(formatAmount(NaN, K), '');
});

test('単位の表記と、分からない値は円・切り捨てにする', () => {
  assert.equal(unitCaption(YEN_UNIT), '（単位：円）');
  assert.equal(unitCaption(K), '（単位：千円・千円未満切り捨て）');
  assert.equal(unitCaption(MR), '（単位：百万円・百万円未満四捨五入）');
  assert.deepEqual(normalizeUnit({ unit: 'billion', rounding: 'ceil' }), { unit: 'yen', rounding: 'truncate' });
  assert.deepEqual(normalizeUnit({ unit: 'thousand', rounding: 'round', zero: true }), KR, '印刷条件の他の値は落とす');
  assert.deepEqual(normalizeUnit(), YEN_UNIT);
});

// 現金 12,345,678円＋普通預金 8,765,432円＝資産合計 21,111,110円
// 千円・切り捨て：内訳は 12,345＋8,765＝21,110 だが、合計は 21,111,110円を換算して 21,111（1千円のずれ）
function book() {
  const b = makeBook('corporation');
  b.opening([['現金', 12_345_678], ['普通預金', 8_765_432], ['資本金', 21_111_110]]);
  return b;
}

test('試算表の印刷：千円にすると各欄を換算し、合計は円の合計を換算する（内訳の和とずれることがある）', () => {
  const b = book();
  const tb = trialBalance({ accounts: b.accounts, period: b.period, journals: [] });
  const yen = trialBalanceDoc(tb, { head: {}, entityType: 'corporation', carriedLabel: '前期繰越', format: 'balance' });
  assert.equal(yen.unit, '（単位：円）');
  const doc = trialBalanceDoc(tb, { head: {}, entityType: 'corporation', carriedLabel: '前期繰越', format: 'balance', unit: K });
  assert.equal(doc.unit, '（単位：千円・千円未満切り捨て）');
  const rows = doc.blocks[1].rows;
  const find = (label) => rows.find((r) => (typeof r.cells[0] === 'string' ? r.cells[0] : r.cells[0].text) === label);
  assert.equal(find('現金').cells[4], '12,345');
  assert.equal(find('普通預金').cells[4], '8,765');
  assert.equal(find('資産合計').cells[4], '21,111');
  assert.equal(find('資産合計').cells[5], '100.0%', '構成比は円の金額で計算する');
  assert.equal(find('純資産合計').cells[4], '21,111', '資産合計と純資産合計は同じ円の金額を換算するのでそろう');
  const total = trialBalanceDoc(tb, { head: {}, entityType: 'corporation', carriedLabel: '前期繰越', unit: KR }).blocks[1].rows;
  const cash = total.find((r) => r.cells[2]?.text === '現金');
  assert.equal(cash.cells[0], '12,346', '合計残高試算表の各欄も換算する（四捨五入）');
});

test('決算書の印刷：報告式・勘定式とも単位を換算し、資産合計＝負債・純資産合計の表示はそろう', () => {
  const b = book();
  const { bs } = buildStatements({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals: [] });
  assert.equal(bs.totalAssets, bs.totalLiabilitiesAndEquity);
  const acc = balanceSheetAccountDoc(bs, { head: {}, entityType: 'corporation', unit: M });
  const last = acc.blocks[0].rows.at(-1).cells;
  assert.equal(last[1].text, '21');
  assert.equal(last[3].text, '21');
  assert.equal(acc.unit, '（単位：百万円・百万円未満切り捨て）');
  const rep = balanceSheetReportDoc(bs, { head: {}, entityType: 'corporation', unit: K });
  const cashRow = rep.blocks[0].rows.find((r) => r.cells[0].text === '現金');
  assert.equal(cashRow.cells[1], '12,345');
  const grand = rep.blocks[0].rows.filter((r) => ['資産合計', '負債・純資産合計'].includes(r.cells[0].text)).map((r) => r.cells[2].text);
  assert.deepEqual(grand, ['21,111', '21,111'], '資産合計と負債・純資産合計は同じ円の金額を換算するのでそろう');
  assert.equal(rep.unit, '（単位：千円・千円未満切り捨て）');
});
