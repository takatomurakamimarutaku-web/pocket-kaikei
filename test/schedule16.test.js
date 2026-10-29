import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule16, SCHEDULE16_LINES, warekiDate } from '../js/schedule16.js';
import { LIFE_TABLE, searchLifeTable, assetKind, lifeEntryName, lifeEntryLabel, normalizeForSearch } from '../js/life-table.js';
import { CATEGORY_BY_ID, validateAsset, MIN_LIFE, MAX_LIFE } from '../js/depreciation.js';
import { capexDefaults } from '../js/asset-tools.js';
import { schedule16Csv } from '../js/csv.js';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from '../js/db.js';
import { templateAccounts } from '../js/accounts.js';
import { createAccount, createPeriod, createSettings, createAsset } from '../js/models.js';

// 法人の事業年度（4月〜3月）
const FY = (y) => ({ id: `p${y}`, startDate: `${y}-04-01`, endDate: `${y + 1}-03-31` });
const periods = [FY(2026)];
const asset = (fields) => ({ id: fields.id || 'a1', name: '資産', category: 'tools', accountId: 'acc', acquiredOn: '2026-04-01', startedOn: '2026-04-01', cost: 1000000, method: 'straight', usefulLife: 8, businessRatio: 100, quantity: 1, disposedOn: null, structure: '', detail: '', ...fields });

test('耐用年数表：種類・年数・文字数が正しく、国税庁の表の値と合う', () => {
  assert.ok(LIFE_TABLE.length >= 150);
  for (const e of LIFE_TABLE) {
    const label = lifeEntryLabel(e);
    assert.ok(CATEGORY_BY_ID[e.category], label);
    assert.ok(e.life >= MIN_LIFE && e.life <= MAX_LIFE, label);
    assert.ok(e.kind, label);
    assert.ok(e.structure.length <= 60 && e.detail.length <= 60, label);
    assert.ok(lifeEntryName(e).length >= 1 && lifeEntryName(e).length <= 40, label);
  }
  const life = (q) => searchLifeTable(q).map((e) => e.life);
  assert.deepEqual(life('パソコン'), [4]);
  assert.deepEqual(life('軽自動車'), [4]);
  assert.deepEqual(life('ﾊﾟｿｺﾝ'), [4]); // 半角カナでも探せる
  assert.deepEqual(life('木造 店舗'), [22]);
  assert.deepEqual(life('鉄筋コンクリート 事務所'), [50]);
  assert.deepEqual(life('3mm以下 事務所'), [22]);
  assert.deepEqual(life('エアコン'), [6]);
  assert.equal(life('時計')[0], 10);
  assert.deepEqual(life('金庫').slice(0, 2), [5, 20]); // 細目に当たったものが先
  assert.deepEqual(life('飲食店業用設備'), [8]);
  assert.deepEqual(life('給排水'), [15]);
  assert.deepEqual(life('バス'), [5]);
  assert.deepEqual(life('ソフトウエア'), [3, 5]);
  assert.deepEqual(searchLifeTable(''), []);
  assert.equal(searchLifeTable('', { category: 'intangible' }).length, 2);
  assert.deepEqual(searchLifeTable('存在しない資産'), []);
  assert.equal(normalizeForSearch('ノートＰＣ　（金属製）'), 'のーとpc金属製');
});

test('耐用年数表：種類（別表の「種類」）と名前の初期値', () => {
  const pc = searchLifeTable('パソコン')[0];
  assert.equal(pc.kind, '器具及び備品');
  assert.equal(lifeEntryName(pc), 'パソコン');
  const tool = searchLifeTable('切削工具')[0];
  assert.equal(tool.kind, '工具');
  assert.equal(assetKind({ category: 'tools', structure: tool.structure, detail: tool.detail }), '工具');
  assert.equal(assetKind({ category: 'tools', structure: '', detail: '' }), '器具及び備品');
  assert.equal(assetKind({ category: 'vehicle' }), '車両及び運搬具');
  assert.equal(lifeEntryName(searchLifeTable('木造 事務所')[0]), '木造の建物');
  assert.equal(lifeEntryName(searchLifeTable('冷房')[0]), '冷房用・暖房用機器');
});

test('構造又は用途・細目：60文字まで。資本的支出は元の資産から引き継ぐ', () => {
  const accounts = [{ id: 'acc', group: 'tangible_fixed_assets', normalSide: 'debit' }];
  const base = asset({ name: '机', structure: '家具、電気機器、ガス機器、家庭用品', detail: '事務机' });
  assert.deepEqual(validateAsset(base, { entityType: 'corporation', accounts }), {});
  const long = validateAsset({ ...base, structure: 'あ'.repeat(61), detail: 'い'.repeat(61) }, { entityType: 'corporation', accounts });
  assert.ok(long.structure && long.detail);
  const c = capexDefaults(base, '2027-01-10');
  assert.deepEqual([c.structure, c.detail], ['家具、電気機器、ガス機器、家庭用品', '事務机']);
});

test('別表十六の欄：（一）は1〜44、（二）は1〜48、（七）は1〜7、（八）は1〜10の番号が順に並ぶ', () => {
  const nos = (list) => list.map((l) => l.no);
  const seq = (n) => Array.from({ length: n }, (_, i) => i + 1);
  assert.deepEqual(nos(SCHEDULE16_LINES.straight), seq(44));
  assert.deepEqual(nos(SCHEDULE16_LINES.declining), seq(48));
  assert.deepEqual(nos(SCHEDULE16_LINES.small), seq(7));
  assert.deepEqual(nos(SCHEDULE16_LINES.lump), seq(10));
  assert.equal(SCHEDULE16_LINES.straight.find((l) => l.no === 36).label, '差引償却不足額');
  assert.equal(SCHEDULE16_LINES.straight.find((l) => l.no === 37).label, '償却超過額');
  assert.equal(SCHEDULE16_LINES.declining.find((l) => l.no === 40).label, '差引償却不足額');
  assert.equal(SCHEDULE16_LINES.declining.find((l) => l.no === 41).label, '償却超過額');
});

test('和暦の表示', () => {
  assert.equal(warekiDate('2019-05-01'), '令和元年5月1日');
  assert.equal(warekiDate('2026-04-10'), '令和8年4月10日');
  assert.equal(warekiDate('2005-03-01', { day: false }), '平成17年3月');
});

test('別表十六（一）定額法：(25)取得価額×(26)償却率＝(27)、当期償却額＝限度額で不足・超過は0', () => {
  const pc = searchLifeTable('事務机 金属製')[0];
  const a = asset({ name: '机', structure: pc.structure, detail: pc.detail, acquiredOn: '2026-04-10', startedOn: '2026-04-10' });
  const r = schedule16({ assets: [a], periods, period: FY(2026) });
  assert.equal(r.straight.length, 1);
  assert.equal(r.declining.length, 0);
  const L = r.straight[0].lines;
  assert.deepEqual([L[1], L[2], L[3], L[4], L[5], L[6]], ['器具及び備品', '家具、電気機器、ガス機器、家庭用品', '事務机・事務いす・キャビネット（主として金属製のもの）', '令和8年4月10日', '令和8年4月', 8]);
  assert.deepEqual([L[7], L[9], L[10], L[13], L[14], L[16]], [1000000, 1000000, 875000, 875000, 125000, 1000000]);
  assert.deepEqual([L[25], L[26], L[27], L[29], L[30]], [1000000, '0.125', 125000, 125000, 125000]);
  assert.equal(L[17], undefined); // 平成19年3月31日以前取得分の欄は空欄
  assert.deepEqual([L[31], L[32], L[34], L[35], L[36], L[37], L[41], L[42]], ['', 0, 125000, 125000, 0, 0, 0, 0]);
  assert.deepEqual(r.totals, { amount: 125000, ordinary: 125000, special: 0, excess: 0, lump: 0, small: 0 });
});

test('別表十六（一）期中に使い始めた資産：供用月数で按分し、注記を付ける', () => {
  const a = asset({ cost: 600000, usefulLife: 5, acquiredOn: '2026-10-15', startedOn: '2026-10-15' });
  const col = schedule16({ assets: [a], periods, period: FY(2026) }).straight[0];
  assert.deepEqual([col.lines[26], col.lines[27], col.lines[30], col.lines[14]], ['0.200', 60000, 60000, 60000]);
  assert.ok(col.notes.some((n) => n.includes('6か月')));
});

test('別表十六（一）旧定額法：95%に達する年は (16)−(18)、その後は5年間の均等償却を(24)に書く', () => {
  const a = asset({ cost: 1000000, usefulLife: 10, acquiredOn: '2000-04-01', startedOn: '2000-04-01' });
  // 年90,000円（(1,000,000−100,000)×0.100）。10年で900,000円、11年目（2010年度）は 50,000円で95%に達する
  const y11 = schedule16({ assets: [a], periods, period: FY(2010) }).straight[0];
  assert.equal(y11.variant, 'old_straight');
  const L = y11.lines;
  assert.deepEqual([L[16], L[17], L[18], L[19], L[20], L[21], L[23], L[30], L[14]], [100000, 100000, 50000, 900000, '0.100', 90000, 50000, 50000, 50000]);
  assert.equal(L[25], undefined);
  assert.ok(y11.notes.some((n) => n.includes('95%')));
  // 12年目：((18)−1円)×12/60＝9,999.8 → 10,000円（5年で1円にするため切り上げ）
  const y12 = schedule16({ assets: [a], periods, period: FY(2011) }).straight[0];
  assert.deepEqual([y12.lines[16], y12.lines[18], y12.lines[21], y12.lines[23], y12.lines[24], y12.lines[30]], [50000, 50000, undefined, undefined, 10000, 10000]);
});

test('別表十六（二）定率法：償却保証額を下回った年は改定取得価額×改定償却率、1円を残す', () => {
  const a = asset({ cost: 400000, method: 'declining', usefulLife: 4 });
  // 200,000 → 100,000 → 50,000（調整前 50,000 ≧ 保証額 49,996）→ 4年目は 25,000 < 49,996 で改定償却
  const y3 = schedule16({ assets: [a], periods, period: FY(2028) }).declining[0].lines;
  assert.deepEqual([y3[18], y3[25], y3[26], y3[27], y3[28], y3[29], y3[33], y3[34]], [100000, '0.500', 50000, '0.12499', 49996, undefined, 50000, 50000]);
  const y4 = schedule16({ assets: [a], periods, period: FY(2029) }).declining[0];
  const L = y4.lines;
  assert.deepEqual([L[16], L[17], L[18], L[26], L[28], L[29], L[30], L[31], L[33], L[34], L[39], L[40], L[41], L[10]], [50000, 0, 50000, 25000, 49996, 50000, '1.000', 50000, 50000, 49999, 49999, 0, 0, 1]);
  assert.ok(y4.notes.some((n) => n.includes('1円')));
});

test('別表十六（二）特別償却：(35)条項・(36)特別償却限度額・(38)合計・(39)当期償却額', () => {
  const a = asset({ category: 'machinery', cost: 1000000, method: 'declining', usefulLife: 10, specialRate: 30, specialName: '中小企業投資促進税制' });
  const r = schedule16({ assets: [a], periods, period: FY(2026) });
  const L = r.declining[0].lines;
  assert.deepEqual([L[1], L[16], L[18], L[26], L[34], L[35], L[36], L[38], L[39], L[40], L[41], L[46], L[10]], ['機械及び装置', 1000000, 1000000, 200000, 200000, '中小企業投資促進税制', 300000, 500000, 500000, 0, 0, 0, 500000]);
  assert.deepEqual([r.totals.ordinary, r.totals.special, r.totals.amount], [200000, 300000, 500000]);
});

test('別表十六（二）旧定率法は（二）、旧定額法は（一）に分ける', () => {
  const oldDeclining = asset({ id: 'd', method: 'declining', usefulLife: 10, acquiredOn: '2005-04-01', startedOn: '2005-04-01' });
  const oldStraight = asset({ id: 's', method: 'straight', usefulLife: 10, acquiredOn: '2005-04-01', startedOn: '2005-04-01' });
  const r = schedule16({ assets: [oldDeclining, oldStraight], periods, period: FY(2006) });
  assert.deepEqual(r.declining.map((c) => [c.asset.id, c.variant]), [['d', 'old_declining']]);
  assert.deepEqual(r.straight.map((c) => [c.asset.id, c.variant]), [['s', 'old_straight']]);
  const L = r.declining[0].lines;
  // 2年目：期首 794,000 × 0.206 = 163,564
  assert.deepEqual([L[18], L[19], L[20], L[21], L[23], L[25]], [794000, 50000, '0.206', 163564, 163564, undefined]);
});

test('別表十六（七）少額減価償却資産：当期に使い始めた資産と合計・限度額', () => {
  const s1 = asset({ id: 's1', method: 'sme', usefulLife: null, cost: 250000, startedOn: '2026-05-01', acquiredOn: '2026-05-01', structure: '事務機器、通信機器', detail: '電子計算機' });
  const s2 = asset({ id: 's2', method: 'sme', usefulLife: null, cost: 280000, startedOn: '2027-02-01', acquiredOn: '2027-02-01' });
  const old = asset({ id: 's0', method: 'sme', usefulLife: null, cost: 200000, startedOn: '2026-03-01', acquiredOn: '2026-03-01' });
  const r = schedule16({ assets: [s2, s1, old], periods, period: FY(2026) });
  assert.deepEqual(r.small.items.map((x) => x.asset.id), ['s1', 's2']);
  assert.deepEqual(r.small.items[0].lines, { 1: '器具及び備品', 2: '事務機器、通信機器', 3: '電子計算機', 4: '令和8年5月', 5: 250000, 6: 0, 7: 250000 });
  assert.deepEqual([r.small.total, r.small.limit, r.small.over], [530000, 3000000, false]);
  assert.equal(r.totals.small, 530000);
});

test('別表十六（八）一括償却資産：事業年度ごとに (2)×(3)/36、36か月目の期は端数を調整', () => {
  const l1 = asset({ id: 'l1', method: 'lump3', usefulLife: null, cost: 150000, startedOn: '2026-05-01', acquiredOn: '2026-05-01' });
  const l2 = asset({ id: 'l2', method: 'lump3', usefulLife: null, cost: 100000, startedOn: '2026-06-01', acquiredOn: '2026-06-01' });
  const l0 = asset({ id: 'l0', method: 'lump3', usefulLife: null, cost: 120000, startedOn: '2025-07-01', acquiredOn: '2025-07-01' });
  const r = schedule16({ assets: [l1, l2, l0], periods, period: FY(2026) });
  assert.equal(r.lump.length, 2);
  const [cur, prev] = r.lump;
  // 当期分：250,000×12/36＝83,333、損金経理額は資産ごとに 50,000＋33,333＝83,333
  assert.deepEqual([cur.current, cur.lines[1], cur.lines[2], cur.lines[3], cur.lines[4], cur.lines[5], cur.lines[6], cur.lines[7], cur.lines[10]], [true, '令和8年4月1日〜令和9年3月31日', 250000, 12, 83333, 83333, 0, 0, 0]);
  assert.deepEqual([prev.current, prev.lines[2], prev.lines[4], prev.lines[5]], [false, 120000, 40000, 40000]);
  assert.equal(r.totals.lump, 123333);
  // 3年目（2028年度）：残り 250,000−166,666＝83,334 を限度に（(2)×(3)/36 の端数の調整）
  const y3 = schedule16({ assets: [l1, l2], periods, period: FY(2028) }).lump[0];
  assert.deepEqual([y3.last, y3.lines[4], y3.lines[5], y3.lines[7]], [true, 83334, 83334, 0]);
  assert.deepEqual(schedule16({ assets: [l1, l2], periods, period: FY(2029) }).lump, []);
});

test('別表十六：減価償却の仕訳の合計と台帳の計算を比べる', () => {
  const a = asset({});
  const j = (amount) => ({ id: 'j', source: 'depreciation', lines: [{ side: 'debit', accountId: 'exp', amount }, { side: 'credit', accountId: 'acc', amount }] });
  assert.deepEqual(['posted', 'expected'].map((k) => schedule16({ assets: [a], periods, period: FY(2026), journals: [j(125000)] })[k]), [125000, 125000]);
  assert.equal(schedule16({ assets: [a], periods, period: FY(2026), journals: [] }).posted, 0);
  assert.equal(schedule16({ assets: [a], periods, period: FY(2026) }).posted, null);
});

test('別表十六：期中に除却した資産は除却の直前の帳簿価額で書き、注記を付ける', () => {
  const a = asset({ disposedOn: '2026-09-30', disposalType: 'retire' });
  const col = schedule16({ assets: [a], periods, period: FY(2026) }).straight[0];
  // 6か月分 62,500
  assert.deepEqual([col.lines[14], col.lines[10], col.lines[16]], [62500, 937500, 1000000]);
  assert.ok(col.notes.some((n) => n.includes('除却')));
});

test('別表十六のCSV：欄を行・資産を列にし、（七）の「8」に合計を入れる', () => {
  const a = asset({ name: '机' });
  const s = asset({ id: 's', name: 'PC', method: 'sme', usefulLife: null, cost: 250000 });
  const l = asset({ id: 'l', name: '棚', method: 'lump3', usefulLife: null, cost: 150000 });
  const csv = schedule16Csv(schedule16({ assets: [a, s, l], periods, period: FY(2026) }));
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(lines[0], '別表十六（一）旧定額法又は定額法による減価償却資産の償却額の計算に関する明細書');
  assert.equal(lines[1], '欄,項目,机');
  assert.ok(lines.includes('27,算出償却額 (25)×(26),125000'));
  assert.ok(lines.includes('26,定額法の償却率,0.125'));
  assert.ok(lines.includes('8,当期の少額減価償却資産の取得価額の合計額 (7)の計,250000'));
  assert.ok(lines.includes('欄,項目,当期分'));
  assert.ok(lines.includes('4,当期分の損金算入限度額 (2)×(3)/36,50000'));
});

test('固定資産の保存：構造又は用途・細目を前後の空白を除いて保存する', async () => {
  const repo = await openDB({ indexedDB: new IDBFactory() });
  const accounts = templateAccounts('corporation').map((x) => createAccount(x));
  await repo.setup({ settings: createSettings({ businessName: 'テスト株式会社', entityType: 'corporation' }), period: createPeriod({ startDate: '2026-04-01', endDate: '2027-03-31' }), accounts });
  const acc = accounts.find((x) => x.name === '工具器具備品');
  const saved = await repo.saveAsset(createAsset({ name: 'PC', category: 'tools', accountId: acc.id, acquiredOn: '2026-04-01', startedOn: '2026-04-01', cost: 300000, method: 'declining', usefulLife: 4, structure: ' 事務機器、通信機器 ', detail: '電子計算機' }));
  assert.deepEqual([saved.structure, saved.detail], ['事務機器、通信機器', '電子計算機']);
  // 古いデータ（項目が無い）も保存できる
  const { structure, detail, ...old } = saved;
  const again = await repo.saveAsset(old);
  assert.deepEqual([again.structure, again.detail], ['', '']);
});
