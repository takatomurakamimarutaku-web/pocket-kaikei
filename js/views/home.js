// ホーム：当期の概要（売上・利益・資金）、今月の動き、やること、最近の仕訳、よく使う操作
import { h, put, charaSay } from '../ui.js';
import { formatYen } from '../money.js';
import { formatPeriod, todayString, addDays } from '../period.js';
import { buildStatements, closingRows } from '../statements.js';
import { monthlyIncome } from '../monthly.js';
import { shouldRemindBackup } from '../backup.js';
import { currentInstallState } from '../install.js';
import { ENTITY_LABELS, TAX_STATUS_LABELS } from '../models.js';
import { openingDiff } from '../ledger.js';
import { taxChecks } from '../tax-reports.js';
import { findInventoryJournals } from '../closing.js';
import { findDepreciationJournals } from '../depreciation.js';
import { icon } from '../icons.js';
import { PARTY_KINDS, partyBalances } from '../receivables.js';
import { periodContext, closedNotice } from './period-common.js';
import { journalLabel } from '../journal.js';

const slash = (d) => d.replaceAll('-', '/');
const dayMs = 86400000;

export async function render({ app, outlet }) {
  const data = await app.load();
  const { settings, period, accounts, subAccounts, journals, accountById } = data;
  const individual = settings.entityType === 'individual';
  const { pl } = buildStatements({ entityType: settings.entityType, accounts, period, journals });
  const rows = closingRows({ accounts, period, journals });
  const cash = rows.filter((r) => r.account.role === 'cash' || r.account.role === 'deposit').reduce((s, r) => s + r.closing, 0);
  const sales = pl.items.find((i) => i.type === 'group' && i.lines.some((l) => l.account.group === 'sales'))?.total ?? 0;
  const lastBackupAt = await app.db.getMeta('lastBackupAt');
  const latest = journals.reduce((m, j) => (j.updatedAt > m ? j.updatedAt : m), '');
  const remind = shouldRemindBackup({ lastBackupAt, latestJournalUpdatedAt: latest || null });
  const install = currentInstallState();
  const today = todayString();
  const diff = individual ? 0 : openingDiff(period, accounts);
  const pctx = await periodContext(app, data);

  // 今月（期間外なら期間の最後の月）と前月の損益
  const monthly = journals.length ? monthlyIncome({ entityType: settings.entityType, accounts, period, journals }) : null;
  const cur = monthly ? Math.max(0, monthly.months.indexOf(today.slice(0, 7)) >= 0 ? monthly.months.indexOf(today.slice(0, 7)) : today > period.endDate ? monthly.months.length - 1 : 0) : 0;
  const monthLabel = monthly ? `${Number(monthly.months[cur].slice(5))}月` : '';

  // 期間の経過
  const total = (new Date(period.endDate) - new Date(period.startDate)) / dayMs + 1;
  const passed = Math.min(total, Math.max(0, (new Date(today) - new Date(period.startDate)) / dayMs + 1));
  const progress = Math.round((passed / total) * 100);

  // やること
  const todos = [];
  if (remind) todos.push({ href: '#/backup', title: 'バックアップを書き出す', sub: lastBackupAt ? `前回 ${slash(lastBackupAt.slice(0, 10))}` : 'まだ一度も書き出していません', level: 'warn' });
  if (diff) todos.push({ href: '#/opening', title: '期首残高を直す', sub: `借方と貸方の差額 ${formatYen(Math.abs(diff))}円`, level: 'warn' });
  if (settings.taxStatus === 'taxable' && journals.length) {
    const warn = taxChecks({ journals, accounts }).filter((x) => x.level === 'warn').length;
    if (warn) todos.push({ href: '#/reports/tax?view=check', title: '税区分を確認する', sub: `誤りの可能性がある明細 ${warn}件`, level: 'warn' });
  }
  if (!period.closed && today >= addDays(period.endDate, -45)) {
    const inv = findInventoryJournals(journals, accounts).length;
    const dep = findDepreciationJournals(journals).length;
    if (!inv || !dep) todos.push({ href: '#/closing', title: '決算整理をする', sub: `期末 ${slash(period.endDate)}。${[!inv ? '棚卸' : '', !dep ? '減価償却' : ''].filter(Boolean).join('・')}の仕訳が未登録`, level: today > period.endDate ? 'warn' : 'info' });
  }

  // 入金予定日・支払予定日を過ぎた売掛金・買掛金（支払条件を設定した取引先だけ）
  if (!period.closed && today >= period.startDate && today <= period.endDate) {
    for (const kind of ['receivable', 'payable']) {
      const k = PARTY_KINDS[kind];
      const r = partyBalances(kind, { accounts, subAccounts, journals, period, asOf: today });
      const late = r.parties.filter((p) => p.overdue > 0);
      if (late.length) todos.push({ href: `#/receivables?kind=${kind}`, title: `${k.due}を過ぎた${k.label}を確かめる`, sub: `${late.map((p) => p.name).slice(0, 3).join('・')}${late.length > 3 ? ' ほか' : ''}　${formatYen(r.totals.overdue)}円`, level: 'warn' });
    }
  }

  // 最近の仕訳（更新の新しい順に5件）
  const recent = [...journals].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 5);
  const nameOf = (j, side) => {
    const ls = j.lines.filter((l) => l.side === side);
    const first = accountById.get(ls[0]?.accountId)?.name ?? '';
    return ls.length > 1 ? `${first} ほか` : first;
  };

  put(
    outlet,
    install === 'ios-browser'
      ? h(
          'div',
          { class: 'notice' },
          h('strong', { text: 'ホーム画面に追加して使ってください' }),
          h('span', { text: '共有ボタン →「ホーム画面に追加」。Safari で開いた場合とホーム画面のアプリでは、データの保存場所が別になります。' }),
        )
      : null,
    closedNotice(period),
    pctx.next
      ? h('div', { class: 'notice' }, h('span', { text: `過去の会計期間（${formatPeriod(period)}）を表示しています。` }), h('a', { href: '#/periods', class: 'link', text: '会計期間を切り替える' }))
      : today > period.endDate
        ? h('div', { class: 'notice' }, h('span', { text: '会計期間が終わりました。決算整理をして、次の期間へ繰り越してください。' }), h('a', { href: '#/closing', class: 'link', text: '決算・繰越へ' }))
        : null,
    pctx.stale
      ? h('div', { class: 'notice' }, h('span', { text: '前期の帳簿が繰越の後に変更されています。期首残高を更新してください。' }), h('a', { href: '#/periods', class: 'link', text: '会計期間へ' }))
      : null,
    // 事業者と会計期間
    h(
      'section',
      { class: 'hero' },
      h(
        'div',
        { class: 'hero-top' },
        h('h2', { class: 'hero-name', text: settings.businessName }),
        // 弥生会計の事業所データのように、ほかの事業所（会社）へ切り替える
        h('a', { href: '#/books', class: 'hero-switch', 'aria-label': '事業所の切替' }, icon('books'), h('span', { text: '切替' })),
        h('a', { href: '#/settings', class: 'hero-edit', 'aria-label': '事業者の設定' }, icon('settings')),
      ),
      h('div', { class: 'hero-tags' }, h('span', { class: 'tag', text: individual ? '個人事業主' : '法人' }), h('span', { class: 'tag', text: TAX_STATUS_LABELS[settings.taxStatus] }), period.closed ? h('span', { class: 'tag', text: '締め済み' }) : null),
      h(
        'div',
        { class: 'hero-period' },
        h('div', { class: 'hero-period-head' }, h('span', { text: `会計期間 ${formatPeriod(period)}` }), h('span', { class: 'num', text: `${progress}%` })),
        h('div', { class: 'progress', role: 'progressbar', 'aria-label': '会計期間の経過', 'aria-valuenow': String(progress), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('span', { style: `width:${progress}%` })),
      ),
    ),
    // 当期の数字
    h(
      'section',
      { class: 'kpi-grid' },
      kpi(individual ? '売上(収入)金額' : '売上高', sales, monthly ? { label: monthLabel, value: monthly.sales[cur], prev: cur > 0 ? monthly.sales[cur - 1] : null } : null, '#/reports/pl'),
      kpi(individual ? '所得金額（控除前）' : '当期純利益', pl.netIncome, monthly ? { label: monthLabel, value: monthly.netIncome[cur], prev: cur > 0 ? monthly.netIncome[cur - 1] : null } : null, '#/reports/pl'),
      kpi('現金・預金', cash, null, '#/cashbook'),
      h('a', { class: 'kpi', href: '#/journals' }, h('span', { class: 'kpi-label', text: '仕訳' }), h('span', { class: 'kpi-value num', text: `${journals.length}件` }), h('span', { class: 'kpi-sub', text: `今月 ${journals.filter((j) => j.date.startsWith(today.slice(0, 7))).length}件` })),
    ),
    // 仕訳がまだ無いときの案内
    journals.length ? null : charaSay('kai-cheer', '最初の取引を入力してみよう！下の「取引を入力」から始められるよ。', { who: 'カイ' }),
    // よく使う操作
    h(
      'nav',
      { class: 'quick-actions', 'aria-label': 'よく使う操作' },
      action('#/entry', '取引を入力', 'expense', 'primary'),
      action('#/journal/new', '振替伝票', 'journal'),
      action('#/cashbook', '出納帳', 'cashbook'),
      action('#/reports', '帳票', 'chart'),
    ),
    todos.length
      ? h(
          'section',
          { class: 'card-section' },
          h('h2', { class: 'card-title', text: 'やること' }),
          charaSay(todos.some((t) => t.level === 'warn') ? 'keily-caution' : 'keily-normal', `やることが${todos.length}件あります。順番に片づけていきましょう。`, { who: 'ケイリー' }),
          h(
            'ul',
            { class: 'menu-group todo-list' },
            todos.map((t) =>
              h('li', {}, h('a', { class: `menu-row todo ${t.level}`, href: t.href }, h('span', { class: `menu-icon tone-${t.level === 'warn' ? 'close' : 'report'}` }, icon(t.level === 'warn' ? 'alert' : 'closing')), h('span', { class: 'menu-text' }, h('span', { class: 'menu-label', text: t.title }), h('span', { class: 'menu-sub', text: t.sub })))),
            ),
          ),
        )
      : null,
    recent.length
      ? h(
          'section',
          { class: 'card-section' },
          h('div', { class: 'card-title-row' }, h('h2', { class: 'card-title', text: '最近の仕訳' }), h('a', { href: '#/journals', class: 'link small', text: 'すべて見る' })),
          h(
            'ul',
            { class: 'menu-group recent-list' },
            recent.map((j) => {
              const amount = j.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0);
              const memo = j.lines.find((l) => l.memo)?.memo ?? '';
              return h(
                'li',
                {},
                h(
                  'a',
                  { class: 'recent-row', href: `#/journal/${encodeURIComponent(j.id)}/edit` },
                  h('span', { class: 'recent-date' }, h('span', { text: `${Number(j.date.slice(5, 7))}/${Number(j.date.slice(8))}` }), h('span', { class: 'recent-no', text: journalLabel(j) })),
                  h('span', { class: 'recent-main' }, h('span', { class: 'recent-acc', text: `${nameOf(j, 'debit')} / ${nameOf(j, 'credit')}` }), memo ? h('span', { class: 'recent-memo', text: memo }) : null),
                  h('span', { class: 'recent-amt num', text: formatYen(amount) }),
                ),
              );
            }),
          ),
        )
      : null,
    journals.length === 0 && !pctx.prev
      ? h(
          'section',
          { class: 'card-section' },
          h('h2', { class: 'card-title', text: 'はじめに' }),
          h(
            'div',
            { class: 'panel' },
            h('ol', { class: 'plain-list' }, [
              h('li', {}, h('a', { href: '#/opening', text: '期首残高' }), 'を入力する（開業したばかりなら不要）'),
              h('li', {}, h('a', { href: '#/accounts', text: '勘定科目' }), 'に銀行口座などの補助科目を追加する'),
              h('li', {}, h('a', { href: '#/entry', text: '取引を入力' }), 'する（かんたん入力・振替伝票）'),
              h('li', {}, '定期的に', h('a', { href: '#/backup', text: 'バックアップ' }), 'する'),
            ]),
          ),
        )
      : null,
    h('p', { class: 'muted small center home-foot', text: `${ENTITY_LABELS[settings.entityType]}${settings.entityType === 'individual' ? (settings.filing === 'white' ? '（白色申告）' : '（青色申告）') : ''}・データはこの端末の中だけに保存されています` }),
  );
}

/** 指標のカード。month：今月の値と前月比 */
function kpi(label, n, month, href) {
  let sub = null;
  if (month) {
    const diff = month.prev === null ? null : month.value - month.prev;
    sub = h(
      'span',
      { class: 'kpi-sub' },
      `${month.label} ${formatYen(month.value)}`,
      diff === null || diff === 0 ? null : h('span', { class: `kpi-trend ${diff > 0 ? 'up' : 'down'}`, text: `${diff > 0 ? '▲' : '▼'}${formatYen(Math.abs(diff)).replace('△', '')}` }),
    );
  }
  return h('a', { class: 'kpi', href }, h('span', { class: 'kpi-label', text: label }), h('span', { class: `kpi-value num ${n < 0 ? 'neg' : ''}`, text: `${formatYen(n)}円` }), sub);
}

function action(href, label, name, variant = '') {
  return h('a', { class: `qa ${variant}`, href }, h('span', { class: 'qa-icon' }, icon(name)), h('span', { class: 'qa-label', text: label }));
}
