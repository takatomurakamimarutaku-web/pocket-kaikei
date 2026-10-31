// サンプルデータを組み立てる道具（純粋関数）。個人・法人のサンプル（sample.js・sample-corporations.js）で使う
import { templateAccounts, manufacturingAccounts, normalSideFor } from './accounts.js';
import { createAccount, createSubAccount, createJournal, createDepartment } from './models.js';

/** 月の日付（日が月末を超えるときは月末） */
export function day(month, d) {
  const last = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  return `${month}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

// 支払条件：末日締め 翌月末日払い
export const MONTH_END = { closingDay: 31, months: 1, payDay: 31 };

/**
 * サンプルの帳簿の土台（科目・補助科目・部門と仕訳を足す関数）
 * @param {{ manufacturing?, subs?, departmentNames?, extra?, rename? }} opts extra：足す科目 [コード, 科目名, 区分, 税区分の初期値]。rename：科目名の変更（テンプレートの名前 → 新しい名前。業種に合わせた呼び名）
 */
export function book(entityType, { manufacturing = false, subs = [], departmentNames = [], extra = [], rename = {} } = {}) {
  const base = templateAccounts(entityType).map((a) => (rename[a.name] ? { ...a, name: rename[a.name] } : a));
  const added = extra.map(([code, name, group, tax]) => ({ code, name, group, role: null, hint: null, normalSide: normalSideFor(group), defaultTaxCategory: tax, active: true, sortOrder: Number(code), template: false }));
  const accounts = [...base, ...(manufacturing ? manufacturingAccounts(base) : []), ...added].map((a) => createAccount(a));
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
