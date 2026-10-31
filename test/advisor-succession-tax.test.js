import { test } from 'node:test';
import assert from 'node:assert/strict';
import { giftTaxCalendar, giftTaxSettlement, inheritanceTax, transferTax, successionOptions, validatePlan, DEFAULT_PLAN } from '../js/advisor/succession-tax.js';

test('暦年贈与：国税庁 No.4408 の計算例', () => {
  // 特例贈与財産 500万円：(500万−110万)×15%−10万＝485,000円
  assert.equal(giftTaxCalendar(5000000, { special: true }), 485000);
  // 一般贈与財産 500万円：390万×20%−25万＝530,000円
  assert.equal(giftTaxCalendar(5000000, { special: false }), 530000);
  assert.equal(giftTaxCalendar(1100000, { special: true }), 0);
  // 1億円・特例：9,890万×55%−640万＝47,995,000円
  assert.equal(giftTaxCalendar(100000000, { special: true }), 47995000);
});

test('相続時精算課税：110万円と2,500万円を引いて20%', () => {
  assert.deepEqual(giftTaxSettlement(20000000), { tax: 0, special: 18900000 });
  // 5,000万円：(5,000万−110万−2,500万)×20%＝4,780,000円
  assert.equal(giftTaxSettlement(50000000).tax, 4780000);
  assert.equal(giftTaxSettlement(50000000, { usedSpecial: 25000000 }).tax, 9780000);
});

test('相続税の総額：配偶者と子2人、課税価格1億円', () => {
  // 基礎控除 4,800万円、課税遺産 5,200万円。配偶者 2,600万×15%−50万＝340万、子 1,300万×15%−50万＝145万×2 → 630万円
  const r = inheritanceTax({ estate: 100000000, spouse: true, children: 2 });
  assert.equal(r.basic, 48000000);
  assert.equal(r.total, 6300000);
  assert.equal(inheritanceTax({ estate: 40000000, spouse: true, children: 1 }).total, 0);
  // 子1人のみ、2億円：基礎控除3,600万、1億6,400万×40%−1,700万＝4,860万円
  assert.equal(inheritanceTax({ estate: 200000000, spouse: false, children: 1 }).total, 48600000);
});

test('株式の譲渡：20.315%、取得費が売値の5%未満なら概算取得費', () => {
  const t = transferTax({ price: 100000000, cost: 10000000 });
  assert.equal(t.gain, 90000000);
  assert.equal(t.national, 13783500); // 1,350万＋28.35万
  assert.equal(t.local, 4500000);
  const r = transferTax({ price: 100000000, cost: 1000000 });
  assert.equal(r.usedCost, 5000000);
  assert.ok(r.roughCost);
});

test('承継先ごとの引継ぎ方', () => {
  const base = { price: 5000, shares: 10000, capital: 10000000, today: '2026-10-31' };
  const child = successionOptions({ ...base, plan: { ...DEFAULT_PLAN, successor: 'child', otherEstate: 50000000 } });
  assert.equal(child.value, 50000000);
  assert.deepEqual(child.options.map((o) => o.id), ['gift', 'settlement', 'inherit', 'scheme']);
  assert.equal(child.options.find((o) => o.id === 'settlement').tax, 4780000);
  assert.equal(child.options.find((o) => o.id === 'scheme').deferred, 4780000);
  const emp = successionOptions({ ...base, plan: { ...DEFAULT_PLAN, successor: 'employee', otherEstate: 50000000 } });
  assert.deepEqual(emp.options.map((o) => o.id), ['gift', 'inherit', 'scheme', 'sale']);
  // 遺贈は2割加算
  const inhC = child.options.find((o) => o.id === 'inherit').tax;
  assert.equal(emp.options.find((o) => o.id === 'inherit').tax, inhC + Math.floor(inhC / 5));
  assert.equal(emp.options.find((o) => o.id === 'sale').cash, 50000000);
  const third = successionOptions({ ...base, plan: { ...DEFAULT_PLAN, successor: 'third', salePrice: 80000000 } });
  assert.deepEqual(third.options.map((o) => o.id), ['sale']);
  // 特例措置の期限後は使えない
  const late = successionOptions({ ...base, today: '2028-01-01', plan: { ...DEFAULT_PLAN } });
  assert.ok(late.options.find((o) => o.id === 'scheme').disabled);
  assert.ok(!late.ideas.some((i) => i.title.startsWith('事業承継税制')));
  // 一部の株式だけ
  assert.equal(successionOptions({ ...base, plan: { ...DEFAULT_PLAN, transferShares: 2000 } }).value, 10000000);
});

test('入力の検証', () => {
  assert.deepEqual(validatePlan(DEFAULT_PLAN), []);
  assert.ok(validatePlan({ ...DEFAULT_PLAN, successor: 'x' }).length);
  assert.ok(validatePlan({ ...DEFAULT_PLAN, giftYears: 0 }).length);
  assert.ok(validatePlan({ ...DEFAULT_PLAN, children: 1.5 }).length);
});
