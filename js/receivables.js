// 売掛金・買掛金の管理（純粋関数）
// 取引先は補助科目。入金（支払）は古い発生から順に消し込む（先入先出）。
// 入金予定日（支払予定日）は補助科目に設定した支払条件（締め日・何か月後・支払日）から計算する。
// 滞留は発生日からの経過日数で分ける（年齢表）。
import { compareJournals, journalMemo } from './journal.js';
import { addDays, addMonths, daysBetween, isValidDate } from './period.js';
import { toCsv } from './csv.js';

export const PARTY_KINDS = {
  receivable: { id: 'receivable', label: '売掛金', hints: ['receivable'], plus: 'debit', party: '得意先', increase: '売上', decrease: '入金', schedule: '入金予定', due: '入金予定日', over: '過入金', quick: 'receive' },
  payable: { id: 'payable', label: '買掛金', hints: ['payable'], plus: 'credit', party: '仕入先', increase: '仕入', decrease: '支払', schedule: '支払予定', due: '支払予定日', over: '過払い', quick: 'pay' },
};

/** 年齢表の区分（発生日からの経過日数） */
export const AGING_BUCKETS = [
  { id: 'd30', label: '30日以内', max: 30 },
  { id: 'd60', label: '31〜60日', max: 60 },
  { id: 'd90', label: '61〜90日', max: 90 },
  { id: 'd180', label: '91〜180日', max: 180 },
  { id: 'over', label: '181日以上', max: Infinity },
];

/** この日数を超えて残っている発生を「滞留」とする */
export const STALE_DAYS = 90;

export const DAY_CHOICES = [5, 10, 15, 20, 25, 31];
export const MONTH_CHOICES = [0, 1, 2, 3];
const MONTH_LABELS = ['当月', '翌月', '翌々月', '3か月後'];

export const dayLabel = (d) => (d >= 31 ? '末日' : `${d}日`);

/** 支払条件の表示（例：末日締め 翌月末日払い） */
export function termsLabel(t) {
  if (!t) return '';
  return `${dayLabel(t.closingDay)}締め ${MONTH_LABELS[t.months] ?? `${t.months}か月後`}${dayLabel(t.payDay)}払い`;
}

/**
 * 支払条件の検証。null（未設定）はよい
 * @returns {string|null} 誤りの文言
 */
export function validatePaymentTerms(t) {
  if (t === null || t === undefined) return null;
  const day = (d) => Number.isInteger(d) && d >= 1 && d <= 31;
  if (typeof t !== 'object' || !day(t.closingDay) || !day(t.payDay) || !Number.isInteger(t.months) || t.months < 0 || t.months > 12) return '支払条件が正しくありません';
  if (t.months === 0 && t.payDay < t.closingDay) return '当月払いのときは、支払日を締め日より後にしてください';
  return null;
}

const lastDay = (ym) => Number(addDays(addMonths(`${ym}-01`, 1), -1).slice(8));
const dayOf = (ym, d) => `${ym}-${String(Math.min(d, lastDay(ym))).padStart(2, '0')}`;

/**
 * 発生日と支払条件から入金（支払）予定日を出す
 * 締め日（31＝末日）までの発生はその月の締め、過ぎたら翌月の締め。締めた月の months か月後の支払日（月末を超えたら月末）
 */
export function dueDate(date, terms) {
  if (!terms || !isValidDate(date)) return null;
  let ym = date.slice(0, 7);
  if (Number(date.slice(8)) > Math.min(terms.closingDay, lastDay(ym))) ym = addMonths(`${ym}-01`, 1).slice(0, 7);
  return dayOf(addMonths(`${ym}-01`, terms.months).slice(0, 7), terms.payDay);
}

export function bucketOf(days) {
  return AGING_BUCKETS.find((b) => days <= b.max).id;
}

/** 売掛金・買掛金の科目（区分ではなく役割で判定する） */
export function partyAccounts(kind, accounts) {
  const k = PARTY_KINDS[kind];
  return accounts.filter((a) => k.hints.includes(a.hint));
}

/**
 * 取引先ごとの残高と、消し込んだあとに残っている発生の一覧
 * @param {'receivable'|'payable'} kind
 * @param {{ accounts, subAccounts, journals, period, asOf: string }} ctx asOf：基準日（この日までの仕訳で計算する）
 */
export function partyBalances(kind, { accounts, subAccounts, journals, period, asOf }) {
  const k = PARTY_KINDS[kind];
  const targets = new Map(partyAccounts(kind, accounts).map((a) => [a.id, a]));
  const subById = new Map(subAccounts.map((s) => [s.id, s]));
  const parties = new Map();
  const partyOf = (accountId, subAccountId) => {
    const sub = subAccountId && subById.get(subAccountId)?.accountId === accountId ? subById.get(subAccountId) : null;
    const key = `${accountId}|${sub?.id ?? ''}`;
    if (!parties.has(key)) {
      parties.set(key, {
        key,
        accountId,
        subAccountId: sub?.id ?? null,
        accountName: targets.get(accountId).name,
        name: sub?.name ?? '（補助科目なし）',
        terms: sub?.paymentTerms ?? null,
        opening: 0,
        increase: 0,
        decrease: 0,
        queue: [],
        unapplied: 0,
        payments: [],
      });
    }
    return parties.get(key);
  };
  const add = (p, item) => {
    // 先に過入金（過払い）があれば、それで消し込む
    const used = Math.min(p.unapplied, item.amount);
    p.unapplied -= used;
    p.queue.push({ ...item, remaining: item.amount - used });
  };
  const apply = (p, amount) => {
    let rest = amount;
    for (const it of p.queue) {
      if (!rest) break;
      const used = Math.min(it.remaining, rest);
      it.remaining -= used;
      rest -= used;
    }
    p.unapplied += rest;
  };

  const carried = addDays(period.startDate, -1);
  for (const ob of period.openingBalances || []) {
    if (!targets.has(ob.accountId) || !ob.amount) continue;
    const p = partyOf(ob.accountId, ob.subAccountId);
    p.opening += ob.amount;
    if (ob.amount > 0) add(p, { date: carried, amount: ob.amount, memo: '前期から繰越', opening: true, journalId: null, no: null });
    else p.unapplied += -ob.amount;
  }
  const list = journals.filter((j) => j.date <= asOf && j.lines.some((l) => targets.has(l.accountId))).sort(compareJournals);
  for (const j of list) {
    for (const l of j.lines) {
      if (!targets.has(l.accountId)) continue;
      const p = partyOf(l.accountId, l.subAccountId);
      const memo = l.memo || journalMemo(j);
      if (l.side === k.plus) {
        p.increase += l.amount;
        add(p, { date: j.date, amount: l.amount, memo, opening: false, journalId: j.id, no: j.no });
      } else {
        p.decrease += l.amount;
        p.payments.push({ date: j.date, amount: l.amount, memo, journalId: j.id, no: j.no });
        apply(p, l.amount);
      }
    }
  }

  const buckets = Object.fromEntries(AGING_BUCKETS.map((b) => [b.id, 0]));
  const totals = { balance: 0, overdue: 0, stale: 0, overpaid: 0, buckets, noTerms: 0 };
  const result = [...parties.values()].map(({ queue, unapplied, ...p }) => {
    const open = queue
      .filter((it) => it.remaining > 0)
      .map((it) => {
        const due = dueDate(it.date, p.terms);
        const days = Math.max(0, daysBetween(it.date, asOf));
        return { ...it, dueDate: due, days, overdueDays: due && due < asOf ? daysBetween(due, asOf) : 0, bucket: bucketOf(days), stale: days > STALE_DAYS };
      });
    const pb = Object.fromEntries(AGING_BUCKETS.map((b) => [b.id, 0]));
    for (const it of open) pb[it.bucket] += it.remaining;
    const sumOf = (f) => open.filter(f).reduce((s, it) => s + it.remaining, 0);
    const upcoming = open.filter((it) => it.dueDate && it.dueDate >= asOf).map((it) => it.dueDate).sort();
    const party = {
      ...p,
      balance: p.opening + p.increase - p.decrease,
      open,
      buckets: pb,
      overdue: sumOf((it) => it.overdueDays > 0),
      stale: sumOf((it) => it.stale),
      overpaid: unapplied,
      nextDue: upcoming[0] ?? null,
      oldest: open[0]?.date ?? null,
    };
    totals.balance += party.balance;
    totals.overdue += party.overdue;
    totals.stale += party.stale;
    totals.overpaid += party.overpaid;
    for (const b of AGING_BUCKETS) buckets[b.id] += pb[b.id];
    if (!p.terms && open.length) totals.noTerms += 1;
    return party;
  });
  result.sort((a, b) => b.balance - a.balance || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind, asOf, parties: result, totals };
}

/**
 * 入金（支払）予定：予定日ごとの合計。予定日を過ぎたものは overdue にまとめる
 * @returns {{ overdue: { amount, items }, days: Array<{ date, amount, items }> }}
 */
export function schedule(result) {
  const overdue = { amount: 0, items: [] };
  const byDate = new Map();
  for (const p of result.parties) {
    for (const it of p.open) {
      if (!it.dueDate) continue;
      const row = { ...it, party: p };
      if (it.overdueDays > 0) {
        overdue.amount += it.remaining;
        overdue.items.push(row);
      } else {
        if (!byDate.has(it.dueDate)) byDate.set(it.dueDate, { date: it.dueDate, amount: 0, items: [] });
        const d = byDate.get(it.dueDate);
        d.amount += it.remaining;
        d.items.push(row);
      }
    }
  }
  overdue.items.sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  return { overdue, days: [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)) };
}

/** 年齢表の CSV（金額は -1000 形式） */
export function agingCsv(result) {
  const k = PARTY_KINDS[result.kind];
  const header = [k.party, '科目', '残高', ...AGING_BUCKETS.map((b) => b.label), '期日超過', k.over, '支払条件', `次の${k.due}`];
  const rows = result.parties
    .filter((p) => p.balance || p.open.length)
    .map((p) => [p.name, p.accountName, p.balance, ...AGING_BUCKETS.map((b) => p.buckets[b.id]), p.overdue, p.overpaid, termsLabel(p.terms), p.nextDue ? p.nextDue.replaceAll('-', '/') : '']);
  const t = result.totals;
  rows.push(['合計', '', t.balance, ...AGING_BUCKETS.map((b) => t.buckets[b.id]), t.overdue, t.overpaid, '', '']);
  return toCsv([[`${k.label}の年齢表（基準日 ${result.asOf.replaceAll('-', '/')}）`], header, ...rows]);
}
