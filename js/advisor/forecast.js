// 経営サポート：着地見込み（決算予測）の計算（純粋関数）
//
// 着地＝帳簿の実績（実績とみなす最後の月まで）＋残りの月の予測＋決算整理の見込み（減価償却）。
// 予測は損益の科目ごとに立て方を選ぶ（おまかせ・予算・前期の同じ月×伸び率・直近3か月の平均・金額を入れる・見込まない）。
// 予測の金額は「予測の仕訳」（相手科目は現金）にして実績の仕訳に足し、損益計算書・税額の計算は既存の関数をそのまま使う。
// 予測の仕訳は保存しない（画面を開くたびに帳簿から計算し直す）。保存するのは立て方と手入力の金額（period.forecast）だけ。
// 古田土会計の決算前検討会（10か月の実績＋2か月の予測で売上・利益を予想し、対策後の税額を示す）を参考にした
import { GROUP_BY_ID } from '../accounts.js';
import { isBudgetable, spreadAnnual } from '../budget.js';
import { monthsInPeriod, monthRange } from '../period.js';
import { isAdjusting } from '../monthly.js';
import { buildStatements } from '../statements.js';
import { assetRegister, findDepreciationJournals } from '../depreciation.js';
import { isYen } from '../money.js';

export const FORECAST_METHODS = [
  { id: 'auto', label: 'おまかせ', hint: '予算があれば予算、無ければ前期の同じ月×伸び率、前期の帳簿も無ければ直近3か月の平均' },
  { id: 'budget', label: '予算', hint: '予算の入力の月別の金額' },
  { id: 'last_year', label: '前期の同じ月×伸び率', hint: '伸び率＝当期の実績の累計÷前期の同じ月までの累計（50%〜200%に収める）' },
  { id: 'average', label: '直近3か月の平均', hint: '実績の最後の3か月の平均（決算整理の仕訳は除く）' },
  { id: 'manual', label: '金額を入れる', hint: '残りの月の合計を入れると月に均等に割る' },
  { id: 'none', label: '見込まない', hint: '残りの月は0円' },
];
export const METHOD_BY_ID = Object.fromEntries(FORECAST_METHODS.map((m) => [m.id, m]));
/** おまかせ・固定資産台帳を使ったときの、実際に使った立て方の表示 */
export const RESOLVED_LABELS = { budget: '予算', last_year: '前期×伸び率', average: '直近平均', manual: '手入力', none: '見込まない', asset: '固定資産台帳' };

/** 入力の初期値（period.forecast）。actualThrough：実績とみなす最後の月（null なら今日の前月まで） */
export const DEFAULT_FORECAST = { actualThrough: null, methods: {}, manual: {} };

/** 伸び率（‰）の範囲 */
export const GROWTH_MIN = 500;
export const GROWTH_MAX = 2000;
const MAX_AMOUNT = 999999999999;
const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 入力の検証
 * @param {object} v period.forecast
 * @returns {string[]} 誤り
 */
export function validateForecast(v) {
  const errors = [];
  if (!isObj(v)) return ['着地見込みの設定が不正です'];
  if (v.actualThrough !== null && v.actualThrough !== undefined && !isMonth(v.actualThrough)) errors.push('実績とみなす月が不正です');
  if (v.methods !== undefined && !isObj(v.methods)) errors.push('予測の立て方が不正です');
  for (const [id, m] of Object.entries(isObj(v.methods) ? v.methods : {})) if (typeof id !== 'string' || !METHOD_BY_ID[m]) errors.push('予測の立て方が不正です');
  if (v.manual !== undefined && !isObj(v.manual)) errors.push('手入力の金額が不正です');
  for (const amount of Object.values(isObj(v.manual) ? v.manual : {})) if (!isYen(amount) || amount < -MAX_AMOUNT || amount > MAX_AMOUNT) errors.push('手入力の金額は1兆円未満の整数の円で入れてください');
  return [...new Set(errors)];
}

/** 保存する形にそろえる（既定値の立て方・空の手入力は持たない） */
export function cleanForecast(input = {}) {
  const v = { ...DEFAULT_FORECAST, ...input };
  const methods = Object.fromEntries(Object.entries(v.methods || {}).filter(([, m]) => m && m !== 'auto'));
  const manual = Object.fromEntries(Object.entries(v.manual || {}).filter(([id]) => methods[id] === 'manual'));
  return { actualThrough: v.actualThrough || null, methods, manual };
}

/**
 * 実績とみなす最後の月の既定：今日の前月（期間の前なら null＝実績の月なし、期間の後なら最後の月）
 * 当月はまだ記帳が終わっていないことが多いので、前月までを実績にする
 */
export function defaultActualThrough(period, today) {
  const months = monthsInPeriod(period);
  const cur = today.slice(0, 7);
  if (today > period.endDate) return months.at(-1);
  const done = months.filter((m) => m < cur);
  return done.length ? done.at(-1) : null;
}

/** 予測の対象にする科目（損益の科目。評価勘定・無効の科目・法人税等は除く） */
export function isForecastTarget(account) {
  return isBudgetable(account) && account.group !== 'income_taxes';
}

const signOf = (account) => (GROUP_BY_ID[account.group].side === 'debit' ? 1 : -1);

/**
 * 科目・月ごとの発生額（区分の向きの金額）
 * @param {{ accounts, period, journals, skipAdjusting? }} p skipAdjusting：決算整理の仕訳を除く
 * @returns {Map<string, Map<string, number>>} accountId → 'YYYY-MM' → 金額
 */
export function amountsByMonth({ accounts, period, journals, skipAdjusting = false }) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out = new Map();
  for (const j of journals) {
    if (j.date < period.startDate || j.date > period.endDate) continue;
    if (skipAdjusting && isAdjusting(j)) continue;
    const m = j.date.slice(0, 7);
    for (const l of j.lines) {
      const a = byId.get(l.accountId);
      if (!a || !isForecastTarget(a)) continue;
      const v = (l.side === 'debit' ? l.amount : -l.amount) * signOf(a);
      if (!out.has(a.id)) out.set(a.id, new Map());
      const row = out.get(a.id);
      row.set(m, (row.get(m) || 0) + v);
    }
  }
  return out;
}

/** 保存した「実績とみなす月」を期間に収める（未設定なら undefined、期間の前なら null） */
function clampThrough(through, months) {
  if (!through) return undefined;
  if (through < months[0]) return null;
  return through > months.at(-1) ? months.at(-1) : through;
}

const sumMonths = (row, months) => months.reduce((s, m) => s + (row?.get(m) || 0), 0);

/** 伸び率（‰）。当期の実績の累計÷前期の同じ月までの累計。どちらかが0以下なら100% */
export function growthPermille(actualCum, prevCum) {
  if (actualCum <= 0 || prevCum <= 0) return 1000;
  const g = Math.round((actualCum * 1000) / prevCum);
  return Math.min(GROWTH_MAX, Math.max(GROWTH_MIN, g));
}

/**
 * 着地見込み
 * @param {object} p
 * @param {'individual'|'corporation'} p.entityType
 * @param {Array} p.accounts
 * @param {object} p.period 当期
 * @param {Array} p.journals 当期の仕訳
 * @param {Array} [p.budgets] 予算
 * @param {{ period, journals }|null} [p.prev] 前期の帳簿
 * @param {Array} [p.assets] 固定資産
 * @param {Array} [p.periods] 会計期間の一覧（減価償却の計算に使う）
 * @param {object} [p.input] period.forecast
 * @param {string} p.today 今日（'YYYY-MM-DD'）
 * @returns {{ months, actualThrough, actualMonths, forecastMonths, rows, journals, synthetic, pl, depreciation }}
 *   rows：{ account, method, resolved, growth, actual, forecast, landing, previous, budget, monthly: number[] }
 *   actual：実績の月の発生額＋見込みの月にある決算整理の仕訳
 *   journals：実績の仕訳（見込みの月の仕訳は決算整理だけ）＋予測の仕訳（税額の計算などにそのまま渡す）
 *   dropped：見込みに置き換えた（着地に入れなかった）仕訳の件数
 */
export function forecastLanding({ entityType, accounts, period, journals, budgets = [], prev = null, assets = [], periods = [], input = {}, today }) {
  const v = { ...DEFAULT_FORECAST, ...input };
  const months = monthsInPeriod(period);
  const actualThrough = clampThrough(v.actualThrough, months) ?? defaultActualThrough(period, today);
  const actualMonths = actualThrough ? months.filter((m) => m <= actualThrough) : [];
  const forecastMonths = months.filter((m) => !actualMonths.includes(m));
  const targets = accounts.filter(isForecastTarget);

  // 見込みの月に入っている仕訳（先日付の予定など）は着地に入れず、見込みに置き換える。決算整理の仕訳は残す
  const kept = journals.filter((j) => (actualThrough && j.date.slice(0, 7) <= actualThrough) || isAdjusting(j));
  // 実績：残した仕訳の発生額（決算整理の仕訳も含む）。予測の元になる直近平均・前期は決算整理を除く
  const actual = amountsByMonth({ accounts, period, journals: kept });
  const basis = amountsByMonth({ accounts, period, journals, skipAdjusting: true });
  const prevBasis = prev ? amountsByMonth({ accounts, period: prev.period, journals: prev.journals, skipAdjusting: true }) : null;
  const prevAll = prev ? amountsByMonth({ accounts, period: prev.period, journals: prev.journals }) : null;
  // 前期の月は同じ暦の月（MM）で合わせる
  const prevMonthOf = prev ? new Map(monthsInPeriod(prev.period).map((m) => [m.slice(5, 7), m])) : new Map();
  const ownBudgets = new Map(budgets.filter((b) => b.periodId === period.id).map((b) => [b.accountId, b]));

  // 減価償却：期中に減価償却の仕訳が無ければ、固定資産台帳の当期の償却額（事業分）から計上済みの額を引いて期末に見込む
  const depBooked = findDepreciationJournals(kept).length > 0;
  const depExpected = new Map();
  if (!depBooked) {
    const fallback = accounts.find((a) => a.hint === 'depreciation' && a.active);
    for (const { asset, row } of assetRegister(assets, periods, period)) {
      if (!row?.business) continue;
      const id = (asset.expenseAccountId && accounts.some((a) => a.id === asset.expenseAccountId && a.active) ? asset.expenseAccountId : fallback?.id) || null;
      if (id) depExpected.set(id, (depExpected.get(id) || 0) + row.business);
    }
  }

  const last3 = actualMonths.slice(-3);
  const rows = targets.map((account) => {
    const chosen = v.methods?.[account.id] || 'auto';
    const act = actual.get(account.id);
    const values = months.map((m) => act?.get(m) || 0);
    let resolved = chosen;
    let growth = null;
    const prevOf = (m) => prevBasis?.get(account.id)?.get(prevMonthOf.get(m.slice(5, 7))) || 0;
    const hasPrev = prevBasis && [...(prevBasis.get(account.id)?.values() || [])].some((x) => x !== 0);
    const budget = ownBudgets.get(account.id);
    const hasBudget = budget && Object.keys(budget.months || {}).length > 0;
    if (depExpected.has(account.id) && chosen === 'auto') resolved = 'asset';
    else if (chosen === 'auto') resolved = hasBudget ? 'budget' : hasPrev ? 'last_year' : 'average';

    const forecast = new Map();
    if (resolved === 'asset') {
      const rest = depExpected.get(account.id) - sumMonths(act, months);
      if (rest > 0 && forecastMonths.length) forecast.set(forecastMonths.at(-1), rest);
      else if (rest > 0) forecast.set(months.at(-1), rest); // 期間が終わっていれば最後の月に足す（決算整理の見込み）
    } else if (resolved === 'budget') {
      for (const m of forecastMonths) forecast.set(m, budget?.months?.[m] || 0);
    } else if (resolved === 'last_year') {
      const prevCum = actualMonths.reduce((s, m) => s + prevOf(m), 0);
      growth = growthPermille(sumMonths(basis.get(account.id), actualMonths), prevCum);
      for (const m of forecastMonths) forecast.set(m, Math.round((prevOf(m) * growth) / 1000));
    } else if (resolved === 'average') {
      const avg = last3.length ? Math.round(sumMonths(basis.get(account.id), last3) / last3.length) : 0;
      for (const m of forecastMonths) forecast.set(m, avg);
    } else if (resolved === 'manual') {
      const total = v.manual?.[account.id] || 0;
      for (const [m, x] of Object.entries(forecastMonths.length ? spreadAnnual(total, forecastMonths) : {})) forecast.set(m, x);
    }
    for (const [m, x] of forecast) values[months.indexOf(m)] += x;
    const actualTotal = sumMonths(act, months);
    const forecastTotal = [...forecast.values()].reduce((s, x) => s + x, 0);
    return {
      account,
      method: chosen,
      resolved,
      growth,
      actual: actualTotal,
      forecast: forecastTotal,
      landing: actualTotal + forecastTotal,
      previous: prevAll ? sumMonths(prevAll.get(account.id), [...prevAll.get(account.id)?.keys() || []]) : null,
      budget: budget ? Object.values(budget.months || {}).reduce((s, x) => s + x, 0) : null,
      monthly: values,
      forecastByMonth: forecast,
    };
  });

  // 予測の仕訳：科目・月ごとに1本（相手科目は現金。損益の集計には影響しない）。税区分は科目の既定（消費税の見込みに使う）
  const cash = accounts.find((a) => a.role === 'cash' && a.active) || accounts.find((a) => a.role === 'deposit' && a.active) || accounts.find((a) => GROUP_BY_ID[a.group]?.section === 'bs');
  const synthetic = [];
  if (cash) {
    for (const r of rows) {
      for (const [m, amount] of r.forecastByMonth) {
        if (!amount) continue;
        const date = monthRange(period, m, m).to;
        const plus = amount * signOf(r.account) > 0; // 借方に立つか
        const abs = Math.abs(amount);
        const tax = r.resolved === 'asset' ? 'none' : r.account.defaultTaxCategory || 'none';
        synthetic.push({
          id: `forecast:${r.account.id}:${m}`,
          periodId: period.id,
          date,
          source: 'forecast',
          adjusting: r.resolved === 'asset',
          lines: [
            { side: plus ? 'debit' : 'credit', accountId: r.account.id, subAccountId: null, amount: abs, taxCategory: tax, memo: '予測' },
            { side: plus ? 'credit' : 'debit', accountId: cash.id, subAccountId: null, amount: abs, taxCategory: 'none', memo: '予測' },
          ],
        });
      }
    }
  }
  const all = [...kept, ...synthetic];
  const { pl } = buildStatements({ entityType, accounts, period, journals: all });
  return {
    months,
    actualThrough,
    actualMonths,
    forecastMonths,
    rows: rows.map(({ forecastByMonth, ...r }) => r),
    journals: all,
    synthetic,
    pl,
    depreciation: { booked: depBooked, expected: [...depExpected.values()].reduce((s, x) => s + x, 0) },
    noCash: !cash,
    dropped: journals.length - kept.length,
  };
}
