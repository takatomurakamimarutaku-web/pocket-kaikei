// テスト用のデータ作成
import { templateAccounts } from '../js/accounts.js';
import { createAccount, createPeriod, createJournal } from '../js/models.js';

/** テンプレートから科目を作り、名前で引ける索引を付ける */
export function makeBook(entityType, { startDate = '2026-01-01', endDate = '2026-12-31', subs = [] } = {}) {
  const accounts = templateAccounts(entityType).map((a) => createAccount(a));
  const byName = Object.fromEntries(accounts.map((a) => [a.name, a]));
  const subAccounts = subs.map(([accountName, name], i) => ({
    id: `sub-${i}`,
    accountId: byName[accountName].id,
    name,
    active: true,
    sortOrder: i,
    createdAt: '',
    updatedAt: '',
  }));
  const period = createPeriod({ startDate, endDate });
  let no = 0;
  /** j('2026-01-05', [['現金', 1000]], [['売上高', 1000]], '摘要') 。行は [科目名, 金額, 税区分?, 補助名?] */
  const j = (date, debits, credits, memo = '') =>
    createJournal({
      periodId: period.id,
      no: ++no,
      date,
      lines: [
        ...debits.map((d) => line('debit', d, memo)),
        ...credits.map((c) => line('credit', c, memo)),
      ],
    });
  const line = (side, [name, amount, taxCategory, subName], memo) => ({
    side,
    accountId: byName[name].id,
    subAccountId: subName ? subAccounts.find((s) => s.name === subName).id : null,
    amount,
    taxCategory: taxCategory ?? byName[name].defaultTaxCategory,
    memo,
  });
  const opening = (list) => {
    period.openingBalances = list.map(([name, amount, subName]) => ({
      accountId: byName[name].id,
      subAccountId: subName ? subAccounts.find((s) => s.name === subName).id : null,
      amount,
    }));
  };
  return { accounts, byName, subAccounts, period, j, opening };
}
