import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  corporationTaxAmount,
  entertainmentCalc,
  lossCarryforward,
  corporateTaxReturn,
  carryOverInput,
  validateCorporateTax,
  cleanCorporateTax,
  corporateTaxCsvRows,
  applyRate,
  DEFAULT_CORPORATE_TAX,
} from '../js/corporate-tax.js';
import { makeBook } from './helpers.js';

test('法人税額：中小法人は年800万円以下15%・超える部分23.2%（課税標準は1,000円未満切捨て）', () => {
  const r = corporationTaxAmount({ income: 10000999, months: 12, startDate: '2026-04-01' });
  assert.equal(r.base, 10000000);
  assert.deepEqual(r.tiers.map((t) => [t.amount, t.rate, t.tax]), [[8000000, 15000, 1200000], [2000000, 23200, 464000]]);
  assert.equal(r.tax, 1664000);
  // 令和9年4月1日以後に開始する事業年度は本則19%（特例の期限が延びていない場合）
  assert.equal(corporationTaxAmount({ income: 10000000, months: 12, startDate: '2027-04-01' }).tax, 1520000 + 464000);
  // 適用除外事業者は19%、中小法人以外は全額23.2%
  assert.equal(corporationTaxAmount({ income: 10000000, months: 12, startDate: '2026-04-01', excluded: true }).tax, 1984000);
  assert.equal(corporationTaxAmount({ income: 10000000, months: 12, startDate: '2026-04-01', sme: false }).tax, 2320000);
});

test('法人税額：所得が年10億円を超える事業年度は17%（令和7年4月1日以後開始）、月数が12未満なら800万円を月割', () => {
  const high = corporationTaxAmount({ income: 1200000000, months: 12, startDate: '2026-04-01' });
  assert.equal(high.tiers[0].rate, 17000);
  assert.equal(high.tax, 1360000 + 276544000);
  assert.equal(corporationTaxAmount({ income: 1200000000, months: 12, startDate: '2025-03-01' }).tiers[0].rate, 15000);
  assert.equal(corporationTaxAmount({ income: 9000000, months: 6, startDate: '2026-04-01' }).limit, 4000000);
  // 800万円×7/12＝4,666,666 → 1,000円未満切捨て
  assert.equal(corporationTaxAmount({ income: 9000000, months: 7, startDate: '2026-04-01' }).limit, 4666000);
  // 大きな金額でも誤差が出ない
  assert.equal(applyRate(999999999999, 23200), 231999999999);
});

test('別表十五：中小法人は接待飲食費の50%と定額控除限度額（年800万円）の多いほう', () => {
  const fixed = entertainmentCalc({ amount: 9000000, dining: 6000000, months: 12 });
  assert.deepEqual([fixed.diningBase, fixed.fixedLimit, fixed.limit, fixed.disallowed, fixed.method], [3000000, 8000000, 8000000, 1000000, 'fixed']);
  const dining = entertainmentCalc({ amount: 20000000, dining: 18000000, months: 12 });
  assert.deepEqual([dining.limit, dining.disallowed, dining.method], [9000000, 11000000, 'dining']);
  // 中小法人以外は接待飲食費の50%だけ。6か月なら定額控除限度額は400万円
  assert.equal(entertainmentCalc({ amount: 1000000, dining: 400000, months: 12, sme: false }).disallowed, 800000);
  assert.equal(entertainmentCalc({ amount: 5000000, dining: 0, months: 6 }).fixedLimit, 4000000);
  // 接待飲食費は交際費等の額までで計算する
  assert.equal(entertainmentCalc({ amount: 100000, dining: 300000, months: 12 }).dining, 100000);
});

test('別表七(一)：欠損金は古い順に控除。中小法人は所得の100%、それ以外は50%。期限切れと当期の欠損金', () => {
  const losses = [
    { endDate: '2025-03-31', amount: 2000000 },
    { endDate: '2024-03-31', amount: 3000000 },
  ];
  const sme = lossCarryforward({ losses, income: 4000000, startDate: '2026-04-01', endDate: '2027-03-31' });
  assert.equal(sme.deducted, 4000000);
  assert.deepEqual(sme.rows.map((r) => [r.endDate, r.deducted, r.carry]), [['2024-03-31', 3000000, 0], ['2025-03-31', 1000000, 1000000]]);
  const big = lossCarryforward({ losses, income: 4000000, startDate: '2026-04-01', endDate: '2027-03-31', sme: false });
  assert.equal(big.limit, 2000000);
  assert.equal(big.carry, 3000000);
  // 平成30年4月1日より前に開始した事業年度の欠損金は9年。2015-04-01開始の欠損金は2026-04-01開始の期では期限切れ
  const old = lossCarryforward({ losses: [{ endDate: '2016-03-31', amount: 500000 }, { endDate: '2017-03-31', amount: 700000 }], income: 3000000, startDate: '2025-04-01', endDate: '2026-03-31' });
  assert.deepEqual(old.rows.map((r) => [r.expired, r.deducted]), [[true, 0], [false, 700000]]);
  const cur = lossCarryforward({ losses: [], income: -500000, startDate: '2026-04-01', endDate: '2027-03-31' });
  assert.deepEqual(cur.rows.map((r) => [r.endDate, r.carry, !!r.current]), [['2027-03-31', 500000, true]]);
});

// 2026-04-01〜2027-03-31（防衛特別法人税の対象）の法人。前期分の税80万円は未払法人税等を取り崩して納付
function sampleBook() {
  const b = makeBook('corporation', { startDate: '2026-04-01', endDate: '2027-03-31' });
  b.opening([
    ['普通預金', 5000000],
    ['未払法人税等', 800000],
    ['資本金', 3000000],
    ['繰越利益剰余金', 1200000],
  ]);
  const journals = [
    b.j('2026-04-30', [['普通預金', 30000000]], [['売上高', 30000000]]),
    b.j('2026-05-31', [['役員報酬', 12000000]], [['普通預金', 12000000]]),
    b.j('2026-05-31', [['接待交際費', 9000000]], [['普通預金', 9000000]]),
    b.j('2026-05-31', [['未払法人税等', 800000]], [['普通預金', 800000]], '前期分の法人税等'),
    b.j('2026-06-25', [['繰越利益剰余金', 500000]], [['普通預金', 500000]], '配当'),
    b.j('2026-11-30', [['法人税、住民税及び事業税', 500000]], [['普通預金', 500000]], '中間納付'),
    b.j('2027-03-31', [['法人税、住民税及び事業税', 1000000]], [['未払法人税等', 1000000]], '未払法人税等'),
  ];
  const input = {
    dividends: 500000,
    prior: { corp: 400000, local: 41200, defense: 0, pref: 28800, city: 180000, enterprise: 150000 },
    interim: { corp: 300000, local: 30000, defense: 0, pref: 20000, city: 50000, enterprise: 0 },
  };
  const enterpriseInput = { interimTax: 80000, interimSpecial: 20000 };
  return { ...b, journals, input, enterpriseInput };
}

test('別表四：当期利益から加算・減算して所得金額。留保と社外流出の合計が総額に一致', () => {
  const b = sampleBook();
  const r = corporateTaxReturn({ accounts: b.accounts, period: b.period, journals: b.journals, input: b.input, enterpriseInput: b.enterpriseInput });
  const s4 = r.schedule4;
  assert.equal(r.netIncome, 7500000);
  assert.deepEqual(s4.adds.map((a) => [a.key, a.amount]), [['nationalTax', 330000], ['residentTax', 70000], ['provision', 1000000], ['entertainment', 1000000]]);
  assert.deepEqual(s4.subs.map((a) => [a.key, a.amount]), [['enterprisePaid', 150000]]);
  assert.deepEqual(s4.income, { total: 9750000, retained: 8250000, outflow: 1500000 });
  assert.equal(s4.income.retained + s4.income.outflow, s4.income.total);
  assert.ok(r.entertainment.auto);
});

test('別表一・地方法人税・防衛特別法人税・住民税・事業税と納める税額', () => {
  const b = sampleBook();
  const r = corporateTaxReturn({ accounts: b.accounts, period: b.period, journals: b.journals, input: b.input, enterpriseInput: b.enterpriseInput });
  assert.deepEqual([r.corp.tax, r.corp.annual, r.corp.due], [1606000, 1606000, 1306000]);
  // 1,606,000 × 10.3% = 165,418 → 100円未満切捨て
  assert.deepEqual([r.local.base, r.local.annual, r.local.due], [1606000, 165400, 135400]);
  // 基準法人税額が基礎控除額500万円以下なので0（申告は必要）
  assert.deepEqual([r.defense.applies, r.defense.deduction, r.defense.base, r.defense.annual], [true, 5000000, 0, 0]);
  assert.deepEqual([r.resident.pref.taxPart, r.resident.pref.perCapitaPart, r.resident.pref.due], [16000, 20000, 16000]);
  assert.deepEqual([r.resident.city.taxPart, r.resident.city.perCapitaPart, r.resident.city.due], [96300, 50000, 96300]);
  assert.ok(r.enterprise.fromSchedule4);
  assert.deepEqual([r.enterprise.incomeTax, r.enterprise.special, r.enterprise.total], [474500, 175500, 394500 + 155500]);
  assert.deepEqual(r.dues.map((d) => d.key), ['corp', 'local', 'defense', 'pref', 'city', 'enterprise']);
  assert.equal(r.payableTarget, 2103700);
  assert.equal(r.dueTotal, 2103700);
  // 計上した未払法人税等（100万円）と違うことを知らせる
  assert.ok(r.warnings.some((w) => /未払法人税等/.test(w) && /2,103,700/.test(w)));
});

test('別表五(一)の検算：期首＋留保所得−中間・確定の法人税等＝期末。別表五(二)の納税充当金', () => {
  const b = sampleBook();
  const r = corporateTaxReturn({ accounts: b.accounts, period: b.period, journals: b.journals, input: b.input, enterpriseInput: b.enterpriseInput });
  const s51 = r.schedule51;
  assert.equal(s51.total.opening, 1350000);
  assert.equal(s51.total.closing, 7646300);
  assert.deepEqual(s51.check, { opening: 1350000, retained: 8250000, taxes: 1953700, expected: 7646300, closing: 7646300, diff: 0, ok: true });
  for (const row of s51.rows) assert.equal(row.opening - row.decrease + row.increase, row.closing, row.label);
  const retained = s51.rows.find((x) => x.label.startsWith('繰越損益金'));
  assert.deepEqual([retained.opening, retained.closing], [1200000, 8200000]);
  assert.deepEqual(s51.capitalRows.map((x) => [x.label, x.closing]), [['資本金', 3000000]]);
  const p = r.schedule52.provision;
  assert.deepEqual([p.opening, p.added, p.usedTaxes, p.usedEnterprise, p.usedOther, p.closing], [800000, 1000000, 650000, 150000, 0, 1000000]);
  const nat = r.schedule52.blocks[0];
  assert.equal(nat.label, '法人税、地方法人税及び防衛特別法人税');
  assert.deepEqual(nat.total, { opening: 441200, accrued: 1771400, provisionPaid: 441200, prepaidPaid: 0, expensePaid: 330000, closing: 1441400 });
  assert.equal(r.warnings.some((w) => /検算/.test(w)), false);
  // 配当の入力を忘れると検算が合わない
  const wrong = corporateTaxReturn({ accounts: b.accounts, period: b.period, journals: b.journals, input: { ...b.input, dividends: 0 }, enterpriseInput: b.enterpriseInput });
  assert.equal(wrong.schedule51.check.diff, -500000);
  assert.ok(wrong.warnings.some((w) => /検算/.test(w)));
});

test('期首の調整項目と留保の加算・減算は名前で突き合わせる。欠損金・所得税額控除・前期への引継ぎ', () => {
  const b = sampleBook();
  const input = {
    ...b.input,
    withholding: 15315,
    losses: [{ endDate: '2026-03-31', amount: 2000000 }],
    adjustments: [
      { label: '減価償却の償却超過額', side: 'add', kind: 'retained', amount: 120000 },
      { label: '役員給与の損金不算入額', side: 'add', kind: 'outflow', amount: 300000 },
      { label: '減価償却超過額の当期認容額', side: 'sub', kind: 'retained', amount: 50000 },
    ],
    openingAdjustments: [{ label: '減価償却超過額の当期認容額', amount: 50000 }],
  };
  const r = corporateTaxReturn({ accounts: b.accounts, period: b.period, journals: b.journals, input, enterpriseInput: b.enterpriseInput });
  // 9,750,000＋120,000＋300,000−50,000＋15,315＝10,135,315、欠損金200万円を控除
  assert.equal(r.schedule4.total.total, 10135315);
  assert.equal(r.schedule4.lossDeducted, 2000000);
  assert.equal(r.schedule4.income.total, 8135315);
  assert.equal(r.corp.withholdingUsed, 15315);
  const adj = r.schedule51.adjustRows;
  assert.deepEqual(adj.map((x) => [x.label, x.opening, x.decrease, x.increase, x.closing]), [
    ['減価償却超過額の当期認容額', 50000, 50000, 0, 0],
    ['減価償却の償却超過額', 0, 0, 120000, 120000],
  ]);
  assert.ok(r.schedule51.check.ok);
  const next = carryOverInput(r);
  assert.deepEqual(next.losses, []);
  assert.deepEqual(next.openingAdjustments, [{ label: '減価償却の償却超過額', amount: 120000 }]);
  assert.deepEqual(Object.keys(next.prior), ['corp', 'local', 'defense', 'pref', 'city', 'enterprise']);
  assert.equal(next.prior.corp, r.corp.due);
  assert.equal(next.prior.enterprise, r.enterprise.dueTax + r.enterprise.dueSpecial);
  assert.ok(corporateTaxCsvRows(r).some((row) => row[1] === '所得金額又は欠損金額' && row[2] === 8135315));
});

test('東京都の特別区・欠損の期・中間納付の還付', () => {
  const b = makeBook('corporation', { startDate: '2025-04-01', endDate: '2026-03-31' });
  b.opening([['普通預金', 1000000], ['資本金', 1000000]]);
  const journals = [b.j('2025-05-01', [['役員報酬', 1500000]], [['普通預金', 1500000]]), b.j('2025-11-30', [['法人税、住民税及び事業税', 100000]], [['普通預金', 100000]])];
  const input = { tokyo: true, prefRate: 7000, cityRate: 0, prefPerCapita: 70000, cityPerCapita: 0, interim: { corp: 100000 } };
  const r = corporateTaxReturn({ accounts: b.accounts, period: b.period, journals, input });
  assert.equal(r.defense.applies, false);
  assert.equal(r.schedule4.income.total, -1600000 + 100000); // 当期純損失に中間納付の法人税（損金経理）を加算
  assert.equal(r.corp.annual, 0);
  assert.equal(r.corp.due, -100000);
  assert.deepEqual(r.loss.rows.map((x) => [x.endDate, x.carry]), [['2026-03-31', 1500000]]);
  assert.deepEqual(r.dues.map((d) => [d.label, d.due]), [['法人税', -100000], ['地方法人税', 0], ['都民税', 70000], ['事業税・特別法人事業税', 0]]);
  assert.equal(r.schedule52.blocks.length, 3);
  assert.ok(r.schedule51.check.ok);
  assert.deepEqual(carryOverInput(r).losses, [{ endDate: '2026-03-31', amount: 1500000 }]);
});

test('入力の検証と保存用の整形', () => {
  assert.deepEqual(validateCorporateTax({ ...DEFAULT_CORPORATE_TAX }), []);
  assert.match(validateCorporateTax({ ...DEFAULT_CORPORATE_TAX, dividends: -1 }).join(), /0以上/);
  assert.match(validateCorporateTax({ ...DEFAULT_CORPORATE_TAX, adjustments: [{ label: '', side: 'add', kind: 'retained', amount: 1 }] }).join(), /項目名/);
  assert.match(validateCorporateTax({ ...DEFAULT_CORPORATE_TAX, losses: [{ endDate: '2026-02-30', amount: 1 }] }).join(), /終了日/);
  assert.match(validateCorporateTax({ ...DEFAULT_CORPORATE_TAX, prefRate: 25000 }).join(), /税率/);
  assert.equal(validateCorporateTax({ ...DEFAULT_CORPORATE_TAX, openingAdjustments: [{ label: '前払費用', amount: -3000 }] }).length, 0);
  const c = cleanCorporateTax({ extra: 1, prior: { corp: 5 }, adjustments: [{ label: ' 寄附金の損金不算入額 ', side: 'add', kind: 'outflow', amount: 10, x: 1 }], losses: [{ endDate: '2025-03-31', amount: 1 }, { endDate: '2024-03-31', amount: 2 }] });
  assert.equal('extra' in c, false);
  assert.deepEqual(c.prior, { corp: 5, local: 0, defense: 0, pref: 0, city: 0, enterprise: 0 });
  assert.deepEqual(c.adjustments, [{ label: '寄附金の損金不算入額', side: 'add', kind: 'outflow', amount: 10 }]);
  assert.deepEqual(c.losses.map((l) => l.endDate), ['2024-03-31', '2025-03-31']);
});

test('Repository：法人税の入力を期間に保存する。交際費の科目に目印が付く', async () => {
  const { openDB, ValidationError } = await import('../js/db.js');
  const { createPeriod, createSettings, createAccount } = await import('../js/models.js');
  const { templateAccounts } = await import('../js/accounts.js');
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const p = createPeriod({ startDate: '2026-04-01', endDate: '2027-03-31' });
  await repo.setup({ settings: createSettings({ businessName: 'テスト株式会社', entityType: 'corporation' }), period: p, accounts: templateAccounts('corporation').map((a) => createAccount(a)) });
  const saved = await repo.saveCorporateTax(p.id, { dividends: 100000, extra: 1, adjustments: [{ label: '寄附金の損金不算入額', side: 'add', kind: 'outflow', amount: 5000 }] });
  assert.equal(saved.corporateTax.dividends, 100000);
  assert.equal('extra' in saved.corporateTax, false);
  assert.equal(saved.corporateTax.adjustments.length, 1);
  await assert.rejects(repo.saveCorporateTax(p.id, { dividends: 1.5 }), ValidationError);
  const accounts = await repo.listAccounts();
  assert.equal(accounts.find((a) => a.code === '608').hint, 'entertainment');
});
