// 月次推移表（純粋関数）。損益は月ごとの発生額、貸借は月末残高
// 区分・段階利益の計算は statements.js をそのまま使い、決算書と同じ数字になるようにする
import { isBsGroup, compareAccounts, GROUP_BY_ID } from './accounts.js';
import { trialBalance, openingDcMap, toNormal } from './ledger.js';
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

/** 決算整理の仕訳を自動で作る画面の印（減価償却・消費税等・期末棚卸） */
export const ADJUSTING_SOURCES = ['depreciation', 'consumption_tax', 'inventory'];

/**
 * 決算整理の仕訳か。仕訳の adjusting（振替伝票で指定）を優先し、無ければ作った画面（source）で判定する。
 * adjusting の導入前に登録した期末棚卸の仕訳は印が無いので、摘要が「決算整理」で始まるものも決算整理とみなす
 */
export function isAdjusting(journal) {
  if (typeof journal.adjusting === 'boolean') return journal.adjusting;
  if (ADJUSTING_SOURCES.includes(journal.source)) return true;
  return journal.lines.some((l) => String(l.memo ?? '').startsWith('決算整理'));
}

/**
 * 月次推移の試算表（残高試算表を月ごとに横に並べる）
 *   貸借の科目：各列の末日の残高。損益の科目：各列の発生額（その月・四半期・半期の合計）
 *   列：繰越残高（開始月の前日まで）・各月・（四半期計・半期計）・（決算整理）・合計
 *   四半期・半期は会計期間の最初の月から3か月・6か月ずつ数え、その最後の月の後ろに置く（範囲外の月は含めない）
 *   separateAdjusting：決算整理の仕訳を月から外し、「決算整理」の列にまとめる（合計には含める）
 * @param {{ accounts, period, journals, fromMonth?, toMonth?, quarters?, halves?, separateAdjusting? }} p
 * @returns {{ columns: Array<{ key, label, type: 'opening'|'month'|'quarter'|'half'|'adjust'|'total' }>,
 *   rows: Array<{ account, values: number[] }>, groups: Array<{ group, rows, values }> }}
 *   values は columns と同じ並びで、科目の残高側の金額
 */
export function monthlyTrialBalance({ accounts, period, journals, fromMonth, toMonth, quarters = false, halves = false, separateAdjusting = false }) {
  const all = monthsInPeriod(period);
  const months = all.filter((m) => (!fromMonth || m >= fromMonth) && (!toMonth || m <= toMonth));
  const index = new Map(months.map((m, i) => [m, i]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const blank = () => ({ opening: 0, months: months.map(() => 0), adjust: 0 });
  const dc = new Map(accounts.map((a) => [a.id, blank()]));
  for (const [k, v] of openingDcMap(period, accountById)) dc.get(k.split('|')[0]).opening += v;
  const first = months[0];
  const last = months.at(-1);
  for (const j of journals) {
    if (j.date < period.startDate || j.date > period.endDate) continue;
    const m = j.date.slice(0, 7);
    if (m > last) continue;
    for (const l of j.lines) {
      const e = dc.get(l.accountId);
      if (!e) continue;
      const v = l.side === 'debit' ? l.amount : -l.amount;
      if (m < first) e.opening += v;
      else if (separateAdjusting && isAdjusting(j)) e.adjust += v;
      else e.months[index.get(m)] += v;
    }
  }
  // 列の組み立て
  const columns = [{ key: 'opening', label: '繰越残高', type: 'opening' }];
  const plan = []; // 列ごとの計算：{ type, at?（月の位置）, span?（月の位置の配列） }
  plan.push({ type: 'opening' });
  months.forEach((m, i) => {
    columns.push({ key: m, label: `${Number(m.slice(5))}月`, type: 'month' });
    plan.push({ type: 'month', at: i });
    const n = all.indexOf(m) + 1; // 会計期間の何か月目か
    const span = (size) => months.map((x, k) => [x, k]).filter(([x]) => Math.ceil((all.indexOf(x) + 1) / size) === n / size).map(([, k]) => k);
    if (quarters && n % 3 === 0) {
      columns.push({ key: `q${n / 3}`, label: `第${n / 3}四半期`, type: 'quarter' });
      plan.push({ type: 'quarter', span: span(3), at: i });
    }
    if (halves && n % 6 === 0) {
      columns.push({ key: `h${n / 6}`, label: n === 6 ? '上半期' : '下半期', type: 'half' });
      plan.push({ type: 'half', span: span(6), at: i });
    }
  });
  if (separateAdjusting) {
    columns.push({ key: 'adjust', label: '決算整理', type: 'adjust' });
    plan.push({ type: 'adjust' });
  }
  columns.push({ key: 'total', label: '合計', type: 'total' });
  plan.push({ type: 'total' });

  const rows = [...accounts].sort(compareAccounts).map((account) => {
    const e = dc.get(account.id);
    const bs = isBsGroup(account.group);
    const cum = []; // 月末の残高（借方プラス）
    e.months.reduce((s, v, i) => (cum[i] = s + v), e.opening);
    const endBalance = (cum.at(-1) ?? e.opening) + e.adjust;
    const occurred = e.months.reduce((s, v) => s + v, 0) + e.adjust;
    const values = plan.map((c) => {
      let v;
      if (c.type === 'opening') v = e.opening;
      else if (c.type === 'month') v = bs ? cum[c.at] : e.months[c.at];
      else if (c.type === 'quarter' || c.type === 'half') v = bs ? cum[c.at] : c.span.reduce((s, k) => s + e.months[k], 0);
      else if (c.type === 'adjust') v = bs ? endBalance : e.adjust;
      else v = bs ? endBalance : occurred;
      return toNormal(v, account);
    });
    return { account, values };
  });
  // 区分ごとの小計（区分の向きで足す。評価勘定は差し引く）
  const groups = [];
  for (const r of rows) {
    let g = groups.at(-1);
    if (!g || g.group !== r.account.group) groups.push((g = { group: r.account.group, rows: [], values: columns.map(() => 0) }));
    const sign = r.account.normalSide === GROUP_BY_ID[r.account.group].side ? 1 : -1;
    g.rows.push(r);
    r.values.forEach((v, i) => (g.values[i] += sign * v));
  }
  return { columns, rows, groups };
}
