// サンプルデータを組み立てる道具（純粋関数）。個人・法人のサンプル（sample.js・sample-corporations.js・sample-individuals.js）で使う
// assemble：1期分、または前々期・前期・当期の3期分の帳簿を作る。過去の期は決算整理（棚卸・減価償却・消費税等・法人税等）をして締め、
// 期末残高を次の期の期首残高に繰り越す（アプリの決算・繰越の画面と同じ計算）
import { templateAccounts, manufacturingAccounts, realEstateAccounts, normalSideFor, findByRole, findByHint } from './accounts.js';
import { createAccount, createSubAccount, createJournal, createDepartment, createPeriod, createSettings } from './models.js';
import { monthsInPeriod } from './period.js';
import { trialBalance, computeOwnerCapital } from './ledger.js';
import { carryForwardBalances, nextPeriodDates, inventorySets, inventoryJournalLines } from './closing.js';
import { depreciationLines } from './depreciation.js';
import { computeTaxReturn, consumptionTaxLines } from './tax-return.js';
import { corporateTaxReturn } from './corporate-tax.js';

/** 月の日付（日が月末を超えるときは月末） */
export function day(month, d) {
  const last = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  return `${month}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

// 支払条件：末日締め 翌月末日払い
export const MONTH_END = { closingDay: 31, months: 1, payDay: 31 };

/**
 * サンプルの帳簿の土台（科目・補助科目・部門と仕訳を足す関数）
 * @param {{ manufacturing?, realEstate?, subs?, departmentNames?, extra?, rename? }} opts realEstate：不動産所得の科目を足す（個人）。
 *   extra：足す科目 [コード, 科目名, 区分, 税区分の初期値]。rename：科目名の変更（テンプレートの名前 → 新しい名前。業種に合わせた呼び名）
 */
export function book(entityType, { manufacturing = false, realEstate = false, subs = [], departmentNames = [], extra = [], rename = {} } = {}) {
  const base = templateAccounts(entityType).map((a) => (rename[a.name] ? { ...a, name: rename[a.name] } : a));
  const added = extra.map(([code, name, group, tax]) => ({ code, name, group, role: null, hint: null, normalSide: normalSideFor(group), defaultTaxCategory: tax, active: true, sortOrder: Number(code), template: false }));
  const accounts = [...base, ...(manufacturing ? manufacturingAccounts(base) : []), ...(realEstate ? realEstateAccounts(base) : []), ...added].map((a) => createAccount(a));
  const byName = Object.fromEntries(accounts.map((a) => [a.name, a]));
  const subAccounts = subs.map(([accountName, name, paymentTerms], i) => createSubAccount({ accountId: byName[accountName].id, name, sortOrder: i, ...(paymentTerms ? { paymentTerms: { ...paymentTerms } } : {}) }));
  const subId = (accountName, name) => subAccounts.find((s) => s.accountId === byName[accountName].id && s.name === name)?.id ?? null;
  const departments = departmentNames.map((name, i) => createDepartment({ name, sortOrder: i }));
  const journals = [];
  /** 行は [科目名, 金額, 税区分?, 補助科目名?, 部門名?]。税区分を省くと科目の初期値 */
  const j = (period, date, debits, credits, memo, extra = {}) => {
    const line = (side, [name, amount, tax, sub, dep]) => {
      if (!byName[name]) throw new Error(`サンプルの科目がありません: ${name}`);
      const departmentId = dep ? departments.find((d) => d.name === dep).id : null;
      return { side, accountId: byName[name].id, subAccountId: sub ? subId(name, sub) : null, amount, taxCategory: tax ?? byName[name].defaultTaxCategory, memo, ...(departmentId ? { departmentId } : {}) };
    };
    journals.push(createJournal({ periodId: period.id, date, lines: [...debits.map((d) => line('debit', d)), ...credits.map((c) => line('credit', c))], ...extra }));
  };
  return { accounts, byName, subAccounts, subId, departments, journals, j };
}

/** 入力No・伝票No を日付順に振り、期間の次の番号を入れる */
export function finish(period, journals) {
  journals.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).forEach((x, i) => ((x.no = i + 1), (x.voucherNo = i + 1)));
  period.nextJournalNo = journals.length + 1;
  period.nextVoucherNo = journals.length + 1;
}

/** 期首残高の借方合計−貸方合計（繰越利益剰余金・元入金で合わせる） */
function openingGap(rows, accounts) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return rows.reduce((s, r) => s + (byId.get(r.accountId).normalSide === 'debit' ? r.amount : -r.amount), 0);
}

/** 日付の年をずらす（2026-04-01 → 2024-04-01） */
const shiftYear = (date, years) => `${Number(date.slice(0, 4)) + years}${date.slice(4)}`;

/**
 * 過去の期の決算整理（期末日の仕訳）：棚卸・減価償却・消費税等・法人税等。アプリの決算の画面と同じ関数で金額を出す
 * @param {object} want 期末の棚卸高（棚卸の種類 id → 金額）
 */
function closeYear({ kit, settings, period, periods, assets, journals, want }) {
  const { accounts, subAccounts, departments } = kit;
  const entityType = settings.entityType;
  const own = () => journals.filter((x) => x.periodId === period.id);
  const add = (lines, extra) => lines.length && journals.push(createJournal({ periodId: period.id, date: period.endDate, lines, ...extra }));
  const tb = trialBalance({ accounts, subAccounts, period, journals: own() });
  const balanceOf = (account) => tb.rows.find((r) => r.account.id === account.id)?.closing ?? 0;
  const entries = inventorySets(accounts)
    .filter((set) => want[set.kind.id] != null)
    .map((set) => ({ set, balance: balanceOf(set.goods), closingAmount: want[set.kind.id] }));
  add(inventoryJournalLines(entries), { source: 'inventory' });
  const dep = depreciationLines({ assets, periods, period, accounts, entityType, departments });
  if (dep.errors.length) throw new Error(`サンプルの減価償却: ${dep.errors.join('、')}`);
  add(dep.lines, { source: 'depreciation' });
  if (settings.taxStatus === 'taxable') {
    const r = computeTaxReturn({ journals: own(), period, entityType, ...(period.taxReturn || {}) });
    if (r.payable > 0) add(consumptionTaxLines({ amount: r.payable, accounts }).lines, { source: 'consumption_tax' });
  }
  if (entityType === 'corporation') {
    const r = corporateTaxReturn({ accounts, period, journals: own() });
    const amount = r.payableTarget - r.provision.closing;
    const expense = accounts.find((a) => a.group === 'income_taxes');
    const payable = findByHint(accounts, 'income_taxes_payable');
    const memo = '決算整理 法人税等';
    if (amount > 0) add([{ side: 'debit', accountId: expense.id, subAccountId: null, amount, taxCategory: 'none', memo }, { side: 'credit', accountId: payable.id, subAccountId: null, amount, taxCategory: 'none', memo }], { adjusting: true });
  }
}

/**
 * サンプルの帳簿を組み立てる（Repository.replaceAll に渡せる形）
 * @param {object} spec entityType・settings・book（book() の opts）・dates(year)・opening(ob, ctx)・taxReturn?・year(kit, ctx)・inventory?(ctx)
 *   year は1期分の取引を足す。ctx：period・k（何期目か、0から）・n（期の数）・first・last・mon(月) → その期のその月（'2026-05'）・
 *   open(科目名, 補助科目名?) → 期首残高・g(金額) → 古い期ほど少し小さくした金額（前期比較で伸びが見えるように）・assets（固定資産を足す）
 * @param {{ year?: number, periods?: 1|3 }} opts year：当期の期首の年。periods：3なら前々期・前期（どちらも決算済みで締めてある）と当期
 */
export function assemble(spec, { year = 2026, periods: n = 1 } = {}) {
  const kit = book(spec.entityType, spec.book);
  const { accounts, byName, subId, journals } = kit;
  const settings = createSettings({ entityType: spec.entityType, ...spec.settings });
  const cur = spec.dates(year);
  let period = createPeriod({ startDate: shiftYear(cur.startDate, 1 - n), endDate: shiftYear(cur.endDate, 1 - n) });
  const ob = (name, amount, sub) => ({ accountId: byName[name].id, subAccountId: sub ? subId(name, sub) : null, amount });
  const plug = findByRole(accounts, spec.entityType === 'corporation' ? 'retained_earnings' : 'owner_capital');
  const rows = spec.opening(ob, { firstStart: period.startDate });
  period.openingBalances = [...rows, { accountId: plug.id, subAccountId: null, amount: openingGap(rows, accounts) }];
  const periods = [];
  const assets = [];
  for (let k = 0; k < n; k++) {
    if (spec.taxReturn) period.taxReturn = { ...spec.taxReturn };
    periods.push(period);
    const months = monthsInPeriod(period);
    const p = period;
    const growth = 1 - 0.03 * (n - 1 - k);
    const ctx = {
      period: p,
      k,
      n,
      first: k === 0,
      last: k === n - 1,
      firstStart: periods[0].startDate,
      mon: (num) => months.find((x) => Number(x.slice(5)) === num),
      open: (name, sub = null) => {
        const sid = sub ? subId(name, sub) : null;
        return p.openingBalances.filter((b) => b.accountId === byName[name].id && (b.subAccountId || null) === sid).reduce((s, b) => s + b.amount, 0);
      },
      g: (amount) => (growth === 1 ? amount : Math.round((amount * growth) / 1000) * 1000),
      assets,
    };
    spec.year(kit, ctx);
    const start = journals.findIndex((x) => x.periodId === p.id);
    if (k < n - 1) closeYear({ kit, settings, period: p, periods, assets, journals, want: spec.inventory ? spec.inventory(ctx) : {} });
    finish(p, journals.slice(start).filter((x) => x.periodId === p.id));
    if (k === n - 1) break;
    p.closed = true;
    p.closedAt = new Date().toISOString();
    const { balances } = carryForwardBalances({ entityType: spec.entityType, accounts, subAccounts: kit.subAccounts, period: p, journals: journals.filter((x) => x.periodId === p.id) });
    if (spec.entityType === 'individual') {
      const capital = computeOwnerCapital(balances, accounts);
      if (capital) balances.push({ accountId: plug.id, subAccountId: null, amount: capital });
    }
    period = createPeriod({ ...nextPeriodDates(p, spec.entityType), openingBalances: balances });
  }
  journals.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { settings, currentPeriodId: period.id, accounts, subAccounts: kit.subAccounts, departments: kit.departments, periods, journals, assets, tombstones: [] };
}
