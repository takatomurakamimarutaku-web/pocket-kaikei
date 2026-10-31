import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companySize, comparablePrice, netAssetPrice, shareValuation, figuresFrom, validateSuccession, DEFAULT_SUCCESSION } from '../js/advisor/share-value.js';
import { buildStatements } from '../js/statements.js';
import { makeBook } from './helpers.js';

test('会社規模：従業員70人以上は大会社、総資産と従業員は低い方、取引金額との高い方', () => {
  assert.equal(companySize({ industry: 'other', employees: 70, totalAssets: 0, sales: 0 }).size, 'large');
  // その他：総資産5億・従業員36人 → 0.90。取引金額1億 → 0.60。高い方の0.90
  const a = companySize({ industry: 'other', employees: 36, totalAssets: 500000000, sales: 100000000 });
  assert.deepEqual([a.byAssets, a.bySales, a.size, a.L], ['m90', 'm60', 'm90', 90]);
  // 総資産が大きくても従業員5人以下なら総資産側は小会社。取引金額8,000万未満なら小会社
  assert.equal(companySize({ industry: 'other', employees: 5, totalAssets: 900000000, sales: 79999999 }).size, 'small');
  // 卸売業：取引金額30億以上は大会社、7億以上は0.90
  assert.equal(companySize({ industry: 'wholesale', employees: 3, totalAssets: 0, sales: 3000000000 }).size, 'large');
  assert.equal(companySize({ industry: 'wholesale', employees: 3, totalAssets: 0, sales: 700000000 }).size, 'm90');
  // 小売・サービス業：総資産2.5億・従業員21人 → 0.75
  assert.equal(companySize({ industry: 'retail', employees: 21, totalAssets: 250000000, sales: 0 }).size, 'm75');
  assert.equal(companySize({ industry: 'retail', employees: 20, totalAssets: 250000000, sales: 0 }).size, 'm60');
});

test('類似業種比準価額：50円換算の株数で比べ、端数は評価明細書のとおり切り捨てる', () => {
  // 資本金等1,000万・200株（1株5万円）→ 50円換算 200,000株
  const r = comparablePrice({ capital: 10000000, shares: 200, dividends: 0, profit: 20000000, netAssets: 100000000, peer: { A: 300, B10: 50, C: 30, D: 300 }, kind: 'medium' });
  assert.equal(r.n50, 200000);
  assert.deepEqual([r.b10, r.c, r.d], [0, 100, 500]);
  assert.deepEqual([r.rb, r.rc, r.rd, r.ratio], [0, 333, 166, 166]);
  assert.equal(r.per50x10, 2988); // 300 × 1.66 × 0.6 = 298.8円
  assert.equal(r.price, 298800); // × 50,000円 ÷ 50円
  // 配当があれば b/B も入る
  const withDiv = comparablePrice({ capital: 10000000, shares: 200, dividends: 1000000, profit: 20000000, netAssets: 100000000, peer: { A: 300, B10: 50, C: 30, D: 300 }, kind: 'large' });
  assert.equal(withDiv.b10, 50); // 5.0円
  assert.equal(withDiv.rb, 100);
  assert.equal(comparablePrice({ capital: 0, shares: 1, dividends: 0, profit: 0, netAssets: 0, peer: { A: 1, B10: 1, C: 1, D: 1 }, kind: 'small' }), null);
});

test('純資産価額：含み益の37%を引く。含み損は引かない', () => {
  const r = netAssetPrice({ totalAssets: 300000000, liabilities: 200000000, gain: 50000000, shares: 1000 });
  assert.equal(r.tax, 18500000);
  assert.equal(r.price, Math.floor((150000000 - 18500000) / 1000));
  assert.equal(netAssetPrice({ totalAssets: 300000000, liabilities: 200000000, gain: -10000000, shares: 1000 }).price, 90000);
  assert.equal(netAssetPrice({ totalAssets: 100, liabilities: 500, shares: 10 }).price, 0);
});

test('評価額：中会社は類似×L＋純資産×(1−L) と純資産の低い方。利益を下げると下がる', () => {
  const figures = { totalAssets: 300000000, liabilities: 200000000, netAssets: 100000000, capital: 10000000, profit: 20000000, sales: 500000000 };
  const input = { ...DEFAULT_SUCCESSION, industry: 'other', employees: 30, shares: 200, peer: { A: 300, B10: 50, C: 30, D: 300 } };
  const r = shareValuation(input, figures);
  assert.equal(r.size.size, 'm90'); // 取引金額5億 → 0.90
  const mixed = Math.floor((r.comparable.price * 90 + r.net.price * 10) / 100);
  assert.equal(r.price, Math.min(mixed, r.net.price));
  assert.equal(r.total, r.price * 200);
  const cut = shareValuation({ ...input, profitCut: 15000000 }, figures);
  assert.ok(cut.price < r.price);
  // 類似業種が未入力なら純資産価額だけ
  const netOnly = shareValuation({ ...input, peer: { A: 0, B10: 0, C: 0, D: 0 } }, figures);
  assert.equal(netOnly.price, netOnly.net.price);
  assert.match(netOnly.notes[0], /純資産価額だけ/);
});

test('帳簿から数字を取り、入力を検証する', () => {
  const b = makeBook('corporation');
  b.opening([['普通預金', 13000000], ['資本金', 10000000], ['繰越利益剰余金', 3000000]]);
  const journals = [b.j('2026-03-10', [['普通預金', 5000000]], [['売上高', 5000000]])];
  const { bs, pl } = buildStatements({ entityType: 'corporation', accounts: b.accounts, period: b.period, journals });
  const f = figuresFrom({ bs, pl, taxableIncome: 5000000, incomeTaxes: 1000000 });
  assert.equal(f.totalAssets, 18000000);
  assert.equal(f.capital, 10000000);
  assert.equal(f.netAssets, 17000000);
  assert.equal(f.liabilities, 1000000);
  assert.equal(f.sales, 5000000);
  assert.deepEqual(validateSuccession({ ...DEFAULT_SUCCESSION, shares: 200 }), []);
  assert.match(validateSuccession({ ...DEFAULT_SUCCESSION, industry: 'x' })[0], /業種/);
  assert.match(validateSuccession({ ...DEFAULT_SUCCESSION, peer: { A: -1, B10: 0, C: 0, D: 0 } })[0], /類似業種/);
});
