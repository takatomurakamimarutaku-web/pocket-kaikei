// 予算と実績（純粋関数）
//
// 予算は会計期間・損益の科目ごとに、月別の金額（区分の向きの正の整数）で持つ。
// 予算と実績をそれぞれ損益計算書の形にして突き合わせ、差異（実績−予算）と達成率（実績÷予算）を出す。
import { GROUP_BY_ID, isBsGroup, isContra } from './accounts.js';
import { incomeStatement } from './statements.js';
import { trialBalance } from './ledger.js';
import { compareStatement } from './compare.js';
import { permille } from './analysis.js';
import { monthsInPeriod, monthRange } from './period.js';

const MAX_AMOUNT = 999999999999;

/** 予算を立てられる科目（損益の科目。評価勘定（期末棚卸高など）と無効の科目は除く） */
export function isBudgetable(account) {
  return Boolean(account) && !isBsGroup(account.group) && !isContra(account) && account.active !== false;
}

/** 年額を月に均等に割る（1円未満の端数は最後の月に寄せる） */
export function spreadAnnual(total, months) {
  if (!months.length) return {};
  const base = Math.floor(total / months.length);
  const out = Object.fromEntries(months.map((m) => [m, base]));
  out[months.at(-1)] += total - base * months.length;
  return out;
}

/** 月別の金額の合計（months を省くとすべての月） */
export function budgetTotal(budget, months = null) {
  return Object.entries(budget?.months || {}).reduce((s, [m, v]) => (!months || months.includes(m) ? s + v : s), 0);
}

/**
 * 予算の検証
 * @param {object} budget
 * @param {{ accounts: Array, periods: Array }} ctx
 * @returns {string[]} 誤り
 */
export function validateBudget(budget, { accounts, periods }) {
  const errors = [];
  const account = accounts.find((a) => a.id === budget.accountId);
  if (!account) errors.push('予算の科目が見つかりません');
  else if (isBsGroup(account.group) || isContra(account)) errors.push(`${account.name}には予算を立てられません（損益の科目だけ）`);
  const period = periods.find((p) => p.id === budget.periodId);
  if (!period) errors.push('予算の会計期間が見つかりません');
  if (!budget.months || typeof budget.months !== 'object' || Array.isArray(budget.months)) {
    errors.push('予算の月別の金額が不正です');
    return errors;
  }
  const months = period ? monthsInPeriod(period) : [];
  for (const [m, v] of Object.entries(budget.months)) {
    if (period && !months.includes(m)) errors.push(`${m} は会計期間の外です`);
    if (!Number.isInteger(v) || v < 0 || v > MAX_AMOUNT) errors.push(`${account?.name ?? ''}の${m}の予算は0以上の整数（円）にしてください`);
  }
  return errors;
}

/** 予算を試算表の行の形にする（範囲の月の合計） */
function budgetRows(accounts, budgets, months) {
  const byAccount = new Map(budgets.map((b) => [b.accountId, b]));
  return accounts
    .filter((a) => !isBsGroup(a.group))
    .map((account) => {
      const amount = budgetTotal(byAccount.get(account.id), months);
      return { account, dc: GROUP_BY_ID[account.group].side === 'debit' ? amount : 0 - amount };
    });
}

/** 範囲の月の実績（損益の科目の借方−貸方） */
function actualRows({ accounts, period, journals, from, to }) {
  return trialBalance({ accounts, period, journals, from, to })
    .rows.filter((r) => !isBsGroup(r.account.group))
    .map((r) => ({ account: r.account, dc: r.debit - r.credit }));
}

/**
 * 予算と実績の対比
 * @param {{ entityType, accounts, period, journals, budgets, fromMonth?, toMonth? }} p
 * @returns {{ rows: Array<{ key, kind, label, budget, actual, diff, achievement }>, budgetPl, actualPl, months }}
 *   diff＝実績−予算、achievement＝実績÷予算（‰、予算が0なら null）
 */
export function budgetVsActual({ entityType, accounts, period, journals, budgets, fromMonth, toMonth }) {
  const all = monthsInPeriod(period);
  const months = all.filter((m) => (!fromMonth || m >= fromMonth) && (!toMonth || m <= toMonth));
  const { from, to } = monthRange(period, months[0], months.at(-1));
  const own = budgets.filter((b) => b.periodId === period.id);
  const budgetPl = incomeStatement(entityType, budgetRows(accounts, own, months));
  const actualPl = incomeStatement(entityType, actualRows({ accounts, period, journals, from, to }));
  const rows = compareStatement(actualPl.items, budgetPl.items).map((r) => ({
    ...r,
    actual: r.current,
    budget: r.previous,
    achievement: r.kind === 'group' ? null : permille(r.current, r.previous),
  }));
  return { rows, budgetPl, actualPl, months };
}

/** 月ごとの売上の実績と予算（グラフ用） */
export function monthlySales({ accounts, period, journals, budgets }) {
  const sales = new Set(accounts.filter((a) => a.group === 'sales').map((a) => a.id));
  const months = monthsInPeriod(period);
  const actual = new Map(months.map((m) => [m, 0]));
  for (const j of journals) {
    const m = j.date.slice(0, 7);
    if (!actual.has(m) || j.date < period.startDate || j.date > period.endDate) continue;
    for (const l of j.lines) if (sales.has(l.accountId)) actual.set(m, actual.get(m) + (l.side === 'credit' ? l.amount : -l.amount));
  }
  const own = budgets.filter((b) => b.periodId === period.id && sales.has(b.accountId));
  return months.map((month) => ({ month, actual: actual.get(month), budget: own.reduce((s, b) => s + (b.months[month] || 0), 0) }));
}

/**
 * 前期の実績から予算を作る。同じ暦の月の実績に割合（%）を掛ける（1円未満は四捨五入、マイナスは0）
 * @returns {Array<{ accountId, months }>}
 */
export function budgetFromActuals({ accounts, prevPeriod, prevJournals, period, ratio = 100 }) {
  const targets = accounts.filter(isBudgetable);
  const ids = new Set(targets.map((a) => a.id));
  const byKey = new Map();
  for (const j of prevJournals) {
    if (j.date < prevPeriod.startDate || j.date > prevPeriod.endDate) continue;
    for (const l of j.lines) {
      if (!ids.has(l.accountId)) continue;
      const k = `${l.accountId}|${j.date.slice(5, 7)}`;
      byKey.set(k, (byKey.get(k) || 0) + (l.side === 'debit' ? l.amount : -l.amount));
    }
  }
  const months = monthsInPeriod(period);
  return targets
    .map((account) => {
      const sign = GROUP_BY_ID[account.group].side === 'debit' ? 1 : -1;
      const out = {};
      for (const m of months) {
        const v = Math.round(((byKey.get(`${account.id}|${m.slice(5, 7)}`) || 0) * sign * ratio) / 100);
        if (v > 0) out[m] = v;
      }
      return { accountId: account.id, months: out };
    })
    .filter((e) => Object.keys(e.months).length);
}
