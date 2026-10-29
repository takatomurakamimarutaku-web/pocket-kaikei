// 家事按分（個人）：事業と家事の両方に使う費用のうち、家事の分を決算整理で事業主貸へ振り替える（純粋関数）
//
// 所得税：家事関連費のうち必要経費になるのは、業務の遂行上直接必要であったことが明らかに区分できる金額に限られる
//   国税庁 タックスアンサー No.2210 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2210.htm
// 消費税：家事消費・家事使用の部分は課税仕入れに当たらない。使用率・使用面積の割合など合理的な基準で按分する
//   消費税法基本通達 11-1-4 https://www.nta.go.jp/law/tsutatsu/kihon/shohi/11/01.htm
//   → 振替の行は元の行と同じ税区分を付け、貸方にして課税仕入れから差し引く
import { findByRole } from './accounts.js';

export const HOUSEHOLD_SOURCE = 'household';

/** 按分の元にしない仕訳（家事按分そのもの、事業割合を台帳で反映済みの減価償却） */
const EXCLUDED_SOURCES = [HOUSEHOLD_SOURCE, 'depreciation'];

/** 事業割合（%）として正しいか。1〜99 の整数（100% は按分しない、0% は全額が家事） */
export function isValidRatio(r) {
  return Number.isInteger(r) && r >= 1 && r <= 99;
}

/** 事業割合を設定できる科目（個人の経費。減価償却費は台帳の事業専用割合で按分するので除く） */
export function householdEligible(account) {
  return account.group === 'sga' && account.hint !== 'depreciation' && account.active !== false;
}

/** 登録済みの家事按分の仕訳 */
export function findHouseholdJournals(journals) {
  return journals.filter((j) => j.source === HOUSEHOLD_SOURCE);
}

/** 科目・補助科目・税区分ごとの期間の借方−貸方（家事按分と減価償却の仕訳を除く） */
function netByKey(targets, journals, period) {
  const ids = new Set(targets.map((a) => a.id));
  const byKey = new Map();
  for (const j of journals) {
    if (EXCLUDED_SOURCES.includes(j.source) || j.date < period.startDate || j.date > period.endDate) continue;
    for (const l of j.lines) {
      if (!ids.has(l.accountId)) continue;
      const key = `${l.accountId}|${l.subAccountId || ''}|${l.taxCategory || 'none'}`;
      byKey.set(key, (byKey.get(key) || 0) + (l.side === 'debit' ? l.amount : -l.amount));
    }
  }
  return byKey;
}

/** 按分の元になる金額（科目ごと。借方−貸方がプラスの組合せだけ足す） */
export function householdBases({ accounts, journals, period }) {
  const targets = accounts.filter(householdEligible);
  const out = new Map(targets.map((a) => [a.id, 0]));
  for (const [key, net] of netByKey(targets, journals, period)) {
    const id = key.split('|')[0];
    if (net > 0) out.set(id, out.get(id) + net);
  }
  return out;
}

/** 事業分（1円未満切り捨て）と家事分 */
export function splitByRatio(amount, ratio) {
  const business = Math.floor((amount * ratio) / 100);
  return { business, private: amount - business };
}

/**
 * 家事按分の計算と仕訳の明細
 * 科目・補助科目・税区分ごとに、期間の借方−貸方（家事按分と減価償却の仕訳を除く）を事業割合で分ける
 * @param {{ accounts, journals, period, memo? }} p 事業割合は科目の businessRatio（%）
 * @returns {{ rows: Array<{ account, ratio, amount, business, private }>, lines: Array, total: number, drawings: object|null }}
 */
export function householdPlan({ accounts, journals, period, memo = '決算整理 家事按分' }) {
  const targets = accounts.filter((a) => householdEligible(a) && isValidRatio(a.businessRatio));
  const drawings = findByRole(accounts, 'owner_drawings');
  const byKey = netByKey(targets, journals, period);
  const rows = [];
  const lines = [];
  for (const account of targets) {
    const ratio = account.businessRatio;
    let amount = 0;
    let priv = 0;
    for (const [key, net] of byKey) {
      const [accountId, subAccountId, taxCategory] = key.split('|');
      if (accountId !== account.id || net <= 0) continue;
      const s = splitByRatio(net, ratio);
      amount += net;
      priv += s.private;
      if (s.private > 0) lines.push({ side: 'credit', accountId, subAccountId: subAccountId || null, amount: s.private, taxCategory, memo: `${memo}（事業割合${ratio}%）` });
    }
    rows.push({ account, ratio, amount, business: amount - priv, private: priv });
  }
  const total = rows.reduce((s, r) => s + r.private, 0);
  if (total > 0 && drawings) lines.unshift({ side: 'debit', accountId: drawings.id, subAccountId: null, amount: total, taxCategory: 'none', memo });
  return { rows, lines: total > 0 && drawings ? lines : [], total, drawings };
}
