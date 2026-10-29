// 会計期間の前後関係と、繰越後に前期が変わったかの確認（画面共通）
import { previousPeriod, nextPeriod, isOpeningStale, carryForwardBalances } from '../closing.js';

/**
 * @returns {Promise<{ periods, prev, next, stale: boolean, recompute: () => Promise }>}
 *   stale：期首残高が前期の期末残高と違う（繰越の後に前期の仕訳・期首残高を変えた）
 *   recompute：前期の期末残高で期首残高を上書きする
 */
export async function periodContext(app, { settings, period, accounts, subAccounts }) {
  const periods = await app.db.listPeriods();
  const prev = previousPeriod(periods, period);
  const next = nextPeriod(periods, period);
  let stale = false;
  let prevJournals = [];
  if (prev) {
    prevJournals = await app.db.listJournals(prev.id);
    stale = isOpeningStale({ entityType: settings.entityType, accounts, subAccounts, prevPeriod: prev, prevJournals, period });
  }
  const recompute = () => {
    const { balances } = carryForwardBalances({ entityType: settings.entityType, accounts, subAccounts, period: prev, journals: prevJournals });
    return app.db.saveOpeningBalances(period.id, balances);
  };
  return { periods, prev, next, stale, recompute };
}
