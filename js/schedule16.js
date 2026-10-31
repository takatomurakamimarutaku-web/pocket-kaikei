// 法人税の別表十六（減価償却資産の償却額の計算に関する明細書）：固定資産台帳から各欄を作る（純粋関数）
// 出典（2026-10-29 確認。令和6年4月1日以後終了事業年度分の様式）
// - 別表十六（一）旧定額法又は定額法 https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2024/pdf/16(1).pdf
//   記載要領 https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2026/pdf/16(01)-ki.pdf
// - 別表十六（二）旧定率法又は定率法 https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2024/pdf/16(2).pdf
// - 別表十六（七）少額減価償却資産の取得価額の損金算入の特例（租税特別措置法67条の5）
//   https://www.nta.go.jp/publication/pamph/hojin/aramashi2025/pdf/02-20.pdf
// - 別表十六（八）一括償却資産の損金算入（法人税法施行令133条の2）
//   https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2022/pdf/16(08).pdf
// このアプリは台帳の計算額（＝償却限度額）で減価償却の仕訳を作るので、当期償却額＝限度額として書く（償却不足額・超過額は 0）。
// 圧縮記帳は直接減額方式だけ（取得価額は圧縮後。積立金方式の欄は 0）。増加償却・償却超過額の繰越し・特別償却不足額の繰越しには対応していない（その欄は 0）
import { CATEGORY_BY_ID, usesLife, methodVariant, ratesFor, formatRate, assetRegister, depreciationSchedule, costAt, periodMonths, smeUsage, findDepreciationJournals } from './depreciation.js';
import { assetKind } from './life-table.js';
import { eraOf } from './property-tax.js';

/** 欄の定義（no：欄の番号、label：項目名、formula：様式の計算式、kind：yen（金額）・text・rate・years） */
const COMMON_HEAD = [
  { no: 1, label: '種類', kind: 'text' },
  { no: 2, label: '構造', kind: 'text' },
  { no: 3, label: '細目', kind: 'text' },
  { no: 4, label: '取得年月日', kind: 'text' },
  { no: 5, label: '事業の用に供した年月', kind: 'text' },
  { no: 6, label: '耐用年数', kind: 'years' },
  { no: 7, label: '取得価額又は製作価額', kind: 'yen' },
  { no: 8, label: '圧縮記帳による積立金計上額のうち取得価額に算入しない金額', kind: 'yen' },
  { no: 9, label: '差引取得価額', formula: '(7)−(8)', kind: 'yen' },
  { no: 10, label: '償却額計算の対象となる期末現在の帳簿記載金額', kind: 'yen' },
  { no: 11, label: '期末現在の積立金の額', kind: 'yen' },
  { no: 12, label: '積立金の期中取崩額', kind: 'yen' },
  { no: 13, label: '差引帳簿記載金額', formula: '(10)−(11)−(12)', kind: 'yen' },
  { no: 14, label: '損金に計上した当期償却額', kind: 'yen' },
  { no: 15, label: '前期から繰り越した償却超過額', kind: 'yen' },
  { no: 16, label: '合計', formula: '(13)+(14)+(15)', kind: 'yen' },
];

export const SCHEDULE16_LINES = {
  straight: [
    ...COMMON_HEAD,
    { no: 17, label: '残存価額', section: '平成19年3月31日以前取得分', kind: 'yen' },
    { no: 18, label: '差引取得価額×5%', formula: '(9)×5/100', kind: 'yen' },
    { no: 19, label: '旧定額法の償却額計算の基礎となる金額', formula: '(9)−(17)', kind: 'yen' },
    { no: 20, label: '旧定額法の償却率', kind: 'rate' },
    { no: 21, label: '算出償却額（(16)>(18)の場合）', formula: '(19)×(20)', kind: 'yen' },
    { no: 22, label: '増加償却額', formula: '(21)×割増率', kind: 'yen' },
    { no: 23, label: '計', formula: '((21)+(22))又は((16)−(18))', kind: 'yen' },
    { no: 24, label: '算出償却額（(16)≦(18)の場合）', formula: '((18)−1円)×当期月数/60', kind: 'yen' },
    { no: 25, label: '定額法の償却額計算の基礎となる金額', section: '平成19年4月1日以後取得分', formula: '(9)', kind: 'yen' },
    { no: 26, label: '定額法の償却率', kind: 'rate' },
    { no: 27, label: '算出償却額', formula: '(25)×(26)', kind: 'yen' },
    { no: 28, label: '増加償却額', formula: '(27)×割増率', kind: 'yen' },
    { no: 29, label: '計', formula: '(27)+(28)', kind: 'yen' },
    { no: 30, label: '当期分の普通償却限度額等', section: '当期分の償却限度額', formula: '(23)、(24)又は(29)', kind: 'yen' },
    { no: 31, label: '租税特別措置法適用条項', kind: 'text' },
    { no: 32, label: '特別償却限度額', kind: 'yen' },
    { no: 33, label: '前期から繰り越した特別償却不足額又は合併等特別償却不足額', kind: 'yen' },
    { no: 34, label: '合計', formula: '(30)+(32)+(33)', kind: 'yen' },
    { no: 35, label: '当期償却額', kind: 'yen' },
    { no: 36, label: '差引償却不足額', formula: '(34)−(35)', kind: 'yen' },
    { no: 37, label: '償却超過額', formula: '(35)−(34)', kind: 'yen' },
    { no: 38, label: '前期からの繰越額', section: '償却超過額', kind: 'yen' },
    { no: 39, label: '当期損金認容額（償却不足によるもの）', kind: 'yen' },
    { no: 40, label: '当期損金認容額（積立金取崩しによるもの）', kind: 'yen' },
    { no: 41, label: '差引合計翌期への繰越額', formula: '(37)+(38)−(39)−(40)', kind: 'yen' },
    { no: 42, label: '翌期に繰り越すべき特別償却不足額', section: '特別償却不足額', formula: '((36)−(39))と((32)+(33))のうち少ない金額', kind: 'yen' },
    { no: 43, label: '当期において切り捨てる特別償却不足額又は合併等特別償却不足額', kind: 'yen' },
    { no: 44, label: '差引翌期への繰越額', formula: '(42)−(43)', kind: 'yen' },
  ],
  declining: [
    ...COMMON_HEAD,
    { no: 17, label: '前期から繰り越した特別償却不足額又は合併等特別償却不足額', kind: 'yen' },
    { no: 18, label: '償却額計算の基礎となる金額', formula: '(16)−(17)', kind: 'yen' },
    { no: 19, label: '差引取得価額×5%', section: '平成19年3月31日以前取得分', formula: '(9)×5/100', kind: 'yen' },
    { no: 20, label: '旧定率法の償却率', kind: 'rate' },
    { no: 21, label: '算出償却額（(16)>(19)の場合）', formula: '(18)×(20)', kind: 'yen' },
    { no: 22, label: '増加償却額', formula: '(21)×割増率', kind: 'yen' },
    { no: 23, label: '計', formula: '((21)+(22))又は((18)−(19))', kind: 'yen' },
    { no: 24, label: '算出償却額（(16)≦(19)の場合）', formula: '((19)−1円)×当期月数/60', kind: 'yen' },
    { no: 25, label: '定率法の償却率', section: '平成19年4月1日以後取得分', kind: 'rate' },
    { no: 26, label: '調整前償却額', formula: '(18)×(25)', kind: 'yen' },
    { no: 27, label: '保証率', kind: 'guarantee' },
    { no: 28, label: '償却保証額', formula: '(9)×(27)', kind: 'yen' },
    { no: 29, label: '改定取得価額（(26)<(28)の場合）', kind: 'yen' },
    { no: 30, label: '改定償却率', kind: 'rate' },
    { no: 31, label: '改定償却額', formula: '(29)×(30)', kind: 'yen' },
    { no: 32, label: '増加償却額', formula: '((26)又は(31))×割増率', kind: 'yen' },
    { no: 33, label: '計', formula: '((26)又は(31))+(32)', kind: 'yen' },
    { no: 34, label: '当期分の普通償却限度額等', section: '当期分の償却限度額', formula: '(23)、(24)又は(33)', kind: 'yen' },
    { no: 35, label: '租税特別措置法適用条項', kind: 'text' },
    { no: 36, label: '特別償却限度額', kind: 'yen' },
    { no: 37, label: '前期から繰り越した特別償却不足額又は合併等特別償却不足額', kind: 'yen' },
    { no: 38, label: '合計', formula: '(34)+(36)+(37)', kind: 'yen' },
    { no: 39, label: '当期償却額', kind: 'yen' },
    { no: 40, label: '差引償却不足額', formula: '(38)−(39)', kind: 'yen' },
    { no: 41, label: '償却超過額', formula: '(39)−(38)', kind: 'yen' },
    { no: 42, label: '前期からの繰越額', section: '償却超過額', kind: 'yen' },
    { no: 43, label: '当期損金認容額（償却不足によるもの）', kind: 'yen' },
    { no: 44, label: '当期損金認容額（積立金取崩しによるもの）', kind: 'yen' },
    { no: 45, label: '差引合計翌期への繰越額', formula: '(41)+(42)−(43)−(44)', kind: 'yen' },
    { no: 46, label: '翌期に繰り越すべき特別償却不足額', section: '特別償却不足額', formula: '((40)−(43))と((36)+(37))のうち少ない金額', kind: 'yen' },
    { no: 47, label: '当期において切り捨てる特別償却不足額又は合併等特別償却不足額', kind: 'yen' },
    { no: 48, label: '差引翌期への繰越額', formula: '(46)−(47)', kind: 'yen' },
  ],
  small: [
    { no: 1, label: '種類', kind: 'text' },
    { no: 2, label: '構造', kind: 'text' },
    { no: 3, label: '細目', kind: 'text' },
    { no: 4, label: '事業の用に供した年月', kind: 'text' },
    { no: 5, label: '取得価額又は製作価額', kind: 'yen' },
    { no: 6, label: '法人税法上の圧縮記帳による積立金計上額', kind: 'yen' },
    { no: 7, label: '差引改定取得価額', formula: '(5)−(6)', kind: 'yen' },
  ],
  lump: [
    { no: 1, label: '事業の用に供した事業年度', kind: 'text' },
    { no: 2, label: '同上の事業年度において事業の用に供した一括償却資産の取得価額の合計額', kind: 'yen' },
    { no: 3, label: '当期の月数', kind: 'months' },
    { no: 4, label: '当期分の損金算入限度額', formula: '(2)×(3)/36', kind: 'yen' },
    { no: 5, label: '当期損金経理額', kind: 'yen' },
    { no: 6, label: '差引損金算入不足額', formula: '(4)−(5)', kind: 'yen' },
    { no: 7, label: '損金算入限度超過額', formula: '(5)−(4)', kind: 'yen' },
    { no: 8, label: '損金算入限度超過額の前期からの繰越額', kind: 'yen' },
    { no: 9, label: '同上のうち当期損金認容額', formula: '((6)と(8)のうち少ない金額)', kind: 'yen' },
    { no: 10, label: '翌期への繰越額', formula: '(7)+(8)−(9)', kind: 'yen' },
  ],
};

/** 和暦（令和・平成・昭和）の年月日。別表は和暦で書く */
export function warekiDate(date, { day = true } = {}) {
  if (!date) return '';
  const e = eraOf(date);
  return `${e.era}${e.year === 1 ? '元' : e.year}年${e.month}月${day ? `${Number(date.slice(8, 10))}日` : ''}`;
}

const yenFloor = (n) => Math.floor(n);
/** 期間の年額を月数で按分（減価償却の計算と同じく年額を先に切り捨てる） */
const prorate = (annual, months) => Math.floor((annual * months) / 12);

/** 定額法・定率法の資産1件分の欄（期間に償却がある資産だけ） */
function assetColumn({ asset, cost, row }, period) {
  const v = methodVariant(asset);
  const cat = CATEGORY_BY_ID[asset.category];
  const tangible = !cat?.intangible;
  const rates = ratesFor(asset) || { rate: 0, revised: 0, guarantee: 0 };
  const months = row.months;
  const notes = [];
  const L = {
    1: assetKind(asset),
    2: asset.structure || '',
    3: asset.detail || '',
    4: warekiDate(asset.acquiredOn),
    5: warekiDate(asset.startedOn, { day: false }),
    6: asset.usefulLife,
    7: cost,
    8: 0,
    9: cost,
    10: row.closing,
    11: 0,
    12: 0,
    13: row.closing,
    14: row.amount,
    15: 0,
    16: row.closing + row.amount,
  };
  if (asset.disposedOn && asset.disposedOn <= period.endDate) notes.push(`期中に${asset.disposalType === 'sell' ? '売却' : '除却'}（帳簿記載金額は${asset.disposalType === 'sell' ? '売却' : '除却'}の直前の額）`);
  if (months < periodMonths(period)) notes.push(`償却費は供用月数 ${months}か月で按分（×${months}/12）`);
  if (row.splits) notes.push('期首に一部を売却・除却（取得価額は残りの額）');
  if (asset.compressionAmount) notes.push(`圧縮記帳（直接減額）後の取得価額（圧縮額 ${asset.compressionAmount.toLocaleString('ja-JP')}円。別表十三（一））`);
  const straight = v === 'old_straight' || v === 'straight';
  const old = v === 'old_straight' || v === 'old_declining';
  const five = old && tangible ? yenFloor((cost * 5) / 100) : null;
  let normal; // 当期分の普通償却限度額等
  if (straight) {
    if (old) {
      const base = tangible ? Math.floor((cost * 9) / 10) : cost;
      L[17] = tangible ? cost - base : 0;
      L[18] = five;
      if (row.equal) {
        L[24] = row.ordinary;
        normal = 24;
      } else {
        L[19] = base;
        L[20] = formatRate(rates.rate);
        L[21] = prorate(tangible ? Math.floor((cost * 9 * rates.rate) / 10000) : Math.floor((cost * rates.rate) / 1000), months);
        L[22] = 0;
        L[23] = row.ordinary;
        normal = 23;
        if (row.ordinary < L[21]) notes.push('償却費の累計が取得価額の95%に達するため (16)−(18) を記載');
      }
    } else {
      L[25] = cost;
      L[26] = formatRate(rates.rate);
      L[27] = prorate(Math.floor((cost * rates.rate) / 1000), months);
      L[28] = 0;
      L[29] = L[27];
      normal = 29;
    }
    L[30] = row.ordinary;
    L[31] = row.special ? asset.specialName || '' : '';
    L[32] = row.special;
    L[33] = 0;
    L[34] = row.ordinary + row.special;
    L[35] = row.amount;
    L[36] = Math.max(0, L[34] - L[35]);
    L[37] = Math.max(0, L[35] - L[34]);
    L[38] = 0;
    L[39] = 0;
    L[40] = 0;
    L[41] = L[37];
    L[42] = Math.min(L[36], L[32] + L[33]);
    L[43] = 0;
    L[44] = L[42];
    if (normal && L[normal] > row.ordinary && normal !== 23) notes.push(tangible ? '帳簿価額1円（備忘価額）を残すため、(30)は (16)−1円 を限度にしています' : '(30)は期首の帳簿価額を限度にしています');
  } else {
    L[17] = 0;
    L[18] = L[16] - L[17];
    if (old) {
      L[19] = five;
      if (row.equal) {
        L[24] = row.ordinary;
      } else {
        L[20] = formatRate(rates.rate);
        L[21] = prorate(Math.floor((L[18] * rates.rate) / 1000), months);
        L[22] = 0;
        L[23] = row.ordinary;
        if (row.ordinary < L[21]) notes.push('償却費の累計が取得価額の95%に達するため (18)−(19) を記載');
      }
    } else {
      L[25] = formatRate(rates.rate);
      L[26] = prorate(Math.floor((L[18] * rates.rate) / 1000), months);
      L[27] = formatRate(rates.guarantee, 5);
      L[28] = Math.floor((cost * rates.guarantee) / 100000);
      if (row.switched) {
        L[29] = row.base;
        L[30] = formatRate(rates.revised);
        L[31] = prorate(Math.floor((row.base * rates.revised) / 1000), months);
      }
      L[32] = 0;
      L[33] = row.switched ? L[31] : L[26];
      if (L[33] > row.ordinary) notes.push('帳簿価額1円（備忘価額）を残すため、(34)は (18)−1円 を限度にしています');
    }
    L[34] = row.ordinary;
    L[35] = row.special ? asset.specialName || '' : '';
    L[36] = row.special;
    L[37] = 0;
    L[38] = row.ordinary + row.special;
    L[39] = row.amount;
    L[40] = Math.max(0, L[38] - L[39]);
    L[41] = Math.max(0, L[39] - L[38]);
    L[42] = 0;
    L[43] = 0;
    L[44] = 0;
    L[45] = L[41];
    L[46] = Math.min(L[40], L[36] + L[37]);
    L[47] = 0;
    L[48] = L[46];
  }
  return { asset, variant: v, lines: L, notes, amount: row.amount, ordinary: row.ordinary, special: row.special };
}

/** 一括償却資産：事業の用に供した事業年度ごとの列 */
function lumpColumns(assets, periods, period) {
  const groups = new Map();
  for (const asset of assets.filter((a) => a.method === 'lump3')) {
    const rows = depreciationSchedule(asset, periods);
    const row = rows.find((r) => r.startDate === period.startDate && r.endDate === period.endDate);
    if (!row || !rows.length) continue;
    const first = rows[0];
    const key = `${first.startDate}_${first.endDate}`;
    if (!groups.has(key)) groups.set(key, { startDate: first.startDate, endDate: first.endDate, assets: [], cost: 0, amount: 0, before: 0, usedMonths: 0 });
    const g = groups.get(key);
    g.assets.push(asset);
    g.cost += asset.cost;
    g.amount += row.amount;
    g.before += rows.filter((r) => r.endDate < period.startDate).reduce((s, r) => s + r.amount, 0);
    g.usedMonths = rows.filter((r) => r.endDate <= period.endDate).reduce((s, r) => s + periodMonths(r), 0);
  }
  const pm = periodMonths(period);
  return [...groups.values()]
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1))
    .map((g) => {
      // 36か月目を含む期間は、取得価額の合計から前期までの損金算入額を引いた残り（1円未満の端数の調整）を限度にする
      const limit = g.usedMonths >= 36 ? g.cost - g.before : Math.floor((g.cost * pm) / 36);
      const L = { 1: `${warekiDate(g.startDate)}〜${warekiDate(g.endDate)}`, 2: g.cost, 3: pm, 4: limit, 5: g.amount };
      L[6] = Math.max(0, L[4] - L[5]);
      L[7] = Math.max(0, L[5] - L[4]);
      L[8] = 0;
      L[9] = Math.min(L[6], L[8]);
      L[10] = L[7] + L[8] - L[9];
      return { startDate: g.startDate, endDate: g.endDate, assets: g.assets, lines: L, current: g.startDate === period.startDate, last: g.usedMonths >= 36 };
    });
}

/**
 * 別表十六（一）（二）（七）（八）
 * @param {{ assets: Array, periods: Array, period: object, journals?: Array }} p journals：その期間の仕訳（減価償却の仕訳と台帳の差を確かめる）
 * @returns {{ straight: Array, declining: Array, small: { items: Array, total: number, limit: number, over: boolean }, lump: Array,
 *   totals: { amount: number, ordinary: number, special: number, excess: number, lump: number, small: number }, posted: number|null, expected: number }}
 */
export function schedule16({ assets, periods, period, journals = null }) {
  const register = assetRegister(assets, periods, period);
  const columns = register.filter((x) => x.row && usesLife(x.asset.method)).map((x) => assetColumn(x, period));
  const straight = columns.filter((c) => c.variant === 'old_straight' || c.variant === 'straight');
  const declining = columns.filter((c) => !straight.includes(c));
  const smallAssets = assets.filter((a) => a.method === 'sme' && a.startedOn >= period.startDate && a.startedOn <= period.endDate).sort((a, b) => (a.startedOn < b.startedOn ? -1 : a.startedOn > b.startedOn ? 1 : 0));
  const usage = smeUsage(assets, period);
  const small = {
    items: smallAssets.map((asset) => ({ asset, lines: { 1: assetKind(asset), 2: asset.structure || '', 3: asset.detail || '', 4: warekiDate(asset.startedOn, { day: false }), 5: costAt(asset, period), 6: 0, 7: costAt(asset, period) } })),
    total: usage.total,
    limit: usage.limit,
    over: usage.over,
  };
  const lump = lumpColumns(assets, periods, period);
  const sum = (list, key) => list.reduce((s, c) => s + c[key], 0);
  const expected = register.reduce((s, x) => s + (x.row?.amount ?? 0), 0);
  const posted = journals ? findDepreciationJournals(journals).flatMap((j) => j.lines).filter((l) => l.side === 'credit').reduce((s, l) => s + l.amount, 0) : null;
  return {
    straight,
    declining,
    small,
    lump,
    totals: {
      amount: sum(columns, 'amount'),
      ordinary: sum(columns, 'ordinary'),
      special: sum(columns, 'special'),
      excess: straight.reduce((s, c) => s + c.lines[37], 0) + declining.reduce((s, c) => s + c.lines[41], 0),
      lump: lump.reduce((s, c) => s + c.lines[5], 0),
      small: small.total,
    },
    posted,
    expected,
  };
}
