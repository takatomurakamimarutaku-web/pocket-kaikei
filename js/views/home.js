// ホーム：当期の概要・バックアップの催促・ホーム画面追加の案内
import { h, put } from '../ui.js';
import { formatYen } from '../money.js';
import { formatPeriod, todayString } from '../period.js';
import { buildStatements, closingRows } from '../statements.js';
import { shouldRemindBackup } from '../backup.js';
import { currentInstallState } from '../install.js';
import { ENTITY_LABELS, TAX_STATUS_LABELS } from '../models.js';
import { openingDiff } from '../ledger.js';
import { periodContext } from './period-common.js';

export async function render({ app, outlet }) {
  const data = await app.load();
  const { settings, period, accounts, journals } = data;
  const individual = settings.entityType === 'individual';
  const { pl } = buildStatements({ entityType: settings.entityType, accounts, period, journals });
  const rows = closingRows({ accounts, period, journals });
  const cash = rows.filter((r) => r.account.role === 'cash' || r.account.role === 'deposit').reduce((s, r) => s + r.closing, 0);
  const sales = pl.items.find((i) => i.type === 'group' && i.lines.some((l) => l.account.group === 'sales'))?.total ?? 0;
  const lastBackupAt = await app.db.getMeta('lastBackupAt');
  const latest = journals.reduce((m, j) => (j.updatedAt > m ? j.updatedAt : m), '');
  const remind = shouldRemindBackup({ lastBackupAt, latestJournalUpdatedAt: latest || null });
  const install = currentInstallState();
  const thisMonth = todayString().slice(0, 7);
  const monthCount = journals.filter((j) => j.date.startsWith(thisMonth)).length;
  const diff = individual ? 0 : openingDiff(period, accounts);
  const pctx = await periodContext(app, data);
  const today = todayString();

  put(outlet, 
    install === 'ios-browser'
      ? h(
          'div',
          { class: 'notice' },
          h('strong', { text: 'ホーム画面に追加して使ってください' }),
          h('span', { text: '共有ボタン →「ホーム画面に追加」。Safari で開いた場合とホーム画面のアプリでは、データの保存場所が別になります。' }),
        )
      : null,
    remind
      ? h(
          'div',
          { class: 'notice' },
          h('span', { text: lastBackupAt ? `前回のバックアップから日数が経っています（${lastBackupAt.slice(0, 10).replaceAll('-', '/')}）。` : 'まだバックアップがありません。データはこの端末の中だけに保存されています。' }),
          h('a', { href: '#/backup', class: 'link', text: 'バックアップする' }),
        )
      : null,
    pctx.next
      ? h('div', { class: 'notice' }, h('span', { text: `過去の会計期間（${formatPeriod(period)}）を表示しています。` }), h('a', { href: '#/periods', class: 'link', text: '会計期間を切り替える' }))
      : today > period.endDate
        ? h('div', { class: 'notice' }, h('span', { text: '会計期間が終わりました。決算整理をして、次の期間へ繰り越してください。' }), h('a', { href: '#/closing', class: 'link', text: '決算・繰越へ' }))
        : null,
    pctx.stale
      ? h('div', { class: 'notice' }, h('span', { text: '前期の帳簿が繰越の後に変更されています。期首残高を更新してください。' }), h('a', { href: '#/periods', class: 'link', text: '会計期間へ' }))
      : null,
    diff
      ? h('div', { class: 'notice' }, h('span', { text: `期首残高の借方と貸方が一致していません（差額 ${formatYen(Math.abs(diff))}円）。` }), h('a', { href: '#/opening', class: 'link', text: '期首残高を確認' }))
      : null,
    h(
      'section',
      { class: 'panel home-head' },
      h('h2', { class: 'home-name', text: settings.businessName }),
      h('p', { class: 'muted small', text: `${ENTITY_LABELS[settings.entityType]}・${TAX_STATUS_LABELS[settings.taxStatus]}` }),
      h('p', { class: 'muted small', text: `会計期間 ${formatPeriod(period)}` }),
    ),
    h(
      'section',
      { class: 'stat-grid' },
      stat(individual ? '売上(収入)金額' : '売上高', sales),
      stat(individual ? '所得金額（控除前）' : '当期純利益', pl.netIncome),
      stat('現金・預金', cash),
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: '今月の仕訳' }), h('span', { class: 'stat-value', text: `${monthCount}件` })),
    ),
    h(
      'div',
      { class: 'actions' },
      h('a', { href: '#/entry', class: 'btn btn-primary', text: '取引を入力する' }),
      h('a', { href: '#/cashbook', class: 'btn', text: '出納帳' }),
      h('a', { href: '#/journals', class: 'btn', text: '仕訳帳' }),
      h('a', { href: '#/reports/trial', class: 'btn', text: '試算表' }),
    ),
    journals.length === 0 && !pctx.prev
      ? h(
          'div',
          { class: 'panel' },
          h('h3', { class: 'section-title', text: 'はじめに' }),
          h('ol', { class: 'plain-list' }, [
            h('li', {}, h('a', { href: '#/opening', text: '期首残高' }), 'を入力する（開業したばかりなら不要）'),
            h('li', {}, h('a', { href: '#/accounts', text: '勘定科目' }), 'に銀行口座などの補助科目を追加する'),
            h('li', {}, h('a', { href: '#/entry', text: '取引を入力' }), 'する（かんたん入力・振替伝票）'),
            h('li', {}, '定期的に', h('a', { href: '#/backup', text: 'バックアップ' }), 'する'),
          ]),
        )
      : null,
  );
}

function stat(label, n) {
  return h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: label }), h('span', { class: `stat-value num ${n < 0 ? 'neg' : ''}`, text: `${formatYen(n)}円` }));
}
