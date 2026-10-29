import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { corporateEnterpriseTax, individualEnterpriseTax, validateEnterpriseTax, parsePercent, formatPercent, DEFAULT_ENTERPRISE_TAX, OWNER_DEDUCTION } from '../js/enterprise-tax.js';

test('法人事業税：所得1,000万円（12か月・軽減税率）', () => {
  const r = corporateEnterpriseTax({ income: 10000500 });
  assert.equal(r.base, 10000000);
  assert.deepEqual(r.rows.map((x) => [x.amount, x.tax]), [[4000000, 140000], [4000000, 212000], [2000000, 140000]]);
  assert.equal(r.incomeTax, 492000);
  assert.equal(r.standardTax, 492000);
  assert.equal(r.special, 182000); // 492,000 × 37% = 182,040 → 100円未満切捨て
  assert.equal(r.total, 674000);
});

test('法人事業税：軽減税率不適用は全所得に7%、超過税率でも特別法人事業税は標準税率で計算', () => {
  const flat = corporateEnterpriseTax({ income: 10000000, reduced: false });
  assert.deepEqual(flat.rows.map((x) => [x.amount, x.tax]), [[10000000, 700000]]);
  assert.equal(flat.special, 259000);
  const tokyo = corporateEnterpriseTax({ income: 10000000, rates: [3750, 5665, 7480] });
  assert.equal(tokyo.incomeTax, 150000 + 226600 + 149600);
  assert.equal(tokyo.special, 182000);
});

test('法人事業税：6か月の事業年度は区分を月割、中間納付を差し引く、欠損なら0', () => {
  const r = corporateEnterpriseTax({ income: 5000000, months: 6, interimTax: 50000, interimSpecial: 10000 });
  assert.deepEqual(r.limits, [2000000, 4000000]);
  assert.deepEqual(r.rows.map((x) => x.amount), [2000000, 2000000, 1000000]);
  assert.equal(r.incomeTax, 70000 + 106000 + 70000);
  assert.equal(r.dueTax, 246000 - 50000);
  const m7 = corporateEnterpriseTax({ income: 9000000, months: 7 });
  assert.deepEqual(m7.limits, [2333000, 4666000]);
  const loss = corporateEnterpriseTax({ income: -300000 });
  assert.equal(loss.base, 0);
  assert.equal(loss.total, 0);
});

test('個人事業税：所得500万円・第1種5%（青色申告特別控除前の所得から290万円を引く）', () => {
  const r = individualEnterpriseTax({ income: 5000000 });
  assert.equal(r.base, 2100000);
  assert.equal(r.tax, 105000);
  assert.deepEqual([r.first, r.second], [53000, 52000]);
  // 滋賀県の例：所得475万円＋青色申告特別控除65万円−290万円＝250万円
  assert.equal(individualEnterpriseTax({ income: 4750000 + 650000 }).base, 2500000);
});

test('個人事業税：月割の事業主控除・3%の業種・課税されない業種・1万円以下は1回払い', () => {
  assert.equal(OWNER_DEDUCTION[5], 1209000);
  assert.equal(individualEnterpriseTax({ income: 2000000, months: 5 }).base, 791000);
  assert.equal(individualEnterpriseTax({ income: 4000000, industry: 'type3low' }).tax, 33000);
  assert.equal(individualEnterpriseTax({ income: 9000000, industry: 'exempt' }).tax, 0);
  const small = individualEnterpriseTax({ income: 3100000 });
  assert.deepEqual([small.tax, small.first, small.second], [10000, 10000, 0]);
  assert.equal(individualEnterpriseTax({ income: 2000000 }).tax, 0);
});

test('率の入力と検証', () => {
  assert.equal(parsePercent('3.75'), 3750);
  assert.equal(parsePercent('5.665'), 5665);
  assert.equal(parsePercent('7'), 7000);
  assert.ok(Number.isNaN(parsePercent('1.2345')));
  assert.equal(formatPercent(5300), '5.3');
  assert.deepEqual(validateEnterpriseTax({ ...DEFAULT_ENTERPRISE_TAX }), []);
  assert.match(validateEnterpriseTax({ ...DEFAULT_ENTERPRISE_TAX, months: 13 }).join(), /月数/);
  assert.match(validateEnterpriseTax({ ...DEFAULT_ENTERPRISE_TAX, rates: [3500, NaN, 7000] }).join(), /税率/);
});

test('Repository：事業税の入力を期間に保存する', async () => {
  const { openDB, ValidationError } = await import('../js/db.js');
  const { createPeriod, createSettings, createAccount } = await import('../js/models.js');
  const { templateAccounts } = await import('../js/accounts.js');
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const p = createPeriod({ startDate: '2026-01-01', endDate: '2026-12-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト商店', entityType: 'individual' }), period: p, accounts: templateAccounts('individual').map((a) => createAccount(a)) });
  const saved = await repo.saveEnterpriseTax(p.id, { industry: 'type3', months: 9, extra: 1 });
  assert.equal(saved.enterpriseTax.industry, 'type3');
  assert.equal(saved.enterpriseTax.rates.length, 3);
  assert.equal('extra' in saved.enterpriseTax, false);
  await assert.rejects(repo.saveEnterpriseTax(p.id, { industry: 'x' }), ValidationError);
});
