// 償却資産申告書（固定資産税）：種類別明細書・申告書の集計と評価額の計算（純粋関数）
//
// 出典（2026-10-29 確認）
// - 評価額の計算：前年中に取得した資産は 取得価額 ×（1 − 減価率 / 2）、前年前に取得した資産は 前年度の評価額 ×（1 − 減価率）。
//   評価額が取得価額の5%を下回るときは5%の額（固定資産評価基準 第3章、減価率は同 別表第15「耐用年数に応ずる減価率表」）
//   神戸市「償却資産の評価額の計算方法」・甲府市「償却資産の評価額と税額の計算」・大分市「減価率表」で照合
// - 課税標準額は1,000円未満切捨て、税額＝課税標準額×1.4%（標準税率）で100円未満切捨て、
//   課税標準額の合計が150万円未満は課税されない（免税点）（地方税法 第350条・第351条、甲府市・freee ヘルプの説明で確認）
// - 申告の対象外：土地・家屋（建物）、無形固定資産、自動車税・軽自動車税の対象の車両、
//   一括償却資産（3年均等償却）と取得価額10万円未満で全額を経費にした資産（地方税法 第341条第4号）。
//   中小企業者等の少額減価償却資産の特例（30万円・40万円未満）で全額を経費にした資産は申告の対象
// - 賦課期日は1月1日、申告期限は1月31日（地方税法 第359条・第383条）
// 1円未満は切り捨てる（甲府市の計算例：1,171,200 × 0.464 = 543,436.8 → 543,436円）
import { isYen } from './money.js';
import { usesLife, costBeforeCompression } from './depreciation.js';

/** 耐用年数ごとの減価率（1/1000）。固定資産評価基準 別表第15 */
export const DEPRECIATION_RATES = {
  2: 684, 3: 536, 4: 438, 5: 369, 6: 319, 7: 280, 8: 250, 9: 226, 10: 206,
  11: 189, 12: 175, 13: 162, 14: 152, 15: 142, 16: 134, 17: 127, 18: 120, 19: 114, 20: 109,
  21: 104, 22: 99, 23: 95, 24: 92, 25: 88, 26: 85, 27: 82, 28: 79, 29: 76, 30: 74,
  31: 72, 32: 69, 33: 67, 34: 66, 35: 64, 36: 62, 37: 60, 38: 59, 39: 57, 40: 56,
  41: 55, 42: 53, 43: 52, 44: 51, 45: 50, 46: 49, 47: 48, 48: 47, 49: 46, 50: 45,
};

/**
 * 減価残存率（1/1000）。[前年中取得, 前年前取得]
 * 前年中取得は自治体の減価残存率表の値（1 − r/2 の小数第4位を切り捨て。例：耐用年数5年 1 − 0.1845 = 0.8155 → 0.815）
 */
export function residualRates(life) {
  const r = DEPRECIATION_RATES[life];
  if (!r) return null;
  return [1000 - Math.ceil(r / 2), 1000 - r];
}

/** 申告書の資産の種類（1〜6） */
export const PT_KINDS = [
  { id: 1, label: '構築物' },
  { id: 2, label: '機械及び装置' },
  { id: 3, label: '船舶' },
  { id: 4, label: '航空機' },
  { id: 5, label: '車両及び運搬具' },
  { id: 6, label: '工具、器具及び備品' },
];
export const PT_KIND_BY_ID = Object.fromEntries(PT_KINDS.map((k) => [k.id, k]));

/** 固定資産台帳の種類 → 申告書の種類 */
const KIND_OF_CATEGORY = { building_equipment: 1, structure: 1, machinery: 2, vehicle: 5, tools: 6 };

/** 標準税率（1/1000 %）と免税点 */
export const PT_RATE = 1400; // 1.4%
export const PT_EXEMPTION = 1500000;

/**
 * 申告の対象かどうかの判定
 * - 'no'：対象外（理由つき。建物・無形・一括償却・10万円未満は変えられない）
 * - 'auto'：初期値。構築物・機械装置・工具器具備品と少額特例は対象。建物附属設備（家屋と一体なら家屋として課税）と
 *   車両（自動車税の対象なら対象外）は「確認が必要」として対象外にしておき、利用者が対象にできる
 * @returns {{ include: boolean, fixed: boolean, reason: string, review: boolean }}
 */
export function ptEligibility(asset) {
  if (asset.method === 'none') return { include: false, fixed: true, reason: asset.category === 'land' ? '土地は償却資産ではなく土地として課税されます' : '減価償却をしない資産（建設仮勘定・美術品など）は対象外です', review: false };
  if (asset.category === 'building') return { include: false, fixed: true, reason: '家屋（建物）は償却資産ではなく家屋として課税されます', review: false };
  if (asset.category === 'intangible') return { include: false, fixed: true, reason: '無形固定資産は対象外です', review: false };
  if (asset.method === 'lump3') return { include: false, fixed: true, reason: '一括償却資産（3年均等償却）は対象外です', review: false };
  if (asset.method === 'small') return { include: false, fixed: true, reason: '取得価額10万円未満で全額を経費にした資産は対象外です', review: false };
  const review = asset.category === 'building_equipment' || asset.category === 'vehicle';
  const auto = !review;
  const include = asset.ptInclude === 'yes' ? true : asset.ptInclude === 'no' ? false : auto;
  const reason =
    asset.category === 'building_equipment'
      ? '建物附属設備は、家屋と一体のもの（自己所有の建物の電気・給排水設備など）は家屋として課税され、賃借した建物の内装・設備などは償却資産として申告します'
      : asset.category === 'vehicle'
        ? '自動車税・軽自動車税の対象の車両は対象外です。フォークリフトなどの大型特殊自動車（ナンバーが緑・白で「9」「0」から始まるもの）や構内専用車は対象です'
        : '';
  return { include, fixed: false, reason, review };
}

/** 申告書の種類（利用者が変えたものを優先） */
export function ptKindOf(asset) {
  return PT_KIND_BY_ID[asset.ptKind] ? asset.ptKind : KIND_OF_CATEGORY[asset.category] || 6;
}

/** 評価に使う耐用年数（定額法・定率法は台帳の耐用年数、少額特例などは ptLife） */
export function ptLifeOf(asset) {
  if (Number.isInteger(asset.ptLife)) return asset.ptLife;
  return usesLife(asset.method) ? asset.usefulLife : null;
}

/** 取得日が属する「年」（賦課期日1月1日を区切りにする：1月1日の取得は前の年の取得として扱う） */
export function acquisitionYear(date) {
  const y = Number(date.slice(0, 4));
  return date.slice(5) === '01-01' ? y - 1 : y;
}

/** 賦課期日（その年度の1月1日）に持っている資産か */
export function heldOn(asset, year) {
  const day = `${year}-01-01`;
  return asset.acquiredOn <= day && !(asset.disposedOn && asset.disposedOn <= day);
}

/**
 * その年度（year 年1月1日が賦課期日）の評価額
 * 取得の翌年度は 取得価額×前年中取得の残存率、以後は前年度の評価額×前年前取得の残存率。取得価額の5%が下限
 * @returns {{ value: number, residual: number|null, years: number }} residual はその年度に掛けた残存率（1/1000）
 */
export function assessedValue({ cost, acquiredOn, life }, year) {
  const rates = residualRates(life);
  const first = acquisitionYear(acquiredOn) + 1;
  if (!rates || year < first) return { value: 0, residual: null, years: 0 };
  const floor = Math.floor((cost * 5) / 100);
  let value = Math.floor((cost * rates[0]) / 1000);
  let residual = rates[0];
  for (let y = first + 1; y <= year; y += 1) {
    value = Math.floor((value * rates[1]) / 1000);
    residual = rates[1];
    if (value <= floor) break;
  }
  return { value: Math.max(value, floor), residual, years: year - first + 1 };
}

/** 和暦（取得年月の欄）。令和元年は「令和1」と書く */
export function eraOf(date) {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = date.slice(0, 10);
  if (d >= '2019-05-01') return { era: '令和', year: y - 2018, month: m };
  if (d >= '1989-01-08') return { era: '平成', year: y - 1988, month: m };
  return { era: '昭和', year: y - 1925, month: m };
}

/** 年度の表示（例：2027 → 令和9年度） */
export function fiscalYearLabel(year) {
  return year >= 2020 ? `令和${year - 2018}年度` : `平成${year - 1988}年度`;
}

/** 今日から、次に申告する年度（1月31日までは今年の年度、2月以後は翌年の年度） */
export function defaultPtYear(today) {
  const y = Number(today.slice(0, 4));
  return today.slice(5) <= '01-31' ? y : y + 1;
}

/**
 * 償却資産申告書（year 年度：year 年1月1日現在）
 * @param {{ assets: Array, year: number }}
 * @returns {{
 *   year, label, items: Array<{ asset, kind, life, residual, value, increase: boolean }>,
 *   decreases: Array<{ asset, kind, life, reason }>, excluded: Array<{ asset, reason }>, review: Array<{ asset, reason, include }>,
 *   missingLife: Array, kinds: Array<{ id, label, before, decrease, increase, total, value }>,
 *   total, valueTotal, taxBase, exempt: boolean, tax
 * }}
 */
export function propertyTaxReturn({ assets, year }) {
  const prev = `${year - 1}-01-01`;
  const items = [];
  const decreases = [];
  const excluded = [];
  const review = [];
  const missingLife = [];
  const kinds = PT_KINDS.map((k) => ({ ...k, before: 0, decrease: 0, increase: 0, total: 0, value: 0 }));
  for (const asset of assets) {
    if (!isYen(asset.cost) || asset.acquiredOn > `${year}-01-01`) continue;
    // 前年中（前年1月2日〜今年1月1日）に取得した資産か・前年1月1日に持っていた資産か
    const increase = asset.acquiredOn > prev;
    const heldBefore = heldOn(asset, year - 1);
    const heldNow = heldOn(asset, year);
    if (!heldBefore && !heldNow) continue;
    const el = ptEligibility(asset);
    if (el.review) review.push({ asset, reason: el.reason, include: el.include });
    if (!el.include) {
      if (heldNow) excluded.push({ asset, reason: el.reason || '申告の対象外にしています' });
      continue;
    }
    const kind = kinds[ptKindOf(asset) - 1];
    const life = ptLifeOf(asset);
    // 固定資産税には圧縮記帳の制度が無いので、圧縮前の取得価額で申告する
    const cost = costBeforeCompression(asset);
    if (heldBefore) kind.before += cost;
    if (heldBefore && !heldNow) {
      kind.decrease += cost;
      decreases.push({ asset, cost, kind: kind.id, life, reason: asset.disposalType === 'sell' ? '売却' : '滅失' });
      continue;
    }
    if (increase) kind.increase += cost;
    if (!residualRates(life)) {
      missingLife.push(asset);
      items.push({ asset, cost, kind: kind.id, life: null, residual: null, value: 0, increase });
      continue;
    }
    const { value, residual } = assessedValue({ cost, acquiredOn: asset.acquiredOn, life }, year);
    kind.value += value;
    items.push({ asset, cost, kind: kind.id, life, residual, value, increase });
  }
  for (const k of kinds) k.total = k.before - k.decrease + k.increase;
  const byKind = (a, b) => a.kind - b.kind || a.asset.acquiredOn.localeCompare(b.asset.acquiredOn) || String(a.asset.name).localeCompare(String(b.asset.name), 'ja');
  items.sort(byKind);
  decreases.sort(byKind);
  const total = kinds.reduce((s, k) => s + k.total, 0);
  const valueTotal = kinds.reduce((s, k) => s + k.value, 0);
  const taxBase = Math.floor(valueTotal / 1000) * 1000;
  const exempt = taxBase < PT_EXEMPTION;
  const tax = exempt ? 0 : Math.floor((taxBase * PT_RATE) / 100000 / 100) * 100;
  return { year, label: fiscalYearLabel(year), items, decreases, excluded, review, missingLife, kinds, total, valueTotal, taxBase, exempt, tax };
}
