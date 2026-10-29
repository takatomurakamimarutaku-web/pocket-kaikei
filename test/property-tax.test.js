import { test } from 'node:test';
import assert from 'node:assert/strict';
import { residualRates, assessedValue, propertyTaxReturn, ptEligibility, acquisitionYear, eraOf, fiscalYearLabel, defaultPtYear } from '../js/property-tax.js';
import { validateAsset } from '../js/depreciation.js';
import { propertyTaxCsv } from '../js/csv.js';
import { buildSample } from '../js/sample.js';

// 大分市「減価率表」の減価残存率（前年中取得・前年前取得）
const OITA = {
  2: [658, 316], 3: [732, 464], 4: [781, 562], 5: [815, 631], 6: [840, 681], 7: [860, 720], 8: [875, 750], 9: [887, 774], 10: [897, 794],
  11: [905, 811], 12: [912, 825], 13: [919, 838], 14: [924, 848], 15: [929, 858], 16: [933, 866], 17: [936, 873], 18: [940, 880], 19: [943, 886], 20: [945, 891],
  21: [948, 896], 22: [950, 901], 23: [952, 905], 24: [954, 908], 25: [956, 912], 26: [957, 915], 27: [959, 918], 28: [960, 921], 29: [962, 924], 30: [963, 926],
  31: [964, 928], 32: [965, 931], 33: [966, 933], 34: [967, 934], 35: [968, 936], 36: [969, 938], 37: [970, 940], 38: [970, 941], 39: [971, 943], 40: [972, 944],
  41: [972, 945], 42: [973, 947], 43: [974, 948], 44: [974, 949], 45: [975, 950], 46: [975, 951], 47: [976, 952], 48: [976, 953], 49: [977, 954], 50: [977, 955],
};

let seq = 0;
const asset = (o) => ({ id: `a${(seq += 1)}`, name: `資産${seq}`, category: 'tools', method: 'straight', usefulLife: 5, quantity: 1, disposedOn: null, ...o });

test('減価残存率：耐用年数2〜50年のすべてが自治体の減価残存率表と一致する', () => {
  for (const [life, rates] of Object.entries(OITA)) assert.deepEqual(residualRates(Number(life)), rates, `耐用年数${life}年`);
  assert.equal(residualRates(1), null);
  assert.equal(residualRates(51), null);
});

test('評価額：甲府市の計算例（舗装・エアコン・看板）と課税標準額・税額', () => {
  const pave = asset({ name: '舗装', category: 'structure', cost: 2700000, usefulLife: 15, acquiredOn: '2025-09-10' });
  const aircon = asset({ name: 'エアコン', cost: 500000, usefulLife: 6, acquiredOn: '2024-05-20' });
  const sign = asset({ name: '看板', cost: 1600000, usefulLife: 3, acquiredOn: '2024-12-01' });
  assert.equal(assessedValue({ ...pave, life: 15 }, 2026).value, 2508300);
  assert.equal(assessedValue({ ...aircon, life: 6 }, 2026).value, 286020);
  assert.equal(assessedValue({ ...sign, life: 3 }, 2026).value, 543436); // 543,436.8 → 1円未満切捨て
  const r = propertyTaxReturn({ assets: [pave, aircon, sign], year: 2026 });
  assert.equal(r.valueTotal, 3337756);
  assert.equal(r.taxBase, 3337000);
  assert.equal(r.tax, 46700);
  assert.equal(r.exempt, false);
  assert.deepEqual(r.kinds.map((k) => k.total), [2700000, 0, 0, 0, 0, 2100000]);
  assert.deepEqual(r.kinds[0].increase, 2700000);
  assert.deepEqual(r.kinds[5].before, 2100000);
});

test('評価額の下限は取得価額の5%。取得の翌年度より前は0', () => {
  assert.deepEqual(assessedValue({ cost: 1000000, acquiredOn: '2018-06-01', life: 2 }, 2026), { value: 50000, residual: 316, years: 8 });
  assert.equal(assessedValue({ cost: 1000000, acquiredOn: '2026-03-01', life: 5 }, 2026).value, 0);
  assert.equal(assessedValue({ cost: 1000000, acquiredOn: '2026-03-01', life: 5 }, 2027).value, 815000);
  assert.equal(assessedValue({ cost: 1000000, acquiredOn: '2026-03-01', life: 5 }, 2028).value, 514265);
});

test('1月1日の取得は前の年の取得（賦課期日に持っている増加資産）', () => {
  assert.equal(acquisitionYear('2026-01-01'), 2025);
  assert.equal(acquisitionYear('2026-01-02'), 2026);
  const r = propertyTaxReturn({ assets: [asset({ cost: 300000, acquiredOn: '2026-01-01' })], year: 2026 });
  assert.equal(r.items[0].increase, true);
  assert.equal(r.items[0].value, Math.floor((300000 * 815) / 1000));
});

test('対象外の資産・確認が必要な資産・少額特例・減少資産の振り分け', () => {
  const assets = [
    asset({ name: '店舗', category: 'building', cost: 10000000, usefulLife: 22, acquiredOn: '2020-04-01' }),
    asset({ name: 'ソフト', category: 'intangible', cost: 500000, acquiredOn: '2024-04-01' }),
    asset({ name: 'タブレット', method: 'lump3', usefulLife: null, cost: 150000, acquiredOn: '2025-04-01' }),
    asset({ name: '椅子', method: 'small', usefulLife: null, cost: 80000, acquiredOn: '2025-04-01' }),
    asset({ name: 'パソコン', method: 'sme', usefulLife: null, ptLife: 4, cost: 280000, acquiredOn: '2025-07-01' }),
    asset({ name: '複合機', method: 'sme', usefulLife: null, cost: 250000, acquiredOn: '2025-08-01' }),
    asset({ name: '営業車', category: 'vehicle', cost: 2000000, usefulLife: 6, acquiredOn: '2023-04-01' }),
    asset({ name: 'フォークリフト', category: 'vehicle', ptInclude: 'yes', cost: 1500000, usefulLife: 4, acquiredOn: '2023-04-01' }),
    asset({ name: '内装', category: 'building_equipment', cost: 3000000, usefulLife: 15, acquiredOn: '2022-04-01' }),
    asset({ name: '旧レジ', cost: 400000, usefulLife: 5, acquiredOn: '2021-04-01', disposedOn: '2025-06-30', disposalType: 'retire' }),
    asset({ name: '昔の機械', category: 'machinery', cost: 900000, usefulLife: 10, acquiredOn: '2015-04-01', disposedOn: '2024-03-31' }),
  ];
  const r = propertyTaxReturn({ assets, year: 2026 });
  assert.deepEqual(r.items.map((it) => it.asset.name), ['フォークリフト', 'パソコン', '複合機']);
  assert.deepEqual(r.missingLife.map((a) => a.name), ['複合機']);
  assert.deepEqual(r.decreases.map((d) => [d.asset.name, d.reason]), [['旧レジ', '滅失']]);
  assert.deepEqual(r.review.map((x) => [x.asset.name, x.include]), [['営業車', false], ['フォークリフト', true], ['内装', false]]);
  assert.deepEqual(r.excluded.map((x) => x.asset.name), ['店舗', 'ソフト', 'タブレット', '椅子', '営業車', '内装']);
  const tools = r.kinds[5];
  assert.deepEqual([tools.before, tools.decrease, tools.increase, tools.total], [400000, 400000, 530000, 530000]);
  assert.equal(r.kinds[4].total, 1500000);
  assert.equal(r.total, 2030000);
  // フォークリフト（4年）：2024年度 781 → 2025・2026年度 562
  assert.equal(r.items[0].value, Math.floor((Math.floor((Math.floor((1500000 * 781) / 1000) * 562) / 1000) * 562) / 1000));
  assert.equal(r.exempt, true);
  assert.equal(r.tax, 0);
  assert.equal(ptEligibility(assets[2]).fixed, true);
});

test('和暦・年度・既定の年度', () => {
  assert.deepEqual(eraOf('2019-05-01'), { era: '令和', year: 1, month: 5 });
  assert.deepEqual(eraOf('2019-04-30'), { era: '平成', year: 31, month: 4 });
  assert.equal(fiscalYearLabel(2027), '令和9年度');
  assert.equal(defaultPtYear('2026-10-29'), 2027);
  assert.equal(defaultPtYear('2027-01-31'), 2027);
});

test('台帳の検証：償却資産の項目', () => {
  const ctx = { entityType: 'corporation', accounts: [] };
  const errs = (o) => validateAsset({ ...o }, ctx);
  assert.ok(errs({ ptKind: 7 }).ptKind);
  assert.ok(errs({ ptInclude: 'maybe' }).ptInclude);
  assert.ok(errs({ ptLife: 1 }).ptLife);
  assert.ok(errs({ ptLife: NaN }).ptLife);
  const ok = errs({ ptKind: 2, ptInclude: 'no', ptLife: 10 });
  assert.equal(ok.ptKind ?? ok.ptInclude ?? ok.ptLife, undefined);
});

test('サンプルデータで申告書とCSVが作れる', () => {
  for (const entity of ['individual', 'corporation']) {
    const d = buildSample(entity);
    const year = Number(d.periods[0].endDate.slice(0, 4)) + 1;
    const r = propertyTaxReturn({ assets: d.assets, year });
    assert.equal(r.kinds.reduce((s, k) => s + k.total, 0), r.total);
    const csv = propertyTaxCsv(r);
    assert.match(csv, /種類別明細書（全資産用）/);
  }
});

test('Repository：償却資産の項目を台帳に保存し、不正な値は保存しない', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { openDB, ValidationError } = await import('../js/db.js');
  const { createPeriod, createSettings, createAccount, createAsset } = await import('../js/models.js');
  const { templateAccounts } = await import('../js/accounts.js');
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('corporation').map((a) => createAccount(a));
  await repo.setup({ settings: createSettings({ businessName: 'テスト株式会社', entityType: 'corporation' }), period: createPeriod({ startDate: '2026-04-01', endDate: '2027-03-31' }), accounts });
  const acc = accounts.find((a) => a.code === '205');
  const base = createAsset({ name: 'パソコン', category: 'tools', accountId: acc.id, acquiredOn: '2026-05-01', startedOn: '2026-05-01', cost: 280000, method: 'sme', usefulLife: null });
  const saved = await repo.saveAsset({ ...base, ptLife: 4, ptKind: 6 });
  assert.equal(saved.ptLife, 4);
  await assert.rejects(repo.saveAsset({ ...saved, ptKind: 9 }), ValidationError);
});
