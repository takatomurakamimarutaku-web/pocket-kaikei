// 月次推移表（純粋関数）。損益は月ごとの発生額、貸借は月末残高
// 区分・段階利益の計算は statements.js をそのまま使い、決算書と同じ数字になるようにする
import { isBsGroup, compareAccounts, GROUP_BY_ID, isContra } from './accounts.js';
import { trialBalance, openingDcMap, toNormal, carriedLabel } from './ledger.js';
import { trialRows } from './trial-rows.js';
import { incomeStatement, balanceSheet, closingRows, manufacturingReport } from './statements.js';
import { monthsInPeriod, monthRange } from './period.js';

/**
 * 月ごとの決算書の行（同じ科目の並びなので位置で揃う）を、値の配列を持つ1つの行にまとめる
 * group：{ type, label, lines:[{account, values}], values }  subtotal：{ type, label, values }
 */
export function mergeItems(perMonth) {
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
 * 製造原価報告書の月次推移（月ごとの発生額）。仕掛品の棚卸高は決算整理の仕訳の月に出る
 * @returns {{ months: string[], items: Array, cost: number[] }} items の各行に total（期間合計）を付ける
 */
export function monthlyManufacturing({ accounts, period, journals }) {
  const months = monthsInPeriod(period);
  const perMonth = months.map((m) => {
    const { from, to } = monthRange(period, m, m);
    const rows = trialBalance({ accounts, period, journals, from, to })
      .rows.filter((r) => !isBsGroup(r.account.group))
      .map((r) => ({ account: r.account, dc: r.debit - r.credit }));
    return manufacturingReport(rows);
  });
  const items = mergeItems(perMonth.map((p) => p.items)).map((item) => ({
    ...item,
    total: sum(item.values),
    lines: item.lines?.map((l) => ({ ...l, total: sum(l.values) })),
  }));
  return { months, items, cost: perMonth.map((p) => p.cost) };
}

/**
 * 月次推移の行（決算書と同じ並び）：区分の見出し・科目・当期材料費などの合計・当期総製造費用・仕掛品棚卸高・当期製品製造原価
 * 材料費に期末材料棚卸高（評価勘定）があれば、その前に「合計」の行を入れ、期末の棚卸高は差し引く額として正の数で書く
 * @param {Array} items monthly.js の monthlyManufacturing の items（各行に values と total）
 * @returns {Array<{ kind, label, values: number[] }>} values の最後は期間の合計
 */
export function manufacturingMonthlyRows(items, { showZero = false } = {}) {
  const vec = (x) => [...x.values, x.total];
  const neg = (v) => v.map((n) => 0 - n);
  const rows = [];
  for (const it of items) {
    if (it.type === 'group') {
      const lines = it.lines.filter((l) => showZero || !isAllZero(l.values));
      if (!lines.length) continue;
      rows.push({ kind: 'group', label: it.label });
      const firstContra = lines.findIndex((l) => isContra(l.account));
      lines.forEach((l, i) => {
        if (firstContra > 0 && i === firstContra) {
          const before = lines.slice(0, firstContra).map(vec);
          rows.push({ kind: 'calc', label: '合計', values: before[0].map((_, k) => before.reduce((s, v) => s + v[k], 0)) });
        }
        rows.push({ kind: 'line', label: l.account.name, account: l.account, values: firstContra > 0 && i >= firstContra ? neg(vec(l)) : vec(l) });
      });
      rows.push({ kind: 'subtotal', label: `当期${it.label}`, values: vec(it) });
      continue;
    }
    if (it.plain) {
      if (showZero || !isAllZero(it.values)) rows.push({ kind: 'calc', label: it.label, values: it.deduct ? neg(vec(it)) : vec(it) });
      continue;
    }
    // 合計（当期総製造費用＋期首仕掛品棚卸高）は期首仕掛品棚卸高があるときだけ
    if (it.calc) {
      if (showZero || rows.at(-1)?.label === '期首仕掛品棚卸高') rows.push({ kind: 'calc', label: it.label, values: vec(it) });
      continue;
    }
    rows.push({ kind: it.strong ? 'total' : 'profit', label: it.label, values: vec(it), strong: Boolean(it.strong) });
  }
  return rows;
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
 *   rows: Array<{ account, values: number[], balances: number[], flows: number[] }>, groups: Array<{ group, rows, values }> }}
 *   values は columns と同じ並びで、科目の残高側の金額
 *   balances・flows：列ごとの残高（その列の末日）と発生額（繰越の列は繰越残高）。借方をプラスにした金額で、科目の区分にかかわらず両方持つ
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
    const balances = plan.map((c) => {
      if (c.type === 'opening') return e.opening;
      if (c.type === 'month' || c.type === 'quarter' || c.type === 'half') return cum[c.at];
      return endBalance;
    });
    const flows = plan.map((c) => {
      if (c.type === 'opening') return e.opening;
      if (c.type === 'month') return e.months[c.at];
      if (c.type === 'quarter' || c.type === 'half') return c.span.reduce((s, k) => s + e.months[k], 0);
      if (c.type === 'adjust') return e.adjust;
      return occurred;
    });
    const values = (bs ? balances : flows).map((v) => toNormal(v, account));
    return { account, values, balances, flows };
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

/**
 * 月次推移試算表を決算書の形にする（市販の会計ソフトの推移試算表と同じく、貸借対照表・損益計算書・製造原価の部に分ける）
 *   列ごとに残高試算表の行（trial-rows.js）を作り、同じ位置の行を値の配列にまとめる。区分の合計・段階利益・当期純損益は残高試算表・決算書と同じ計算
 *   貸借対照表：各列の末日の残高。純資産に期首からの当期純損益金額を入れ、負債・純資産合計で終わる。合計の列は最後の月と同じなので出さず、
 *     決算整理の列は「決算整理後」の残高
 *   損益計算書・製造原価：各列の発生額。繰越の列（期の途中から見るときの、開始月の前日までの累計）は金額があるときだけ出す
 * @param {object} p monthlyTrialBalance の引数
 * @param {{ entityType: string, white?: boolean, showZero?: boolean }} opts
 * @returns {{ bs: Part, pl: Part, mfg: Part }}
 *   Part：{ columns: Array<{ key, label, type }>, rows: Array<{ kind, label, values?: number[], strong?, grand?, account? }> }
 *   kind：group（区分の見出し。values なし）・line（科目）・calc・income・subtotal・total・profit（trial-rows.js と同じ意味）
 */
export function monthlyTrialStatements(p, { entityType, white = false, showZero = false }) {
  const m = monthlyTrialBalance(p);
  const all = m.columns.map((_, i) => i);
  const bsCols = all.filter((i) => m.columns[i].type !== 'total');
  const used = (arr, cols) => showZero || cols.some((i) => arr[i] !== 0);
  // 金額のある科目だけで列ごとの残高試算表を作る（どの列でも同じ科目なので、行の並びがそろう）
  const bsAccounts = m.rows.filter((r) => !isBsGroup(r.account.group) || used(r.balances, bsCols));
  const plAccounts = m.rows.filter((r) => !isBsGroup(r.account.group) && used(r.flows, all));
  const fake = (r, dc) => ({ account: r.account, opening: 0, debit: 0, credit: 0, closing: toNormal(dc, r.account), dc, subs: [] });
  const opts = { entityType, white, showZero: true };
  const valueOf = (r) => {
    if (r.kind === 'account') return r.row.closing;
    if (r.kind === 'subtotal' || r.kind === 'total') return r.sum.closing;
    if (r.kind === 'income') return r.closing;
    return r.amount;
  };
  const merge = (perCol) =>
    perCol[0].map((r, k) => {
      const out = { kind: r.kind === 'account' ? 'line' : r.kind, label: r.label };
      if (r.kind === 'account') out.account = r.row.account;
      if (r.strong) out.strong = true;
      if (r.grand) out.grand = true;
      if (r.kind !== 'group') out.values = perCol.map((rows) => valueOf(rows[k]));
      return out;
    });
  // 計算の行（当期純損益金額・当期製品製造原価）がすべて0なら省く（0円の科目も出すときは残す）
  // 見出しの後に科目などの行が無くなった区分は見出しも省き、科目の行が1つも無い部は空にする
  const content = (r) => r && (r.kind === 'line' || r.kind === 'calc' || r.kind === 'income');
  const tidy = (rows) => {
    const kept = rows.filter((r) => showZero || !(r.kind === 'income' || r.kind === 'calc') || r.values.some((v) => v !== 0));
    const out = kept.filter((r, k) => r.kind !== 'group' || content(kept[k + 1]));
    return out.some(content) ? out : [];
  };
  const bsPer = bsCols.map((i) => trialRows({ rows: bsAccounts.map((r) => fake(r, r.balances[i])) }, opts).bs.rows);
  const plPer = all.map((i) => trialRows({ rows: plAccounts.map((r) => fake(r, r.flows[i])) }, opts));
  const startOf = (month) => (month ? monthRange(p.period, month, month).from : p.period.startDate);
  const carried = carriedLabel(p.period, startOf(m.columns[1]?.key));
  const label = (c, part) => {
    if (c.type === 'opening') return carried;
    if (c.type === 'adjust' && part === 'bs') return '決算整理後';
    return c.label;
  };
  const bs = { columns: bsCols.map((i) => ({ ...m.columns[i], label: label(m.columns[i], 'bs') })), rows: tidy(merge(bsPer)) };
  // 損益計算書・製造原価：繰越の列は金額があるときだけ
  const plPart = (key) => {
    const rows = tidy(merge(plPer.map((t) => t[key].rows)));
    const keep = all.filter((i) => m.columns[i].type !== 'opening' || rows.some((r) => r.values && r.values[i] !== 0));
    return {
      columns: keep.map((i) => ({ ...m.columns[i], label: label(m.columns[i], key) })),
      rows: rows.map((r) => (r.values ? { ...r, values: keep.map((i) => r.values[i]) } : r)),
    };
  };
  return { bs, pl: plPart('pl'), mfg: plPart('mfg') };
}
