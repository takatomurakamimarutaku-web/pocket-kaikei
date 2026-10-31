// 経営サポート：利益シミュレーションと年計（移動年計）（純粋関数）
//
// 利益シミュレーション：着地見込みの損益を「売上・変動費・固定費」に分け（経営分析と同じ簡便な勘定科目法：変動費＝売上原価）、
//   売上の増減・変動費率の変化・固定費の増減を入れて、利益と損益分岐点がどう変わるかを出す。目標の利益に必要な売上高も出す。
//   税引後の利益は、利益の差を期末の仕訳1本にして納税予測（tax-forecast.js）を計算し直して求める。
// 年計（移動年計）：各月から過去12か月の売上・利益の合計。季節変動を消して、伸びているか落ちているかを見る
//   （前期の帳簿＋当期の実績・見込みの月別。12か月そろわない月は null）
import { breakEven, plFigures } from '../analysis.js';
import { forecastTaxes } from './tax-forecast.js';
import { amountsByMonth } from './forecast.js';
import { GROUP_BY_ID, compareAccounts } from '../accounts.js';
import { monthsInPeriod } from '../period.js';

/** 入力の初期値。salesPermille：売上の増減（‰）、variableRateDelta：変動費率の変化（‰ポイント）、fixedDelta：固定費の増減（円）、targetProfit：目標の利益（円。null なら出さない） */
export const DEFAULT_SIMULATION = { salesPermille: 0, variableRateDelta: 0, fixedDelta: 0, targetProfit: null };

const div = (a, b) => Math.round(a / b);

/**
 * 売上・変動費・固定費から、利益と損益分岐点を出す
 * @param {{ sales, variable, fixed }} p
 */
export function profitFigures({ sales, variable, fixed }) {
  const marginal = sales - variable;
  const profit = marginal - fixed;
  const marginalRate = sales > 0 ? Math.round((marginal * 1000) / sales) : null; // ‰
  const point = marginal > 0 && sales > 0 ? div(fixed * sales, marginal) : null;
  const safety = point !== null && sales > 0 ? Math.round(((sales - point) * 1000) / sales) : null; // ‰
  return { sales, variable, marginal, marginalRate, fixed, profit, point, safety };
}

/**
 * 利益シミュレーション
 * @param {{ sales, variable, fixed }} base 着地の売上・変動費・固定費
 * @param {object} input DEFAULT_SIMULATION の形
 * @returns {{ base, sim, required }} required：目標の利益に必要な売上高（変動費率がシミュレーション後のまま。限界利益が出なければ null）
 */
export function simulateProfit(base, input = {}) {
  const v = { ...DEFAULT_SIMULATION, ...input };
  const b = profitFigures(base);
  const sales = base.sales + Math.round((base.sales * v.salesPermille) / 1000);
  // 変動費率は着地の率に変化を足す（売上が0なら変動費は着地のまま増減させない）
  const rate = base.sales > 0 ? (base.variable * 1000) / base.sales + v.variableRateDelta : null;
  const variable = rate === null ? base.variable : Math.round((sales * rate) / 1000);
  const fixed = base.fixed + v.fixedDelta;
  const sim = profitFigures({ sales, variable, fixed });
  let required = null;
  if (v.targetProfit !== null && v.targetProfit !== undefined && rate !== null && rate < 1000) {
    required = Math.ceil(((fixed + v.targetProfit) * 1000) / (1000 - rate));
  }
  return { base: b, sim, required, rate };
}

/**
 * 着地の損益計算書から、シミュレーションの元の売上・変動費・固定費を取る（経営分析の breakEven と同じ分け方）
 * 利益は法人は経常利益、個人は青色申告特別控除前の所得金額
 */
export function baseFromPl(entityType, profits) {
  const pl = plFigures(entityType, profits);
  const be = breakEven(pl);
  if (!be) return { sales: pl.sales, variable: pl.cogs, fixed: pl.sales - pl.cogs - pl.profit };
  return { sales: pl.sales, variable: be.variable, fixed: be.fixed };
}

/**
 * 利益の差を期末の仕訳1本にして税金を計算し直す（税引後の利益を出すため）
 * @param {object} p forecastTaxes と同じ引数＋ delta（利益の増減。正なら収益、負なら費用を足す）
 * @returns {number} 法人税等（法人）・所得税と個人事業税（個人）の年税額
 */
export function taxesAtDelta({ settings, accounts, period, journals, actualJournals, delta }) {
  if (!delta) return forecastTaxes({ settings, accounts, period, journals, actualJournals }).incomeTaxes;
  const up = delta > 0;
  const pl = accounts.find((a) => a.active && (up ? a.hint === 'misc_income' || a.group === 'sales' : a.hint === 'misc_expense' || a.group === 'sga'));
  const cash = accounts.find((a) => a.role === 'cash' && a.active) || accounts.find((a) => a.role === 'deposit' && a.active);
  if (!pl || !cash) return null;
  const amount = Math.abs(delta);
  const memo = '利益シミュレーション';
  const extra = {
    id: 'forecast:simulation',
    periodId: period.id,
    date: period.endDate,
    source: 'forecast',
    adjusting: true,
    lines: [
      { side: up ? 'credit' : 'debit', accountId: pl.id, subAccountId: null, amount, taxCategory: 'none', memo },
      { side: up ? 'debit' : 'credit', accountId: cash.id, subAccountId: null, amount, taxCategory: 'none', memo },
    ],
  };
  return forecastTaxes({ settings, accounts, period, journals: [...journals, extra], actualJournals }).incomeTaxes;
}

/**
 * 年計（移動年計）
 * @param {object} p
 * @param {Array} p.accounts
 * @param {object} p.landing forecastLanding の結果（当期の月別。見込みの月を含む）
 * @param {{ period, journals }|null} p.prev 前期の帳簿
 * @returns {{ months, sales: Array<number|null>, profit: Array<number|null>, monthlySales, monthlyProfit, planFrom, change: { sales, profit }|null, rows }}
 *   sales・profit：その月までの12か月の合計（そろわなければ null）。change：最初にそろった月から最後の月までの増減（‰）
 *   rows：科目ごとの { account, monthly（当期の各月の金額）, annual（各月の年計。そろわなければ null）, change }（前期・当期に金額のある科目だけ、科目の並び順）
 */
export function movingAnnual({ accounts, landing, prev }) {
  const side = (a) => GROUP_BY_ID[a.group]?.side;
  const isSales = (a) => a.group === 'sales';
  const prevMonths = prev ? monthsInPeriod(prev.period) : [];
  const allMonths = [...prevMonths, ...landing.months];
  const offset = prevMonths.length;
  // 科目ごとに、前期＋当期の月の並びの金額
  const series = new Map(); // accountId -> number[]
  const byId = new Map(accounts.map((a) => [a.id, a]));
  if (prev) {
    const by = amountsByMonth({ accounts, period: prev.period, journals: prev.journals });
    for (const [id, row] of by) {
      if (!byId.has(id)) continue;
      series.set(id, allMonths.map((m, i) => (i < offset ? row.get(m) || 0 : 0)));
    }
  }
  for (const r of landing.rows) {
    if (!series.has(r.account.id)) {
      series.set(r.account.id, allMonths.map(() => 0));
      byId.set(r.account.id, r.account);
    }
    const xs = series.get(r.account.id);
    landing.months.forEach((_, i) => (xs[offset + i] = r.monthly[i]));
  }
  const roll = (xs, i) => (i < 11 ? null : xs.slice(i - 11, i + 1).reduce((s, x) => s + x, 0));
  const idx = landing.months.map((_, i) => offset + i);
  const pct = (a, b) => (a === null || b === null || b === 0 ? null : Math.round(((a - b) * 1000) / Math.abs(b)));
  const changeOf = (xs) => {
    const first = xs.findIndex((x) => x !== null);
    return first >= 0 && first < xs.length - 1 ? pct(xs.at(-1), xs[first]) : null;
  };
  const total = (pick) => allMonths.map((_, i) => [...series].reduce((t, [id, xs]) => t + pick(byId.get(id), xs[i]), 0));
  const salesAll = total((a, x) => (isSales(a) ? x : 0));
  const profitAll = total((a, x) => (side(a) === 'credit' ? x : -x));
  const sales = idx.map((i) => roll(salesAll, i));
  const profit = idx.map((i) => roll(profitAll, i));
  const first = sales.findIndex((x) => x !== null);
  const rows = [...series]
    .filter(([, xs]) => xs.some((x) => x))
    .sort(([a], [b]) => compareAccounts(byId.get(a), byId.get(b)))
    .map(([id, xs]) => {
      const annual = idx.map((i) => roll(xs, i));
      return { account: byId.get(id), monthly: idx.map((i) => xs[i]), annual, change: changeOf(annual) };
    });
  return {
    months: [...landing.months],
    sales,
    profit,
    monthlySales: idx.map((i) => salesAll[i]),
    monthlyProfit: idx.map((i) => profitAll[i]),
    planFrom: landing.actualMonths.length,
    change: first >= 0 && first < sales.length - 1 ? { sales: pct(sales.at(-1), sales[first]), profit: pct(profit.at(-1), profit[first]) } : null,
    rows,
  };
}
