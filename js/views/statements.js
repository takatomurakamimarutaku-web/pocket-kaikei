// 損益計算書・貸借対照表（個人/法人で様式を切り替える）
import { h, put } from '../ui.js';
import { buildStatements } from '../statements.js';
import { openingDiff } from '../ledger.js';
import { formatPeriod } from '../period.js';
import { formatYen } from '../money.js';
import { zeroToggle, openingWarning, statementRows } from './report-common.js';

export async function render({ app, outlet, route }) {
  const { settings, period, accounts, journals } = await app.load();
  const individual = settings.entityType === 'individual';
  const { pl, bs } = buildStatements({ entityType: settings.entityType, accounts, period, journals });
  let showZero = false;
  const body = h('div');
  const zero = zeroToggle((v) => ((showZero = v), paint()));

  const itemRows = (items) => statementRows(items, showZero);
  const table = (caption, items) => h('div', { class: 'table-wrap' }, h('table', { class: 'report statement' }, h('caption', { text: caption }), h('tbody', {}, itemRows(items))));

  function paint() {
    if (route.kind === 'pl') {
      put(body, table(individual ? '損益計算書（青色申告決算書の並び）' : '損益計算書', pl.items));
      return;
    }
    put(body, 
      h(
        'p',
        { class: `check-line ${bs.balanced ? 'ok' : 'ng'}` },
        bs.balanced
          ? `資産合計 ${formatYen(bs.totalAssets)}円 ＝ ${individual ? '負債・資本合計' : '負債・純資産合計'}`
          : `資産合計と${individual ? '負債・資本合計' : '負債・純資産合計'}が一致しません（差額 ${formatYen(bs.totalAssets - bs.totalLiabilitiesAndEquity)}円）`,
      ),
      table('資産の部', bs.assets),
      table(individual ? '負債・資本の部' : '負債・純資産の部', bs.liabilities),
    );
  }

  put(outlet, 
    h('p', { class: 'muted small', text: `${settings.businessName}　${route.kind === 'pl' ? formatPeriod(period) : `${period.endDate.replaceAll('-', '/')} 現在`}` }),
    openingWarning(individual ? 0 : openingDiff(period, accounts)),
    zero.el,
    body,
    individual && route.kind === 'pl' ? h('p', { class: 'muted small', text: '青色申告特別控除額と所得金額の計算は、今後の版で青色申告決算書の様式とあわせて対応します。' }) : null,
    h('p', { class: 'muted small', text: '決算整理（棚卸・減価償却など）は、第1弾では仕訳で入力してください。' }),
  );
  paint();
}
