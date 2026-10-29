// 決算整理・年度繰越（純粋関数）
//
// 繰越の考え方
// - 損益の科目は繰り越さない。貸借の科目の期末残高（補助科目ごと）を次の期間の期首残高にする
// - 法人：繰越利益剰余金に当期純利益を加える（貸借対照表の表示と同じ）
// - 個人：事業主貸・事業主借は「本年中に」支出・受け入れた金額なので期首は0。
//   元入金は期首と期末が同じ金額（国税庁「令和7年分 青色申告決算書（一般用）の書き方」6ページ
//   https://www.nta.go.jp/taxes/shiraberu/shinkoku/tebiki/2025/pdf/037.pdf ）なので、
//   次の期首の元入金＝期首の資産合計−負債合計（＝前期の元入金＋所得＋事業主借−事業主貸）。
//   元入金の計算は Repository.saveOpeningBalances / createNextPeriod の computeOwnerCapital で行う
import { findByRole, findByHint, isBsGroup } from './accounts.js';
import { trialBalance } from './ledger.js';
import { incomeStatement } from './statements.js';
import { addDays, individualPeriod, defaultCorporateEnd } from './period.js';

/** 次の会計期間の日付。個人は翌年の暦年、法人は前期末の翌日から12か月 */
export function nextPeriodDates(period, entityType) {
  if (entityType === 'individual') return individualPeriod(Number(period.startDate.slice(0, 4)) + 1);
  const startDate = addDays(period.endDate, 1);
  return { startDate, endDate: defaultCorporateEnd(startDate) };
}

/** 前の会計期間（終了日の翌日がこの期間の開始日のもの） */
export function previousPeriod(periods, period) {
  return periods.find((p) => addDays(p.endDate, 1) === period.startDate) || null;
}

/** 次の会計期間 */
export function nextPeriod(periods, period) {
  return periods.find((p) => p.startDate === addDays(period.endDate, 1)) || null;
}

/**
 * 次の期間の期首残高（残高側の金額。0 は含めない）
 * @returns {{ balances: Array<{accountId, subAccountId, amount}>, netIncome: number }}
 */
export function carryForwardBalances({ entityType, accounts, subAccounts = [], period, journals }) {
  const tb = trialBalance({ accounts, subAccounts, period, journals });
  const netIncome = incomeStatement(entityType, tb.rows).netIncome;
  const skipRoles = entityType === 'individual' ? ['owner_drawings', 'owner_borrowings', 'owner_capital'] : [];
  const retained = entityType === 'corporation' ? findByRole(accounts, 'retained_earnings') : null;
  const balances = [];
  for (const r of tb.rows) {
    if (!isBsGroup(r.account.group) || skipRoles.includes(r.account.role)) continue;
    const parts = r.subs.length ? r.subs.map((s) => ({ subAccountId: s.subAccount?.id || null, amount: s.closing })) : [{ subAccountId: null, amount: r.closing }];
    for (const p of parts) {
      let amount = p.amount;
      if (retained && r.account.id === retained.id && !p.subAccountId) amount += netIncome;
      if (amount) balances.push({ accountId: r.account.id, subAccountId: p.subAccountId, amount });
    }
  }
  // 繰越利益剰余金の残高が0で当期純利益だけある場合
  if (retained && netIncome && !balances.some((b) => b.accountId === retained.id && !b.subAccountId)) {
    balances.push({ accountId: retained.id, subAccountId: null, amount: netIncome });
  }
  return { balances, netIncome };
}

/** 期首残高の並びに依らない比較用のキー */
export function balancesKey(balances) {
  return balances
    .filter((b) => b.amount)
    .map((b) => `${b.accountId}|${b.subAccountId || ''}|${b.amount}`)
    .sort()
    .join(',');
}

/**
 * 期首残高が前期の期末から計算した値と違うか（繰越の後に前期の仕訳を直した場合など）
 * 個人の元入金は保存時に計算するので比較から外す
 */
export function isOpeningStale({ entityType, accounts, subAccounts, prevPeriod, prevJournals, period }) {
  const { balances } = carryForwardBalances({ entityType, accounts, subAccounts, period: prevPeriod, journals: prevJournals });
  const capital = entityType === 'individual' ? findByRole(accounts, 'owner_capital') : null;
  const current = (period.openingBalances || []).filter((b) => !capital || b.accountId !== capital.id);
  return balancesKey(balances) !== balancesKey(current);
}

/** 期末棚卸の科目（期首商品棚卸高・期末商品棚卸高・商品）。どれか無ければ null */
export function inventoryAccounts(accounts) {
  const opening = findByRole(accounts, 'opening_inventory');
  const closing = findByRole(accounts, 'closing_inventory');
  const goods = findByHint(accounts, 'inventory');
  return opening && closing && goods ? { opening, closing, goods } : null;
}

/** この期間に棚卸の仕訳（期首・期末商品棚卸高を使う仕訳）が既にあるか */
export function findInventoryJournals(journals, accounts) {
  const inv = inventoryAccounts(accounts);
  if (!inv) return [];
  const ids = new Set([inv.opening.id, inv.closing.id]);
  return journals.filter((j) => j.lines.some((l) => ids.has(l.accountId)));
}

/**
 * 期末棚卸の決算整理仕訳（三分法）の明細
 *   期首商品棚卸高 / 商品  … 期首の在庫（商品の残高）を売上原価へ
 *   商品 / 期末商品棚卸高  … 期末の在庫を商品へ
 * @param {number} goodsBalance 決算整理前の商品の残高（＝期首の在庫）
 * @param {number} closingAmount 期末の棚卸高（0 以上の整数）
 */
export function inventoryLines({ accounts, goodsBalance, closingAmount, memo = '決算整理 棚卸' }) {
  const inv = inventoryAccounts(accounts);
  if (!inv) return [];
  const line = (side, account, amount) => ({ side, accountId: account.id, subAccountId: null, amount, taxCategory: 'none', memo });
  const lines = [];
  if (goodsBalance > 0) lines.push(line('debit', inv.opening, goodsBalance), line('credit', inv.goods, goodsBalance));
  if (closingAmount > 0) lines.push(line('debit', inv.goods, closingAmount), line('credit', inv.closing, closingAmount));
  return lines;
}
