// 月次推移表（純粋関数）。損益は月ごとの発生額、貸借は月末残高
// 区分・段階利益の計算は statements.js をそのまま使い、決算書と同じ数字になるようにする
import { isBsGroup } from './accounts.js';
import { trialBalance } from './ledger.js';
import { incomeStatement, balanceSheet, closingRows } from './statements.js';
import { monthsInPeriod, monthRange } from './period.js';

/**
 * 月ごとの決算書の行（同じ科目の並びなので位置で揃う）を、値の配列を持つ1つの行にまとめる
 * group：{ type, label, lines:[{account, values}], values }  subtotal：{ type, label, values }
 */
function mergeItems(perMonth) {
  return perMonth[0].map((item, i) => {
    const at = perMonth.map((items) => items[i]);
    if (item.type === 'group') {
      return {
        ...item,
        values: at.map((x) => x.total),
        lines: item.lines.map((l, k) => ({ account: l.account, values: at.map((x) => x.lines[k].amount) })),
      };
    }
    return { ...item, values: at.map((x) => x.amount) };
  });
}

const sum = (values) => values.reduce((s, v) => s + v, 0);

/**
 * 損益の月次推移
 * @returns {{ months: string[], items: Array, netIncome: number[], sales: number[] }}
 *   items の各行に total（期間合計）を付ける。sales：売上の区分の月別合計
 */
export function monthlyIncome({ entityType, accounts, period, journals }) {
  const months = monthsInPeriod(period);
  const perMonth = months.map((m) => {
    const { from, to } = monthRange(period, m, m);
    const rows = trialBalance({ accounts, period, journals, from, to })
      .rows.filter((r) => !isBsGroup(r.account.group))
      .map((r) => ({ account: r.account, dc: r.debit - r.credit }));
    return incomeStatement(entityType, rows);
  });
  const items = mergeItems(perMonth.map((p) => p.items)).map((item) => ({
    ...item,
    total: sum(item.values),
    lines: item.lines?.map((l) => ({ ...l, total: sum(l.values) })),
  }));
  return {
    months,
    items,
    netIncome: perMonth.map((p) => p.netIncome),
    sales: items[0].values,
  };
}

/**
 * 貸借の月次推移（各月末の残高）
 * @returns {{ months: string[], assets: Array, liabilities: Array, balanced: boolean[] }}
 */
export function monthlyBalance({ entityType, accounts, period, journals }) {
  const months = monthsInPeriod(period);
  const perMonth = months.map((m) => {
    const { to } = monthRange(period, m, m);
    const rows = closingRows({ accounts, period, journals, to });
    return balanceSheet(entityType, rows, incomeStatement(entityType, rows).netIncome);
  });
  return {
    months,
    assets: mergeItems(perMonth.map((b) => b.assets)),
    liabilities: mergeItems(perMonth.map((b) => b.liabilities)),
    balanced: perMonth.map((b) => b.balanced),
  };
}

/** 行がすべての月で0か（0円の科目を隠すため） */
export function isAllZero(values) {
  return values.every((v) => v === 0);
}
