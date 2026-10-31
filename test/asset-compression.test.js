import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAsset, depreciationSchedule, canCompress, costBeforeCompression } from '../js/depreciation.js';
import { compressionErrors, compressionLines, compressionLossAccount, canSplit, findCompressionJournals } from '../js/asset-tools.js';
import { propertyTaxReturn } from '../js/property-tax.js';
import { makeBook } from './helpers.js';

const period = { id: 'p1', startDate: '2026-04-01', endDate: '2027-03-31' };
const periods = [period];

function machine(b, fields = {}) {
  // 300万円の機械を、100万円の補助金で圧縮記帳（cost は圧縮後の200万円）
  return { id: 'm', name: '加工機', category: 'machinery', accountId: b.byName['機械装置'].id, acquiredOn: '2026-06-01', startedOn: '2026-06-10', cost: 2000000, method: 'straight', usefulLife: 10, businessRatio: 100, quantity: 1, compressionAmount: 1000000, compressionOn: '2026-07-31', compressionName: 'ものづくり補助金', ...fields };
}

test('圧縮記帳：圧縮後の取得価額で償却し、圧縮前の取得価額は cost＋圧縮額', () => {
  const b = makeBook('corporation', { startDate: period.startDate, endDate: period.endDate });
  const ctx = { entityType: 'corporation', accounts: b.accounts };
  const a = machine(b);
  assert.deepEqual(validateAsset(a, ctx), {});
  assert.equal(costBeforeCompression(a), 3000000);
  assert.equal(costBeforeCompression({ cost: 500 }), 500);
  // 定額法10年（0.100）・10か月：2,000,000×0.100×10/12
  assert.equal(depreciationSchedule(a, periods)[0].amount, Math.floor((2000000 * 100) / 1000 * 10 / 12));
  // 一部の売却・除却はできない
  assert.equal(canSplit(a), false);
  assert.equal(canSplit({ ...a, compressionAmount: null }), true);
});

test('圧縮記帳の検証：方法・圧縮額・日付・名前', () => {
  const b = makeBook('corporation', { startDate: period.startDate, endDate: period.endDate });
  const ctx = { entityType: 'corporation', accounts: b.accounts };
  assert.ok(canCompress('straight') && canCompress('declining') && canCompress('none'));
  assert.ok(!canCompress('small') && !canCompress('sme') && !canCompress('lump3'));
  assert.ok(validateAsset(machine(b, { compressionAmount: 0 }), ctx).compressionAmount);
  assert.ok(validateAsset(machine(b, { compressionAmount: 1.5 }), ctx).compressionAmount);
  assert.ok(validateAsset(machine(b, { method: 'small', usefulLife: null, cost: 50000 }), ctx).compressionAmount);
  assert.ok(validateAsset(machine(b, { compressionOn: null }), ctx).compressionOn);
  assert.ok(validateAsset(machine(b, { compressionOn: '2026-05-01' }), ctx).compressionOn);
  assert.ok(validateAsset(machine(b, { compressionName: 'あ'.repeat(41) }), ctx).compressionName);
  assert.ok(validateAsset(machine(b, { compressionAmount: null, compressionOn: '2026-07-31' }), ctx).compressionAmount);
  assert.deepEqual(validateAsset(machine(b, { compressionAmount: null, compressionOn: null, compressionName: null }), ctx), {});
  // 帳簿価額を1円以上残す：圧縮後の取得価額（cost）は1円以上
  assert.ok(validateAsset(machine(b, { cost: 0 }), ctx).cost);
  assert.deepEqual(validateAsset(machine(b, { cost: 1, compressionAmount: 2999999 }), ctx), {});
  assert.ok(validateAsset({ ...machine(b), splitFrom: 'x' }, ctx).compressionAmount);
});

test('圧縮記帳の時期：使い始めた会計期間の中だけ（アプリより前の日付は記録だけ）', () => {
  const b = makeBook('corporation', { startDate: period.startDate, endDate: period.endDate });
  const next = { id: 'p2', startDate: '2027-04-01', endDate: '2028-03-31' };
  assert.deepEqual(compressionErrors(machine(b), [period, next]), []);
  assert.equal(compressionErrors(machine(b, { compressionOn: '2027-05-01' }), [period, next]).length, 1);
  assert.equal(compressionErrors(machine(b, { compressionOn: '2028-05-01' }), [period, next]).length, 1);
  assert.deepEqual(compressionErrors(machine(b, { acquiredOn: '2020-01-01', startedOn: '2020-01-01', compressionOn: '2020-03-01' }), [period, next]), []);
  assert.deepEqual(compressionErrors(machine(b, { compressionAmount: null }), [period]), []);
});

test('圧縮記帳の仕訳：法人は固定資産圧縮損 / 資産、個人は事業主借 / 資産。貸借一致', () => {
  const corp = makeBook('corporation', { startDate: period.startDate, endDate: period.endDate });
  const loss = corp.accounts.find((a) => a.hint === 'compression_loss');
  assert.equal(loss.name, '固定資産圧縮損');
  assert.equal(loss.group, 'extraordinary_losses');
  assert.equal(corp.accounts.find((a) => a.hint === 'subsidy_income').group, 'extraordinary_income');
  const a = machine(corp);
  const { lines, errors } = compressionLines({ asset: a, accounts: corp.accounts, entityType: 'corporation', lossAccountId: loss.id });
  assert.deepEqual(errors, []);
  assert.deepEqual(lines.map((l) => [l.side, l.accountId, l.amount, l.taxCategory]), [['debit', loss.id, 1000000, 'none'], ['credit', a.accountId, 1000000, 'none']]);
  assert.equal(lines[0].memo, '圧縮記帳 加工機（ものづくり補助金）');
  assert.equal(lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0), lines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amount, 0));
  assert.equal(compressionLines({ asset: a, accounts: corp.accounts, entityType: 'corporation', lossAccountId: '' }).errors.length, 1);

  const ind = makeBook('individual');
  const ia = { ...machine(ind), accountId: ind.byName['機械装置'].id };
  const r = compressionLines({ asset: ia, accounts: ind.accounts, entityType: 'individual' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.lines[0].accountId, ind.accounts.find((x) => x.role === 'owner_borrowings').id);
  assert.deepEqual(findCompressionJournals([{ source: 'asset_compression', sourceId: 'm' }, { source: 'asset_disposal', sourceId: 'm' }], 'm').length, 1);
});

test('固定資産圧縮損の科目が無い帳簿：732 から空いているコードで足す', () => {
  const corp = makeBook('corporation');
  const without = corp.accounts.filter((a) => a.hint !== 'compression_loss');
  assert.deepEqual(compressionLossAccount(without), { code: '732', name: '固定資産圧縮損', group: 'extraordinary_losses', normalSide: 'debit', defaultTaxCategory: 'none', sortOrder: 732, hint: 'compression_loss' });
  const taken = [...without, { code: '732' }, { code: '733' }];
  assert.equal(compressionLossAccount(taken).code, '734');
  assert.equal(compressionLossAccount(corp.accounts).hint, null);
});

test('償却資産申告は圧縮前の取得価額で申告する（固定資産税には圧縮記帳の制度が無い）', () => {
  const b = makeBook('corporation');
  const a = machine(b, { acquiredOn: '2025-06-01', startedOn: '2025-06-10', compressionOn: '2025-07-31' });
  const r = propertyTaxReturn({ assets: [a], year: 2026 });
  assert.equal(r.items[0].cost, 3000000);
  assert.equal(r.kinds.find((k) => k.increase).increase, 3000000);
});

test('別表十三（一）：当期に圧縮記帳した資産の圧縮限度額・超過額（全額補助は取得価額−1円）', async () => {
  const { schedule13, schedule13Item } = await import('../js/schedule13.js');
  const b = makeBook('corporation', { startDate: period.startDate, endDate: period.endDate });
  const ctx = { entityType: 'corporation', accounts: b.accounts };
  const a = machine(b, { compressionSubsidy: 1000000, compressionGrantor: '○○県' });
  assert.deepEqual(validateAsset(a, ctx), {});
  assert.ok(validateAsset(machine(b, { compressionSubsidy: 0 }), ctx).compressionSubsidy);
  assert.ok(validateAsset(machine(b, { compressionGrantor: 'あ'.repeat(41) }), ctx).compressionGrantor);
  const x = schedule13Item(a);
  assert.deepEqual([x.cost, x.subsidy, x.limit, x.reduced, x.excess, x.book, x.grantor], [3000000, 1000000, 1000000, 1000000, 0, 2000000, '○○県']);
  // 補助金等の額が空欄なら圧縮額と同じ
  assert.equal(schedule13Item(machine(b)).subsidy, 1000000);
  // 補助金より多く圧縮した：超過額
  assert.equal(schedule13Item(machine(b, { compressionSubsidy: 800000 })).excess, 200000);
  // 全額補助：限度は取得価額−1円
  const full = schedule13Item(machine(b, { cost: 1, compressionAmount: 2999999, compressionSubsidy: 3000000 }));
  assert.deepEqual([full.limit, full.excess], [2999999, 0]);
  // 当期に圧縮記帳した資産だけ（日付の順）
  const other = machine(b, { id: 'o', name: '前期', acquiredOn: '2025-05-01', startedOn: '2025-05-01', compressionOn: '2025-06-01' });
  const r = schedule13({ assets: [other, a, machine(b, { id: 'n', compressionAmount: null, compressionOn: null, compressionName: null })], period });
  assert.deepEqual(r.items.map((i) => i.asset.id), ['m']);
  assert.deepEqual(r.totals, { subsidy: 1000000, cost: 3000000, limit: 1000000, reduced: 1000000, excess: 0 });
});
