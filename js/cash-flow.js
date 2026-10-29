// キャッシュフロー計算書（間接法）と資金繰り表（純粋関数）
//
// 資金は現金・預金（役割 cash・deposit）。定期預金も含める（3か月を超える定期預金を除く厳密な区分はしない）。
// 間接法は、期首と期末の貸借対照表の差額と損益計算書から作る。各行の合計は必ず資金の増減に一致する：
//   資金の増減 ＝ 利益（個人は所得、法人は当期純利益）＋ 資金以外の貸借対照表の科目の増減（資産は減ると＋、負債・純資産は増えると＋）
// 法人は税引前当期純利益から始め、法人税等は「法人税等の支払額」で差し引く。
// 減価償却費・固定資産の売却損益は営業活動で足し戻し、同じ額を投資活動（固定資産の増減）から除く。
import { GROUP_BY_ID, isBsGroup, isMfgGroup } from './accounts.js';
import { closingRows, incomeStatement, incomeBeforeLabel } from './statements.js';
import { openingRows } from './compare.js';
import { monthsInPeriod } from './period.js';
import { recurringStatus } from './templates.js';

const groupAmount = (r) => (GROUP_BY_ID[r.account.group].side === 'debit' ? r.dc : 0 - r.dc);
const isCash = (a) => a.role === 'cash' || a.role === 'deposit';
const INVENTORY_HINTS = ['inventory', 'finished_goods', 'raw_materials', 'work_in_process', 'supplies'];
const BORROWING_HINTS = ['short_borrowings', 'long_borrowings', 'officer_loan'];

/** 貸借対照表の科目をキャッシュフロー計算書のどの行に入れるか */
export function cfLineOf(account, entityType) {
  const { group, hint, role } = account;
  if (isCash(account)) return 'cash';
  if (['receivable', 'notes_receivable'].includes(hint)) return 'receivables';
  if (INVENTORY_HINTS.includes(hint)) return 'inventories';
  if (['payable', 'notes_payable'].includes(hint)) return 'payables';
  if (hint === 'allowance_doubtful') return 'allowance';
  if (hint === 'income_taxes_payable' && entityType === 'corporation') return 'tax_payable';
  if (['short_loan', 'securities'].includes(hint)) return 'loans';
  if (BORROWING_HINTS.includes(hint)) return 'borrowings';
  if (group === 'tangible_fixed_assets' || group === 'intangible_fixed_assets') return 'fixed';
  if (group === 'investments' || group === 'deferred_assets') return 'investments';
  if (group === 'equity' || group === 'owner_drawings' || role === 'owner_drawings') return 'equity';
  if (group === 'current_assets') return 'other_assets';
  return 'other_liabilities';
}

/**
 * キャッシュフロー計算書（間接法）
 * @returns {{ sections: Array<{ title, lines: Array<{key,label,amount}>, total, subtotal? }>, net, opening, closing, matches: boolean }}
 */
export function cashFlowStatement({ entityType, accounts, period, journals, white = false }) {
  const individual = entityType === 'individual';
  const open = new Map(openingRows({ accounts, period }).map((r) => [r.account.id, groupAmount(r)]));
  const close = closingRows({ accounts, period, journals });
  const { profits } = incomeStatement(entityType, close);
  // 行ごとの資金の増減（資産は減ると＋、負債・純資産は増えると＋）
  const cf = {};
  let opening = 0;
  let closing = 0;
  for (const r of close) {
    if (!isBsGroup(r.account.group)) continue;
    const key = cfLineOf(r.account, entityType);
    const before = open.get(r.account.id) || 0;
    const after = groupAmount(r);
    if (key === 'cash') {
      opening += before;
      closing += after;
      continue;
    }
    const sign = GROUP_BY_ID[r.account.group].side === 'debit' ? -1 : 1;
    cf[key] = (cf[key] || 0) + sign * (after - before);
  }
  const pl = (pred) => close.filter((r) => !isBsGroup(r.account.group) && pred(r.account)).reduce((s, r) => s + groupAmount(r), 0);
  const depreciation = pl((a) => a.hint === 'depreciation' || a.hint === 'mfg_depreciation' || a.hint === 're_depreciation');
  const gainLoss = pl((a) => a.hint === 'asset_sale_loss' || a.hint === 'asset_retirement_loss') - pl((a) => a.hint === 'asset_sale_gain');
  const profit = individual ? profits.income : profits.pretax;
  const taxes = individual ? 0 : profits.pretax - profits.net;
  const v = (k) => cf[k] || 0;

  const opLines = [
    { key: 'profit', label: individual ? `所得金額（${incomeBeforeLabel(white).short}）` : '税引前当期純利益', amount: profit },
    { key: 'depreciation', label: '減価償却費', amount: depreciation },
    ...(individual ? [] : [{ key: 'gain_loss', label: '固定資産売却損益・除却損', amount: gainLoss }]),
    ...(individual ? [] : [{ key: 'allowance', label: '貸倒引当金の増減', amount: v('allowance') }]),
    { key: 'receivables', label: '売上債権の増減', amount: v('receivables') },
    { key: 'inventories', label: '棚卸資産の増減', amount: v('inventories') },
    { key: 'payables', label: '仕入債務の増減', amount: v('payables') },
    { key: 'other_assets', label: 'その他の資産の増減', amount: v('other_assets') },
    { key: 'other_liabilities', label: 'その他の負債の増減', amount: v('other_liabilities') + (individual ? v('allowance') : 0) },
  ];
  const subtotal = opLines.reduce((s, l) => s + l.amount, 0);
  const taxLine = individual ? [] : [{ key: 'taxes_paid', label: '法人税等の支払額', amount: v('tax_payable') - taxes }];
  const operating = subtotal + taxLine.reduce((s, l) => s + l.amount, 0);
  const invLines = [
    { key: 'fixed', label: '固定資産の取得・売却（純額）', amount: v('fixed') - depreciation - (individual ? 0 : gainLoss) },
    { key: 'loans', label: '貸付金・有価証券の増減', amount: v('loans') },
    { key: 'investments', label: '投資その他の資産の増減', amount: v('investments') },
  ];
  const investing = invLines.reduce((s, l) => s + l.amount, 0);
  const finLines = [
    { key: 'borrowings', label: '借入金の増減', amount: v('borrowings') },
    { key: 'equity', label: individual ? '事業主との出し入れ（事業主借−事業主貸）' : '資本金・剰余金の増減（増資・配当など）', amount: v('equity') },
  ];
  const financing = finLines.reduce((s, l) => s + l.amount, 0);
  const net = operating + investing + financing;
  return {
    sections: [
      { key: 'operating', title: 'Ⅰ 営業活動によるキャッシュフロー', lines: opLines, subtotal: individual ? null : subtotal, after: taxLine, total: operating },
      { key: 'investing', title: 'Ⅱ 投資活動によるキャッシュフロー', lines: invLines, total: investing },
      { key: 'financing', title: 'Ⅲ 財務活動によるキャッシュフロー', lines: finLines, total: financing },
    ],
    net,
    opening,
    closing,
    matches: net === closing - opening,
    freeCashFlow: operating + investing,
  };
}

// ---- 資金繰り表 ----

/** 資金繰り表の行（収入・支出・財務と設備） */
export const CASH_PLAN_ROWS = [
  { key: 'sales_in', label: '売上の入金', kind: 'in' },
  { key: 'other_in', label: 'その他の収入', kind: 'in' },
  { key: 'purchase_out', label: '仕入の支払', kind: 'out' },
  { key: 'expense_out', label: '経費の支払', kind: 'out' },
  { key: 'tax_out', label: '税金の支払', kind: 'out' },
  { key: 'other_out', label: 'その他の支出', kind: 'out' },
  { key: 'asset', label: '設備・投資', kind: 'fin' },
  { key: 'borrow', label: '借入れ・返済', kind: 'fin' },
  { key: 'owner', label: '事業主・資本', kind: 'fin' },
];

/**
 * 仕訳の資金以外の行が、資金を増やしたか減らしたか（貸方なら＋）。どの行に入れるかも決める
 * 資金の行を含まない仕訳は対象外（呼び出す側で除く）
 */
export function cashPlanKeyOf(account, effect) {
  const { group, hint } = account;
  if (group === 'sales' || group === 're_income' || ['receivable', 'notes_receivable', 'advance_received'].includes(hint)) return 'sales_in';
  if (group === 'cost_of_sales' || isMfgGroup(group) || ['payable', 'notes_payable', 'advance_paid'].includes(hint)) return 'purchase_out';
  if (group === 'income_taxes' || ['taxes_dues', 're_taxes', 'consumption_tax_payable', 'income_taxes_payable'].includes(hint)) return 'tax_out';
  if (['tangible_fixed_assets', 'intangible_fixed_assets', 'investments', 'deferred_assets'].includes(group) || ['short_loan', 'securities'].includes(hint)) return 'asset';
  if (BORROWING_HINTS.includes(hint)) return 'borrow';
  if (group === 'equity' || group === 'owner_drawings') return 'owner';
  if (['sga', 'non_operating_expenses', 'family_salary', 'extraordinary_losses', 'reserves_provision', 're_expenses', 're_family_salary'].includes(group) || ['accrued', 'accrued_expenses'].includes(hint)) return 'expense_out';
  return effect > 0 ? 'other_in' : 'other_out';
}

/** 1件の仕訳（または定型仕訳）の、行ごとの資金の増減。資金の行が無ければ空 */
export function cashEffects(lines, accountById) {
  if (!lines.some((l) => isCash(accountById.get(l.accountId) || {}))) return [];
  const out = [];
  for (const l of lines) {
    const account = accountById.get(l.accountId);
    if (!account || isCash(account) || !l.amount) continue;
    const effect = l.side === 'credit' ? l.amount : -l.amount;
    out.push({ key: cashPlanKeyOf(account, effect), effect, accountId: l.accountId });
  }
  return out;
}

/** 予算を資金の予定にしない科目（減価償却費・棚卸高・引当金の繰入繰戻は資金が動かない） */
const NON_CASH_HINTS = ['depreciation', 'mfg_depreciation', 're_depreciation', 'opening_materials', 'closing_materials', 'opening_wip', 'closing_wip', 'opening_finished', 'closing_finished'];
function isNonCashBudget(account) {
  return NON_CASH_HINTS.includes(account.hint) || ['opening_inventory', 'closing_inventory'].includes(account.role) || ['reserves_provision', 'reserves_reversal'].includes(account.group);
}

/**
 * 資金繰り表（月別）
 *   今月までは実績（登録済みの仕訳）。来月からは予定：登録済みの先日付の仕訳＋まだ作っていない毎月の定型仕訳
 *   予算（budgets）を渡すと、予算を入れた科目は来月から予算の額をその月に入出金する前提で予定にする
 *   （その科目の先日付の仕訳・定型仕訳は重ねない。掛けの期間は考えない）
 * @param {{ accounts, period, journals, templates?, budgets?, today: string }} p today は 'YYYY-MM-DD'
 * @returns {{ months: Array<{ month, plan: boolean, opening, values: Record<string, number>, income, outgo, operating, finance, net, closing }>, opening }}
 *   values は行ごとの金額。収入・支出は正の数で、財務・設備は資金の増減（＋が入金）
 */
export function cashPlan({ accounts, period, journals, templates = [], budgets = [], today }) {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const months = monthsInPeriod(period);
  const thisMonth = today.slice(0, 7);
  const budgetByAccount = new Map(budgets.filter((b) => b.periodId === period.id && accountById.has(b.accountId)).map((b) => [b.accountId, b]));
  const byBudget = (month, accountId) => month > thisMonth && budgetByAccount.has(accountId);
  const sums = new Map(months.map((m) => [m, {}]));
  const add = (month, effects) => {
    const t = sums.get(month);
    if (!t) return;
    for (const e of effects) if (!byBudget(month, e.accountId)) t[e.key] = (t[e.key] || 0) + e.effect;
  };
  for (const j of journals) {
    if (j.date < period.startDate || j.date > period.endDate) continue;
    add(j.date.slice(0, 7), cashEffects(j.lines, accountById));
  }
  for (const m of months) {
    if (m <= thisMonth) continue;
    for (const s of recurringStatus({ templates, journals, month: m, period })) if (!s.done && s.inPeriod) add(m, cashEffects(s.template.lines, accountById));
    const t = sums.get(m);
    for (const [accountId, b] of budgetByAccount) {
      const account = accountById.get(accountId);
      const amount = b.months[m] || 0;
      if (!amount || isNonCashBudget(account)) continue;
      const effect = GROUP_BY_ID[account.group].side === 'credit' ? amount : -amount;
      const key = cashPlanKeyOf(account, effect);
      t[key] = (t[key] || 0) + effect;
    }
  }
  const opening = openingRows({ accounts, period })
    .filter((r) => isCash(r.account))
    .reduce((s, r) => s + groupAmount(r), 0);
  let balance = opening;
  return {
    opening,
    months: months.map((month) => {
      const t = sums.get(month);
      const values = {};
      for (const row of CASH_PLAN_ROWS) values[row.key] = row.kind === 'out' ? -(t[row.key] || 0) : t[row.key] || 0;
      const income = values.sales_in + values.other_in;
      const outgo = values.purchase_out + values.expense_out + values.tax_out + values.other_out;
      const finance = values.asset + values.borrow + values.owner;
      const before = balance;
      balance += income - outgo + finance;
      return { month, plan: month > thisMonth, opening: before, values, income, outgo, operating: income - outgo, finance, net: income - outgo + finance, closing: balance };
    }),
  };
}
