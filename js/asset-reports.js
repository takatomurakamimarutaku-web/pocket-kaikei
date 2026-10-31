// 固定資産台帳の帳票（純粋関数）：増減の明細・減価償却累計額・状態の絞り込み・集計・償却予定表・月次償却額・取得と除売却の一覧
// 弥生会計（固定資産台帳 兼 減価償却計算表・償却額推移表）、勘定奉行クラウド（取得資産台帳・除却資産台帳・償却済資産台帳・
// 償却予定表・月次償却額一覧表）の帳票の種類に合わせた。償却費の計算そのものは js/depreciation.js
import { depreciationSchedule, openingBook, hasCarryOver, usesLife, depreciationLines, findDepreciationJournals, CATEGORY_BY_ID } from './depreciation.js';
import { monthsInPeriod, addDays, addMonths } from './period.js';

/** 状態（画面の絞り込み・帳票の区分） */
export const ASSET_STATUSES = [
  { id: 'active', label: '償却中' },
  { id: 'new', label: '当期取得' },
  { id: 'disposed', label: '当期に売却・除却' },
  { id: 'done', label: '償却済み' },
  { id: 'future', label: 'これから使う' },
  { id: 'gone', label: '前期までに売却・除却' },
];
export const STATUS_BY_ID = Object.fromEntries(ASSET_STATUSES.map((s) => [s.id, s]));

/** 集計の単位 */
export const GROUP_KEYS = [
  { id: 'account', label: '勘定科目' },
  { id: 'category', label: '種類' },
  { id: 'location', label: '設置場所' },
  { id: 'department', label: '部門' },
];

const inPeriod = (d, p) => Boolean(d) && d >= p.startDate && d <= p.endDate;

/** 期中に売却・除却した資産か（一括償却資産は除却しても3年で償却を続けるので含めない） */
export function disposedIn(asset, period) {
  return usesLife(asset.method) && inPeriod(asset.disposedOn, period);
}

/** 期中に取得した（使い始めた）資産か。前の帳簿から期首の帳簿価額を引き継いだ資産・一部の売却除却で分けた資産は期首からある */
export function acquiredIn(asset, period) {
  if (!inPeriod(asset.startedOn, period)) return false;
  return !(hasCarryOver(asset) && asset.carryOn <= period.startDate);
}

/**
 * 台帳の1行に、取得価額と帳簿価額の増減・減価償却累計額を足す
 *   期首帳簿価額＋期中増加−当期償却額−期中減少＝期末帳簿価額、減価償却累計額＝取得価額−帳簿価額
 *   期中に取得：期首は0、取得価額を期中増加に。期中に売却・除却：売却・除却した日の帳簿価額を期中減少にし、期末は0
 * @param {{ asset, cost, opening, row, closing }} entry depreciation.assetRegister の1行
 * @param {{ startDate, endDate }} period
 */
export function registerDetail(entry, period) {
  const { asset, cost: c, opening, row, closing } = entry;
  const cost = c ?? asset.cost;
  const increase = acquiredIn(asset, period);
  const disposed = disposedIn(asset, period);
  const book = opening ?? 0;
  const amount = row?.amount || 0;
  const costOpening = increase ? 0 : cost;
  const costIncrease = increase ? cost : 0;
  const costDecrease = disposed ? cost : 0;
  const costClosing = costOpening + costIncrease - costDecrease;
  const bookOpening = increase ? 0 : book;
  const bookIncrease = increase ? book : 0;
  const bookDecrease = disposed ? (row ? row.closing : book) : 0;
  const bookClosing = disposed ? 0 : (closing ?? book);
  const status = disposed ? 'disposed' : increase ? 'new' : amount ? 'active' : 'done';
  return {
    ...entry,
    cost,
    status,
    months: row?.months ?? 0,
    costOpening,
    costIncrease,
    costDecrease,
    costClosing,
    bookOpening,
    bookIncrease,
    bookDecrease,
    ordinary: row?.ordinary ?? 0,
    special: row?.special ?? 0,
    amount,
    business: row?.business ?? 0,
    bookClosing,
    accumulatedOpening: costOpening - bookOpening,
    accumulatedClosing: costClosing - bookClosing,
  };
}

/** 台帳に出ない資産の状態（期首より前に売却・除却・まだ使っていない・償却済み） */
export function otherStatus(asset, period) {
  if (asset.startedOn > period.endDate) return 'future';
  if (asset.disposedOn && asset.disposedOn < period.startDate && asset.method !== 'lump3') return 'gone';
  return 'done';
}

/** 合計する項目 */
export const SUM_KEYS = ['costOpening', 'costIncrease', 'costDecrease', 'costClosing', 'bookOpening', 'bookIncrease', 'bookDecrease', 'ordinary', 'special', 'amount', 'business', 'bookClosing', 'accumulatedOpening', 'accumulatedClosing'];

/** 明細の合計（件数つき） */
export function sumDetails(details) {
  const s = Object.fromEntries(SUM_KEYS.map((k) => [k, 0]));
  for (const d of details) for (const k of SUM_KEYS) s[k] += d[k];
  return { count: details.length, ...s };
}

/** 集計の単位ごとの見出しの値 */
export function groupValue(asset, key) {
  if (key === 'account') return asset.accountId;
  if (key === 'category') return asset.category;
  if (key === 'location') return asset.location || '';
  if (key === 'department') return asset.departmentId || '';
  return '';
}

/**
 * 集計の単位の見出し
 * @param {{ accountById?: Map, departmentById?: Map }} names
 */
export function groupLabel(key, value, { accountById, departmentById } = {}) {
  if (key === 'account') return accountById?.get(value)?.name ?? '（科目なし）';
  if (key === 'category') return CATEGORY_BY_ID[value]?.label ?? '（種類なし）';
  if (key === 'location') return value || '（設置場所の指定なし）';
  if (key === 'department') return departmentById?.get(value)?.name ?? '（部門の指定なし）';
  return '';
}

/**
 * 明細を集計の単位ごとにまとめる（見出しの並びは勘定科目のコード・種類の順・名前の順。指定なしは最後）
 * @returns {Array<{ value, label, items, sum }>}
 */
export function groupDetails(details, key, names = {}) {
  const map = new Map();
  for (const d of details) {
    const v = groupValue(d.asset, key);
    if (!map.has(v)) map.set(v, []);
    map.get(v).push(d);
  }
  const catOrder = Object.keys(CATEGORY_BY_ID);
  const order = (v) => {
    if (key === 'account') return names.accountById?.get(v)?.code ?? '~';
    if (key === 'category') return String(catOrder.indexOf(v)).padStart(3, '0');
    return v ? groupLabel(key, v, names) : '￿';
  };
  return [...map.entries()]
    .sort(([a], [b]) => order(a).localeCompare(order(b), 'ja'))
    .map(([value, items]) => ({ value, label: groupLabel(key, value, names), items, sum: sumDetails(items) }));
}

/** 並び順 */
export const SORT_KEYS = [
  { id: 'no', label: '資産番号順' },
  { id: 'date', label: '使い始めた日順' },
  { id: 'cost', label: '取得価額の大きい順' },
  { id: 'name', label: '名前順' },
];

/** 資産の並べ替え（同じなら資産番号・名前の順） */
export function sortDetails(details, by = 'no') {
  const no = (a) => a.assetNo || '￿';
  const tie = (x, y) => no(x.asset).localeCompare(no(y.asset), 'ja', { numeric: true }) || String(x.asset.name).localeCompare(String(y.asset.name), 'ja');
  const cmp = {
    no: tie,
    date: (x, y) => (x.asset.startedOn < y.asset.startedOn ? -1 : x.asset.startedOn > y.asset.startedOn ? 1 : tie(x, y)),
    cost: (x, y) => (y.cost ?? y.asset.cost) - (x.cost ?? x.asset.cost) || tie(x, y),
    name: (x, y) => String(x.asset.name).localeCompare(String(y.asset.name), 'ja') || tie(x, y),
  }[by] || tie;
  return [...details].sort(cmp);
}

/**
 * 絞り込み
 * @param {{ statuses?: string[], q?: string, accountId?: string, category?: string, departmentId?: string, location?: string }} f
 *   statuses：状態（空ならすべて）、q：名前・資産番号・設置場所・購入先・細目・メモに含む文字
 */
export function matchAsset(asset, status, f = {}) {
  if (f.statuses?.length && !f.statuses.includes(status)) return false;
  if (f.accountId && asset.accountId !== f.accountId) return false;
  if (f.category && asset.category !== f.category) return false;
  if (f.departmentId && (asset.departmentId || '') !== f.departmentId) return false;
  if (f.location && (asset.location || '') !== f.location) return false;
  const q = String(f.q ?? '').trim().toLowerCase();
  if (q) {
    const text = [asset.name, asset.assetNo, asset.location, asset.supplier, asset.structure, asset.detail, asset.memo].filter(Boolean).join(' ').toLowerCase();
    if (!q.split(/\s+/).every((w) => text.includes(w))) return false;
  }
  return true;
}

/**
 * 償却予定表の期間：当期から years 年分（登録済みの会計期間はそのまま、その先は12か月ずつ）
 * @returns {Array<{ startDate, endDate }>}
 */
export function forecastRanges(periods, period, years = 5) {
  const out = [];
  const sorted = [...periods].sort((a, b) => (a.startDate < b.startDate ? -1 : 1)).filter((p) => p.startDate >= period.startDate);
  for (const p of sorted) {
    if (out.length >= years) break;
    if (out.length && p.startDate !== addDays(out.at(-1).endDate, 1)) break;
    out.push({ startDate: p.startDate, endDate: p.endDate });
  }
  while (out.length < years) {
    const start = addDays(out.at(-1).endDate, 1);
    out.push({ startDate: start, endDate: addDays(addMonths(start, 12), -1) });
  }
  return out;
}

/** その期間の期末の帳簿価額（売却・除却した期間以後・まだ使っていなければ0） */
function closingAt(asset, periods, range, row) {
  if (asset.startedOn > range.endDate) return 0;
  if (usesLife(asset.method) && asset.disposedOn && asset.disposedOn <= range.endDate) return 0;
  if (row) return row.closing;
  return openingBook(asset, periods, range) ?? 0;
}

/**
 * 償却予定表（償却額推移表）：資産ごとに当期から years 年分の償却費と、最後の期間の期末帳簿価額
 * 当期より前に売却・除却した資産・償却が終わって帳簿価額が残っていない資産は出さない
 * @returns {{ ranges, rows: Array<{ asset, amounts: number[], business: number[], closing: number[] }>, totals: { amounts, business, closing } }}
 */
export function depreciationForecast(assets, periods, period, years = 5) {
  const ranges = forecastRanges(periods, period, years);
  const last = ranges.at(-1);
  const rows = [];
  for (const asset of assets) {
    if (asset.startedOn > last.endDate) continue;
    if (usesLife(asset.method) && asset.disposedOn && asset.disposedOn < period.startDate) continue;
    if (asset.splitFrom && hasCarryOver(asset) && period.startDate < asset.carryOn) continue;
    const schedule = depreciationSchedule(asset, periods);
    const at = (r) => schedule.find((x) => x.startDate === r.startDate && x.endDate === r.endDate) || null;
    const found = ranges.map(at);
    const amounts = found.map((x) => x?.amount ?? 0);
    const closing = ranges.map((r, i) => closingAt(asset, periods, r, found[i]));
    if (!amounts.some(Boolean) && !closing.some(Boolean)) continue;
    rows.push({ asset, amounts, business: found.map((x) => x?.business ?? 0), closing });
  }
  const add = (key) => ranges.map((_, i) => rows.reduce((s, r) => s + r[key][i], 0));
  return { ranges, rows, totals: { amounts: add('amounts'), business: add('business'), closing: add('closing') } };
}

/** 端数を出さずに total を n か月に分ける（i か月目までの累計＝ floor(total×i÷n)） */
function spread(total, n) {
  const out = [];
  for (let i = 1; i <= n; i += 1) out.push(Math.floor((total * i) / n) - Math.floor((total * (i - 1)) / n));
  return out;
}

/**
 * 月次償却額（その期間の償却費を、償却する月に均等に割り振る。弥生会計・勘定奉行の月次償却と同じく、年額を月数で割り、端数は後の月に寄せる）
 *   定額法・定率法：使い始めた月（期首からなら期首の月）から、売却・除却した月まで。特別償却は期末の月にまとめる
 *   一括償却資産：期間のすべての月。少額（全額を経費）：使い始めた月
 * @param {{ asset, row }} entry depreciation.assetRegister の1行
 * @param {{ startDate, endDate }} period
 * @returns {{ months: string[], amounts: number[], business: number[] }} months は期間の月（'YYYY-MM'）、amounts は月ごとの償却費
 */
export function monthlyDepreciation(entry, period) {
  const months = monthsInPeriod(period);
  const amounts = months.map(() => 0);
  const business = months.map(() => 0);
  const row = entry.row;
  if (!row?.amount) return { months, amounts, business };
  const asset = entry.asset;
  const first = (asset.startedOn > period.startDate ? asset.startedOn : period.startDate).slice(0, 7);
  let idx;
  if (asset.method === 'small' || asset.method === 'sme') idx = [Math.max(0, months.indexOf(first))];
  else if (asset.method === 'lump3') idx = months.map((_, i) => i);
  else {
    const lastMonth = disposedIn(asset, period) ? asset.disposedOn.slice(0, 7) : months.at(-1);
    idx = months.map((m, i) => (m >= first && m <= lastMonth ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) idx = [months.length - 1];
  }
  const ordinary = row.amount - (row.special || 0);
  spread(ordinary, idx.length).forEach((v, k) => (amounts[idx[k]] += v));
  if (row.special) amounts[idx.at(-1)] += row.special;
  // 経費になる額（個人の事業割合）：月ごとの累計の割合で分ける
  let cum = 0;
  let prev = 0;
  for (let i = 0; i < months.length; i += 1) {
    cum += amounts[i];
    const upto = Math.floor((row.business * cum) / row.amount);
    business[i] = upto - prev;
    prev = upto;
  }
  return { months, amounts, business };
}

/**
 * 月次償却額一覧表：資産ごとの月別の償却費と、月ごとの合計
 * @returns {{ months: string[], rows: Array<{ asset, amounts, business, total }>, totals: number[], businessTotals: number[], total: number }}
 */
export function monthlyTable(register, period) {
  const months = monthsInPeriod(period);
  const rows = register.filter((x) => x.row?.amount).map((x) => {
    const m = monthlyDepreciation(x, period);
    return { asset: x.asset, amounts: m.amounts, business: m.business, total: x.row.amount };
  });
  const totals = months.map((_, i) => rows.reduce((s, r) => s + r.amounts[i], 0));
  const businessTotals = months.map((_, i) => rows.reduce((s, r) => s + r.business[i], 0));
  return { months, rows, totals, businessTotals, total: totals.reduce((s, n) => s + n, 0) };
}

/**
 * 当期に売却・除却した資産の一覧（除却資産台帳）
 * 売却損益＝売却額−売却した日の帳簿価額（除却は帳簿価額がそのまま除却損）
 * @param {Array} details registerDetail の結果
 */
export function disposalList(details) {
  return details
    .filter((d) => d.status === 'disposed')
    .map((d) => {
      const sell = d.asset.disposalType === 'sell';
      const price = sell ? (d.asset.salePrice ?? 0) : 0;
      return { ...d, type: sell ? 'sell' : 'retire', date: d.asset.disposedOn, price, accumulatedAtDisposal: d.cost - d.bookDecrease, gainLoss: sell ? price - d.bookDecrease : -d.bookDecrease };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 月次償却の仕訳で計上済みの月
 *   月次償却・期末に残りを登録した仕訳は depMonths（計上した月の配列）を持つ。depMonths の無い減価償却の仕訳は期間の全額（年1回）
 * @returns {{ annual: boolean, months: Set<string>, booked: number }} annual：年1回の仕訳がある、booked：仕訳の償却費の合計（貸方）
 */
export function bookedDepreciation(journals) {
  const done = findDepreciationJournals(journals);
  const months = new Set();
  let annual = false;
  let booked = 0;
  for (const j of done) {
    if (Array.isArray(j.depMonths)) j.depMonths.forEach((m) => months.add(m));
    else annual = true;
    booked += j.lines.filter((l) => l.side === 'credit').reduce((t, l) => t + l.amount, 0);
  }
  return { annual, months, booked };
}

/**
 * 指定した月の分の減価償却の仕訳の明細（月次償却）。月ごとの額は monthlyDepreciation と同じ割り振り
 * @param {{ assets, periods, period, accounts, entityType, departments?, months: string[] }} p months：'YYYY-MM' の配列
 * @returns {{ lines, total, errors }}
 */
export function monthlyDepreciationLines({ months, ...p }) {
  const set = new Set(months);
  const pick = (entry) => {
    const m = monthlyDepreciation(entry, p.period);
    let amount = 0;
    let business = 0;
    m.months.forEach((mm, i) => {
      if (set.has(mm)) {
        amount += m.amounts[i];
        business += m.business[i];
      }
    });
    return { amount, business };
  };
  const sorted = [...set].sort();
  const label = sorted.length === 1 ? `（${Number(sorted[0].slice(5))}月分）` : `（${Number(sorted[0].slice(5))}月〜${Number(sorted.at(-1).slice(5))}月分）`;
  return depreciationLines({ ...p, pick, memoSuffix: label });
}

/** その月の末日（期間の末日を超えない） */
export function monthEnd(month, period) {
  const end = addDays(addMonths(`${month}-01`, 1), -1);
  return end > period.endDate ? period.endDate : end;
}
