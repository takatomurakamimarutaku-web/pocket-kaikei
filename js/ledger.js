// 元帳・試算表・期首残高（純粋関数）
//
// 内部では「借方プラス・貸方マイナス」の符号付き金額（dc）で計算し、
// 表示するときに科目の残高側（normalSide）に合わせて符号を変える。
import { isBsGroup, compareAccounts, findByRole } from './accounts.js';

const keyOf = (accountId, subAccountId) => `${accountId}|${subAccountId || ''}`;

/** 残高側に合わせた表示用の金額 */
export function toNormal(dc, account) {
  return account.normalSide === 'debit' ? dc : 0 - dc;
}

/** 残高側の金額を dc にする */
export function fromNormal(amount, account) {
  return account.normalSide === 'debit' ? amount : 0 - amount;
}

/**
 * 期首残高を dc で集計する
 * @returns {Map<string, number>} キー：`accountId|subAccountId`（補助なしは `accountId|`）
 */
export function openingDcMap(period, accountById) {
  const map = new Map();
  for (const ob of period.openingBalances || []) {
    const acc = accountById.get(ob.accountId);
    if (!acc || !ob.amount) continue;
    const k = keyOf(ob.accountId, ob.subAccountId);
    map.set(k, (map.get(k) || 0) + fromNormal(ob.amount, acc));
  }
  return map;
}

/** 期首残高の貸借差額（借方−貸方）。0 なら一致 */
export function openingDiff(period, accounts) {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  let sum = 0;
  for (const v of openingDcMap(period, accountById).values()) sum += v;
  return sum;
}

/**
 * 個人事業主の元入金＝期首の資産合計−負債合計。
 * 元入金以外の期首残高の dc の合計がそのまま元入金（貸方）になり、期首残高は必ず貸借一致する
 */
export function computeOwnerCapital(openingBalances, accounts) {
  const capital = findByRole(accounts, 'owner_capital');
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  let sum = 0;
  for (const ob of openingBalances) {
    const acc = accountById.get(ob.accountId);
    if (!acc || (capital && acc.id === capital.id) || !ob.amount) continue;
    sum += fromNormal(ob.amount, acc);
  }
  return sum;
}

/**
 * 科目・補助科目ごとの残高の集計
 * @param {{accounts, subAccounts, period, journals, from?, to?}} p from/to：日付範囲（省略時は期間全体）
 * @returns {{ rows: Array, totals, openingDiff }}
 *   rows：科目ごと { account, opening, debit, credit, closing, subs:[{subAccount, opening, debit, credit, closing}] }
 *   opening/closing は残高側の金額。opening は from 時点の繰越残高
 */
export function trialBalance({ accounts, subAccounts = [], period, journals, from = period.startDate, to = period.endDate }) {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const opening = openingDcMap(period, accountById);
  // キーごとの { before, debit, credit }
  const acc = new Map();
  const get = (k) => {
    let e = acc.get(k);
    if (!e) acc.set(k, (e = { before: 0, debit: 0, credit: 0 }));
    return e;
  };
  // 科目の合計（補助科目の一覧に無い補助の金額も含める）
  const byAccount = new Map();
  const add = (accountId, subAccountId, field, v) => {
    get(keyOf(accountId, subAccountId))[field] += v;
    let t = byAccount.get(accountId);
    if (!t) byAccount.set(accountId, (t = { before: 0, debit: 0, credit: 0 }));
    t[field] += v;
  };
  for (const [k, v] of opening) {
    const [accountId, subAccountId] = k.split('|');
    add(accountId, subAccountId, 'before', v);
  }
  for (const j of journals) {
    if (j.date < period.startDate || j.date > to) continue;
    for (const l of j.lines) {
      if (j.date < from) add(l.accountId, l.subAccountId, 'before', l.side === 'debit' ? l.amount : -l.amount);
      else add(l.accountId, l.subAccountId, l.side, l.amount);
    }
  }
  const subsByAccount = new Map();
  for (const s of subAccounts) {
    if (!subsByAccount.has(s.accountId)) subsByAccount.set(s.accountId, []);
    subsByAccount.get(s.accountId).push(s);
  }
  const rows = [...accounts].sort(compareAccounts).map((account) => {
    const line = (e = { before: 0, debit: 0, credit: 0 }) => ({
      opening: toNormal(e.before, account),
      debit: e.debit,
      credit: e.credit,
      closing: toNormal(e.before + e.debit - e.credit, account),
      dc: e.before + e.debit - e.credit,
    });
    const subs = (subsByAccount.get(account.id) || [])
      .slice()
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, 'ja'))
      .map((subAccount) => ({ subAccount, ...line(acc.get(keyOf(account.id, subAccount.id))) }));
    const none = line(acc.get(keyOf(account.id, null)));
    if (subs.length && (none.opening || none.debit || none.credit)) subs.push({ subAccount: null, ...none });
    return { account, ...line(byAccount.get(account.id)), subs };
  });
  let debit = 0;
  let credit = 0;
  let closingDebit = 0;
  let closingCredit = 0;
  for (const r of rows) {
    debit += r.debit;
    credit += r.credit;
    if (r.dc > 0) closingDebit += r.dc;
    else closingCredit -= r.dc;
  }
  return {
    rows,
    totals: { debit, credit, closingDebit, closingCredit },
    openingDiff: openingDiff(period, accounts),
  };
}

/** BS 科目か */
export function isBsAccount(account) {
  return isBsGroup(account.group);
}

/**
 * 相手科目の名前。反対側の明細の科目（補助を含む）が1種類ならその名前、2種類以上なら「諸口」
 */
export function counterpartName(journal, line, accountById, subById) {
  const opposite = journal.lines.filter((l) => l.side !== line.side);
  const keys = new Set(opposite.map((l) => keyOf(l.accountId, l.subAccountId)));
  if (keys.size !== 1) return '諸口';
  const l = opposite[0];
  const name = accountById.get(l.accountId)?.name ?? '（不明な科目）';
  const sub = l.subAccountId ? subById.get(l.subAccountId)?.name : null;
  return sub ? `${name}（${sub}）` : name;
}

/**
 * 総勘定元帳（subAccountId を渡すと補助元帳）
 * @returns {{ account, carried, rows:[{journal, date, no, counterpart, memo, debit, credit, balance}], debit, credit, closing }}
 *   carried：from 時点の繰越残高（残高側）
 */
export function generalLedger({ accountId, subAccountId = null, accounts, subAccounts = [], period, journals, from = period.startDate, to = period.endDate }) {
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const subById = new Map(subAccounts.map((s) => [s.id, s]));
  const account = accountById.get(accountId);
  if (!account) throw new Error('勘定科目が見つかりません');
  const match = (l) => l.accountId === accountId && (!subAccountId || l.subAccountId === subAccountId);
  let dc = 0;
  for (const ob of period.openingBalances || []) {
    if (ob.accountId === accountId && (!subAccountId || ob.subAccountId === subAccountId)) dc += fromNormal(ob.amount, account);
  }
  const sorted = journals.filter((j) => j.date >= period.startDate && j.date <= to).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.no - b.no));
  const rows = [];
  let debit = 0;
  let credit = 0;
  let carried = null;
  for (const j of sorted) {
    if (j.date >= from && carried === null) carried = toNormal(dc, account);
    for (const l of j.lines) {
      if (!match(l)) continue;
      dc += l.side === 'debit' ? l.amount : -l.amount;
      if (j.date < from) continue;
      if (l.side === 'debit') debit += l.amount;
      else credit += l.amount;
      rows.push({
        journal: j,
        date: j.date,
        no: j.no,
        counterpart: counterpartName(j, l, accountById, subById),
        memo: l.memo || '',
        debit: l.side === 'debit' ? l.amount : 0,
        credit: l.side === 'credit' ? l.amount : 0,
        balance: toNormal(dc, account),
      });
    }
  }
  if (carried === null) carried = toNormal(dc, account);
  return { account, carried, rows, debit, credit, closing: toNormal(dc, account) };
}

/**
 * 全科目の総勘定元帳（科目の並び順）。期間に取引があるか、繰越・期末の残高がある科目だけ
 * @returns {Array<ReturnType<typeof generalLedger>>}
 */
export function generalLedgers({ accounts, subAccounts = [], period, journals, from = period.startDate, to = period.endDate }) {
  return [...accounts]
    .sort(compareAccounts)
    .map((a) => generalLedger({ accountId: a.id, accounts, subAccounts, period, journals, from, to }))
    .filter((lg) => lg.rows.length || lg.carried || lg.closing);
}

/** 繰越行の名前（期首からなら「前期繰越」、途中の月からなら「前月繰越」） */
export function carriedLabel(period, from) {
  return from <= period.startDate ? '前期繰越' : '前月繰越';
}


/**
 * 日末の残高（残高側）がマイナスになる最初の日（現金出納帳の注意用）。無ければ null
 * 同じ日の中の順番は入力順にすぎないため、日の終わりの残高で判定する
 */
export function firstNegativeDate({ accountId, subAccountId = null, accounts, subAccounts = [], period, journals }) {
  const lg = generalLedger({ accountId, subAccountId, accounts, subAccounts, period, journals });
  if (lg.carried < 0) return period.startDate;
  for (let i = 0; i < lg.rows.length; i++) {
    const r = lg.rows[i];
    if (lg.rows[i + 1]?.date === r.date) continue;
    if (r.balance < 0) return r.date;
  }
  return null;
}
