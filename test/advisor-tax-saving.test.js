import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taxSavingPlan, SAFETY_ANNUAL_MAX, SHOKIBO_ANNUAL_MAX, idecoAnnualMax, MARGINAL_STEP } from '../js/advisor/tax-saving.js';
import { forecastTaxes } from '../js/advisor/tax-forecast.js';
import { createAsset } from '../js/models.js';
import { makeBook } from './helpers.js';

const byId = (r, id) => r.proposals.find((p) => p.id === id);

function book(entityType, { sales = 20000000, cost = 3000000, startDate, endDate } = {}) {
  const b = makeBook(entityType, { startDate, endDate });
  const d = b.period.startDate.slice(0, 7);
  const journals = [b.j(`${d}-10`, [['普通預金', sales]], [['売上高', sales]]), b.j(`${d}-20`, [['消耗品費', cost]], [['現金', cost]])];
  return { b, journals };
}
const plan = (entityType, opts = {}, extra = {}) => {
  const { b, journals } = book(entityType, opts);
  const settings = { entityType, taxStatus: 'exempt', filing: 'blue', ...extra.settings };
  const period = { ...b.period, ...extra.period };
  return { b, r: taxSavingPlan({ settings, accounts: b.accounts, period, journals, actualJournals: journals, assets: extra.assets || [], amounts: extra.amounts || {} }), settings, period, journals };
};

test('減る税金は、費用を足して納税予測を計算し直した差（法人）', () => {
  const { b, r, settings, period, journals } = plan('corporation');
  const safety = byId(r, 'safety');
  assert.equal(safety.amount, SAFETY_ANNUAL_MAX);
  // 手で同じ仕訳を足して比べる
  const cash = b.byName['現金'];
  const misc = b.byName['雑費'];
  const extra = { id: 'x', periodId: period.id, date: period.endDate, source: 'forecast', adjusting: true, lines: [
    { side: 'debit', accountId: misc.id, subAccountId: null, amount: SAFETY_ANNUAL_MAX, taxCategory: 'none', memo: '' },
    { side: 'credit', accountId: cash.id, subAccountId: null, amount: SAFETY_ANNUAL_MAX, taxCategory: 'none', memo: '' },
  ] };
  const after = forecastTaxes({ settings, accounts: b.accounts, period, journals: [...journals, extra], actualJournals: journals });
  assert.equal(safety.saving, r.base.incomeTaxes - after.incomeTaxes);
  assert.ok(safety.saving > 0 && safety.saving < SAFETY_ANNUAL_MAX);
  // 限界税率：100万円の費用で減る税金
  assert.equal(r.marginal.amount, MARGINAL_STEP);
  assert.ok(r.marginal.permille > 200 && r.marginal.permille < 500);
  assert.ok(byId(r, 'bonus') && byId(r, 'officer'));
  assert.equal(byId(r, 'shokibo'), undefined);
});

test('画面で入れた金額で計算し、上限を超えた分は上限に収める', () => {
  const { r } = plan('corporation', {}, { amounts: { safety: 600000, prepaid: 300000, sme: 99999999 } });
  assert.equal(byId(r, 'safety').amount, 600000);
  assert.equal(byId(r, 'prepaid').amount, 300000);
  assert.ok(byId(r, 'prepaid').saving > 0);
  assert.equal(byId(r, 'sme').amount, 3000000);
});

test('所得が出ない見込みなら、費用の提案は「効果なし」で税金は減らない', () => {
  const { r } = plan('corporation', { sales: 1000000, cost: 3000000 });
  const safety = byId(r, 'safety');
  assert.equal(safety.applicable, false);
  assert.match(safety.reason, /所得が出ない/);
  assert.equal(safety.amount, 0);
  assert.equal(safety.saving, 0);
});

test('少額特例：当期に使った額を上限から引く。中小法人でなければ使えない', () => {
  const { b } = book('corporation');
  const asset = createAsset({ name: 'PC', acquiredOn: '2026-05-01', startedOn: '2026-05-01', cost: 350000, usefulLife: 4, method: 'sme', assetAccountId: b.byName['工具器具備品'].id });
  const { r } = plan('corporation', {}, { assets: [asset] });
  assert.equal(byId(r, 'sme').max, 3000000 - 350000);
  const big = plan('corporation', {}, { period: { corporateTax: { sme: false } } }).r;
  assert.equal(byId(big, 'sme').applicable, false);
  assert.equal(byId(big, 'sme').saving, 0);
});

test('個人：小規模企業共済・iDeCo は所得控除に足して計算し、入力済みの掛金を上限から引く', () => {
  const { r } = plan('individual', {}, { period: { incomeTaxReturn: { smallBusinessAid: 240000 } } });
  const s = byId(r, 'shokibo');
  assert.equal(s.amount, SHOKIBO_ANNUAL_MAX - 240000);
  assert.ok(s.saving > 0);
  // 所得控除は事業税を減らさないので、同じ額の経費より減る税金が少ない
  const asExpense = plan('individual', {}, { period: { incomeTaxReturn: { smallBusinessAid: 240000 } }, amounts: { safety: s.amount } }).r;
  assert.ok(byId(asExpense, 'safety').saving > s.saving);
  assert.equal(byId(r, 'ideco').amount, idecoAnnualMax(2027));
  assert.equal(idecoAnnualMax(2026), 816000);
  assert.equal(byId(r, 'bonus'), undefined);
});

test('個人：白色なら青色申告と少額特例は使えない旨、青色で控除が最大でなければ差を出す', () => {
  const white = plan('individual', {}, { settings: { filing: 'white' } }).r;
  assert.equal(byId(white, 'blue').timing, 'next');
  assert.ok(byId(white, 'blue').saving > 0);
  assert.equal(byId(white, 'sme').applicable, false);
  assert.match(byId(white, 'sme').reason, /白色/);
  const low = plan('individual', {}, { period: { blueReturn: { deduction: 100000 } } }).r;
  assert.equal(byId(low, 'blue').amount, 550000);
  assert.ok(byId(low, 'blue').saving > 0);
  // 既定（65万円）なら令和8年分は提案しない。令和9年分は75万円を提案
  assert.equal(byId(plan('individual').r, 'blue'), undefined);
  const y27 = plan('individual', { startDate: '2027-01-01', endDate: '2027-12-31' }).r;
  assert.equal(byId(y27, 'blue').amount, 100000);
});

test('消費税：いまの方法より少ない方法があれば差を出す', () => {
  const { b } = book('corporation');
  const journals = [b.j('2026-03-10', [['普通預金', 11000000]], [['売上高', 11000000]]), b.j('2026-06-20', [['消耗品費', 1100000]], [['現金', 1100000]])];
  const settings = { entityType: 'corporation', taxStatus: 'taxable' };
  const r = taxSavingPlan({ settings, accounts: b.accounts, period: b.period, journals, actualJournals: journals });
  const c = byId(r, 'consumption');
  assert.ok(c, '提案がある');
  const cmp = r.base.consumption.compare;
  const best = Math.min(...Object.values(cmp).filter((x) => !x.unavailable).map((x) => x.total));
  assert.equal(c.saving, cmp[r.base.consumption.method].total - best);
});
