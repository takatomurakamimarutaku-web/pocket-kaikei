// 仕訳のチェック：入力の誤りの可能性を探す（純粋関数。決めつけず、確認を促す）
//   重複の可能性・現金や預金の残高がマイナスになった日・残高が通常と逆の科目・仮払金などの残り・未来の日付
import { isCashAccount } from './quick.js';
import { trialBalance } from './ledger.js';

const lineKey = (l) => `${l.side}|${l.accountId}|${l.subAccountId || ''}|${l.amount}`;

/**
 * 同じ日付・同じ明細（貸借・科目・補助科目・金額）の仕訳の組
 * @returns {Array<Array<object>>} 2件以上の組（日付・番号の順）
 */
export function duplicateJournals(journals) {
  const groups = new Map();
  for (const j of journals) {
    const key = `${j.date}#${j.lines.map(lineKey).sort().join(',')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(j);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort((a, b) => (a.no ?? 0) - (b.no ?? 0)))
    .sort((a, b) => (a[0].date < b[0].date ? -1 : a[0].date > b[0].date ? 1 : 0));
}

/**
 * 現金・預金（補助科目ごと）の日々の残高がマイナスになった日
 * 同じ日の入出金はまとめて、その日の終わりの残高で判定する（入力の順序によらない）
 * @returns {Array<{ accountId, subAccountId, firstDate, minBalance, minDate, days }>}
 */
export function negativeCashDays({ accounts, period, journals }) {
  const cash = new Set(accounts.filter(isCashAccount).map((a) => a.id));
  const key = (accountId, subAccountId) => `${accountId}|${subAccountId || ''}`;
  const balance = new Map();
  for (const ob of period.openingBalances || []) if (cash.has(ob.accountId)) balance.set(key(ob.accountId, ob.subAccountId), (balance.get(key(ob.accountId, ob.subAccountId)) || 0) + ob.amount);
  const byDate = new Map();
  for (const j of journals) {
    if (j.date < period.startDate || j.date > period.endDate) continue;
    for (const l of j.lines) {
      if (!cash.has(l.accountId)) continue;
      if (!byDate.has(j.date)) byDate.set(j.date, new Map());
      const day = byDate.get(j.date);
      const k = key(l.accountId, l.subAccountId);
      day.set(k, (day.get(k) || 0) + (l.side === 'debit' ? l.amount : -l.amount));
    }
  }
  const out = new Map();
  for (const date of [...byDate.keys()].sort()) {
    for (const [k, v] of byDate.get(date)) {
      const b = (balance.get(k) || 0) + v;
      balance.set(k, b);
      if (b >= 0) continue;
      const [accountId, subAccountId] = k.split('|');
      const e = out.get(k) || { accountId, subAccountId: subAccountId || null, firstDate: date, minBalance: b, minDate: date, days: 0 };
      e.days++;
      if (b < e.minBalance) Object.assign(e, { minBalance: b, minDate: date });
      out.set(k, e);
    }
  }
  return [...out.values()];
}

/**
 * 期末の残高が通常と逆（残高側の金額がマイナス）の科目・補助科目
 * 評価勘定（減価償却累計額など）は残高の側が逆なので、科目の normalSide で判定される
 * @returns {Array<{ account, subAccount: object|null, closing: number }>}
 */
export function abnormalBalances({ accounts, subAccounts = [], period, journals }) {
  const out = [];
  for (const r of trialBalance({ accounts, subAccounts, period, journals }).rows) {
    if (r.subs.length) {
      for (const s of r.subs) if (s.closing < 0) out.push({ account: r.account, subAccount: s.subAccount || null, closing: s.closing });
    } else if (r.closing < 0) out.push({ account: r.account, subAccount: null, closing: r.closing });
  }
  return out;
}

/** 決算までに精算する科目（仮払金・仮受金）の期末残高 */
export function suspenseBalances({ accounts, subAccounts = [], period, journals }) {
  return trialBalance({ accounts, subAccounts, period, journals })
    .rows.filter((r) => ['suspense_paid', 'suspense_received'].includes(r.account.hint) && r.closing !== 0)
    .map((r) => ({ account: r.account, closing: r.closing }));
}

/** 今日より後の日付の仕訳 */
export function futureJournals(journals, today) {
  return journals.filter((j) => j.date > today).sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 消耗品費・事務用品費のテンプレートのコード（科目名は変えられるので、テンプレートの科目をコードで見分ける） */
export const CONSUMABLE_CODES = { corporation: ['613', '614'], individual: ['609'] };

/**
 * 1つ10万円以上かもしれない消耗品の経費（固定資産として登録が要るかもしれないもの）
 *   取得価額10万円以上の減価償却資産は、全額をその年の経費にできない（一括償却資産・少額減価償却資産の特例・通常の償却）。
 *   国税庁 No.5403・No.2100。消耗品費・事務用品費（初期設定のテンプレートの科目。コードで見分ける）の借方の明細で、10万円以上のものを出す。
 *   1つ10万円未満のものをまとめて買った明細もあるので、誤りと決めつけずに確かめてもらう
 * @returns {Array<{ journal, line, account }>} 日付の順
 */
export function assetLikeExpenses({ accounts, period, journals, entityType, threshold = 100000 }) {
  const codes = CONSUMABLE_CODES[entityType] || [];
  const targets = new Map(accounts.filter((a) => a.template && codes.includes(a.code) && a.group === 'sga').map((a) => [a.id, a]));
  const out = [];
  for (const j of journals) {
    if (j.date < period.startDate || j.date > period.endDate) continue;
    for (const l of j.lines) if (l.side === 'debit' && l.amount >= threshold && targets.has(l.accountId)) out.push({ journal: j, line: l, account: targets.get(l.accountId) });
  }
  return out.sort((a, b) => (a.journal.date < b.journal.date ? -1 : a.journal.date > b.journal.date ? 1 : (a.journal.no ?? 0) - (b.journal.no ?? 0)));
}
