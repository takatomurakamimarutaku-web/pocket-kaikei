// 消費税の集計表（純粋関数）：科目別税区分集計表・税区分別の月別推移・税区分のチェックリスト
// 弥生会計の「科目別税区分表」「消費税集計表」、勘定奉行の科目別・税区分別の集計と税区分の確認を参考にした
// 金額の向きは税区分別集計（tax.js の signedTaxAmount）と同じ。割り戻しの参考値も tax.js の backCalc
import { TAX_BY_CODE, TAX_CATEGORIES, signedTaxAmount, backCalc } from './tax.js';
import { GROUP_BY_ID, compareAccounts, isBsGroup } from './accounts.js';
import { isAdjusting } from './monthly.js';
import { monthRange } from './period.js';

const inRange = (j, from, to) => j.date >= from && j.date <= to;
const CODE_ORDER = new Map(TAX_CATEGORIES.map((c, i) => [c.code, i]));

/**
 * 集計に入れる明細の金額。課税・非課税などの区分は税区分の向き、対象外は損益の科目だけを科目の残高の向きで入れる
 * （費用の科目が「対象外」になっていないかを見るため。貸借の科目の対象外は消費税と関係ないので入れない）
 * @returns {number|null} 入れないときは null
 */
function lineAmount(line, account) {
  const cat = TAX_BY_CODE[line.taxCategory];
  if (!cat) return null;
  if (cat.kind !== 'none') return signedTaxAmount(line);
  if (!account || isBsGroup(account.group)) return null;
  return line.side === account.normalSide ? line.amount : -line.amount;
}

/**
 * 科目別税区分集計表：科目ごとに、使った税区分の税込金額・税抜（参考）・消費税等（参考）・件数
 * @param {{ journals, accounts, from?, to?, includeAdjusting? }} input includeAdjusting：決算整理の仕訳を含める（既定は含める）
 * @returns {{ rows: Array<{ account, items: Array<{code,label,count,gross,net,tax}>, total: {gross,net,tax} }>,
 *   byCode: Array<{code,label,count,gross,net,tax}> }} byCode：税区分ごとの合計（対象外を除くと税区分別集計と一致する）
 */
export function taxByAccount({ journals, accounts, from = '', to = '9999-12-31', includeAdjusting = true }) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const map = new Map(); // accountId → Map(code → {gross,count})
  for (const j of journals) {
    if (!inRange(j, from, to) || (!includeAdjusting && isAdjusting(j))) continue;
    for (const line of j.lines) {
      const account = byId.get(line.accountId);
      const amount = lineAmount(line, account);
      if (amount === null || !account) continue;
      const codes = map.get(account.id) || new Map();
      const t = codes.get(line.taxCategory) || { gross: 0, count: 0 };
      t.gross += amount;
      t.count += 1;
      codes.set(line.taxCategory, t);
      map.set(account.id, codes);
    }
  }
  const item = (code, t) => {
    const cat = TAX_BY_CODE[code];
    const { gross, net, tax } = backCalc(t.gross, cat);
    return { code, label: cat.label, count: t.count, gross, net, tax };
  };
  const rows = [...map.entries()]
    .map(([id, codes]) => {
      const items = [...codes.entries()].sort((a, b) => CODE_ORDER.get(a[0]) - CODE_ORDER.get(b[0])).map(([code, t]) => item(code, t));
      const total = items.reduce((s, x) => ({ gross: s.gross + x.gross, net: s.net + x.net, tax: s.tax + x.tax }), { gross: 0, net: 0, tax: 0 });
      return { account: byId.get(id), items, total };
    })
    .sort((a, b) => compareAccounts(a.account, b.account));
  const sums = new Map();
  for (const r of rows) {
    for (const x of r.items) {
      const t = sums.get(x.code) || { gross: 0, count: 0 };
      t.gross += x.gross;
      t.count += x.count;
      sums.set(x.code, t);
    }
  }
  const byCode = [...sums.entries()].sort((a, b) => CODE_ORDER.get(a[0]) - CODE_ORDER.get(b[0])).map(([code, t]) => item(code, t));
  return { rows, byCode };
}

/**
 * 税区分別の月別推移：税区分ごとに月の税込金額と消費税等（参考）を横に並べる
 * 消費税等は月ごとに割り戻すため、合計の列は期間の税込金額から割り戻した値（月の合計と1円単位でずれることがある）
 * @param {{ journals, period, months: string[], includeAdjusting? }} input months：並べる月（YYYY-MM）
 * @returns {{ months: string[], rows: Array<{ code, label, group, gross: number[], tax: number[], total: {gross, tax} }>, netTax: number[], netTaxTotal: number }}
 *   rows は使った税区分（対象外を除く）だけ。netTax：月ごとの差引（納める消費税等の参考値。経過措置・按分は考えない）
 */
export function taxMonthly({ journals, period, months, includeAdjusting = true }) {
  const ranges = months.map((m) => monthRange(period, m, m));
  const map = new Map();
  for (const j of journals) {
    if (!includeAdjusting && isAdjusting(j)) continue;
    const i = ranges.findIndex((r) => inRange(j, r.from, r.to));
    if (i < 0) continue;
    for (const line of j.lines) {
      const cat = TAX_BY_CODE[line.taxCategory];
      if (!cat || cat.kind === 'none') continue;
      const v = map.get(cat.code) || months.map(() => 0);
      v[i] += signedTaxAmount(line);
      map.set(cat.code, v);
    }
  }
  const rows = [...map.entries()]
    .sort((a, b) => CODE_ORDER.get(a[0]) - CODE_ORDER.get(b[0]))
    .map(([code, gross]) => {
      const cat = TAX_BY_CODE[code];
      const sum = gross.reduce((s, v) => s + v, 0);
      return { code, label: cat.label, group: cat.group, effect: cat.effect, gross, tax: gross.map((g) => backCalc(g, cat).tax), total: { gross: sum, tax: backCalc(sum, cat).tax } };
    });
  const netTax = months.map((_, i) => rows.reduce((s, r) => s + r.effect * r.tax[i], 0));
  return { months, rows, netTax, netTaxTotal: rows.reduce((s, r) => s + r.effect * r.total.tax, 0) };
}

/** チェックの種類。level：warn＝誤りの可能性が高い、info＝念のため確認 */
export const TAX_CHECKS = {
  income_purchase: { level: 'warn', label: '収益の科目に仕入の税区分' },
  expense_sales: { level: 'warn', label: '費用の科目に売上の税区分' },
  bs_taxed: { level: 'warn', label: '現金・預金・債権債務などの科目に税区分' },
  purchase_credit: { level: 'info', label: '仕入・経費の税区分が貸方（返品・値引きなら「仕入の返品・値引き」）' },
  sales_debit: { level: 'info', label: '売上の税区分が借方（返品・値引きなら「売上の返品・値引き」）' },
  default_diff: { level: 'info', label: '科目の初期値と違う税区分' },
};

// 税区分を付けてよい貸借の区分（固定資産の取得・売却、繰延資産）
const TAXABLE_BS_GROUPS = ['tangible_fixed_assets', 'intangible_fixed_assets', 'investments', 'deferred_assets'];

/**
 * 税区分のチェックリスト：誤りやすい税区分の明細を探す（決めつけず、確認を促す）
 * @param {{ journals, accounts, from?, to?, includeDefaultDiff? }} input includeDefaultDiff：科目の初期値と違うものも出す
 * @returns {Array<{ journal, lineIndex, line, account, type, level, message }>} 日付・伝票番号の順
 */
export function taxChecks({ journals, accounts, from = '', to = '9999-12-31', includeDefaultDiff = false }) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out = [];
  const sorted = journals.filter((j) => inRange(j, from, to)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.no ?? 0) - (b.no ?? 0)));
  for (const j of sorted) {
    j.lines.forEach((line, lineIndex) => {
      const account = byId.get(line.accountId);
      const cat = TAX_BY_CODE[line.taxCategory];
      if (!account || !cat) return;
      const group = GROUP_BY_ID[account.group];
      const pl = group?.section === 'pl';
      const income = pl && group.side === 'credit';
      const expense = pl && group.side === 'debit';
      const push = (type) => out.push({ journal: j, lineIndex, line, account, type, level: TAX_CHECKS[type].level, message: TAX_CHECKS[type].label });
      if (cat.kind === 'purchase' && income) return push('income_purchase');
      // 売上の返品・値引き・貸倒れ（借方がプラス）は費用の科目（売上値引・貸倒損失など）で使うことがある
      if (cat.kind === 'sales' && cat.plus === 'credit' && expense) return push('expense_sales');
      if (cat.kind !== 'none' && !pl && !TAXABLE_BS_GROUPS.includes(account.group)) return push('bs_taxed');
      if (cat.kind === 'purchase' && cat.plus === 'debit' && !cat.taxOnly && cat.role !== 'exempt' && expense && line.side === 'credit') return push('purchase_credit');
      if (cat.kind === 'sales' && cat.plus === 'credit' && income && line.side === 'debit') return push('sales_debit');
      if (includeDefaultDiff && account.defaultTaxCategory && line.taxCategory !== account.defaultTaxCategory) push('default_diff');
    });
  }
  return out;
}
