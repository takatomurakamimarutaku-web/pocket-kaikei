// 総勘定元帳（補助科目を選ぶと補助元帳。「すべての科目」で全科目を続けて表示・印刷・CSV 出力）
import { h, put, amountCell, emptyState, saveFile } from '../ui.js';
import { generalLedger, generalLedgers, carriedLabel } from '../ledger.js';
import { ledgerCsv, csvFileName } from '../csv.js';
import { compareAccounts, groupLabel, GROUPS } from '../accounts.js';
import { monthRangePicker } from './report-common.js';

export async function render({ app, outlet, query }) {
  const { settings, period, accounts, subAccounts, journals } = await app.load();
  const sorted = [...accounts].sort(compareAccounts);
  const used = new Set(journals.flatMap((j) => j.lines.map((l) => l.accountId)));
  for (const ob of period.openingBalances || []) used.add(ob.accountId);
  const ALL = 'all';
  let accountId = query.account === ALL ? ALL : accounts.some((a) => a.id === query.account) ? query.account : (sorted.find((a) => used.has(a.id)) || sorted[0]).id;
  let subId = subAccounts.some((s) => s.id === query.sub && s.accountId === accountId) ? query.sub : '';

  const accSelect = h(
    'select',
    { 'aria-label': '勘定科目', onchange: (e) => ((accountId = e.target.value), (subId = ''), paintSubs(), update()) },
    h('option', { value: ALL, text: 'すべての科目（取引・残高のある科目）', selected: accountId === ALL }),
    GROUPS.filter((g) => sorted.some((a) => a.group === g.id)).map((g) =>
      h(
        'optgroup',
        { label: groupLabel(g.id, settings.entityType) },
        sorted.filter((a) => a.group === g.id).map((a) => h('option', { value: a.id, text: `${a.code} ${a.name}${used.has(a.id) ? '' : '（取引なし）'}`, selected: a.id === accountId })),
      ),
    ),
  );
  const subSelect = h('select', { 'aria-label': '補助科目', onchange: (e) => ((subId = e.target.value), update()) });
  function paintSubs() {
    const subs = accountId === ALL ? [] : subAccounts.filter((s) => s.accountId === accountId);
    subSelect.hidden = !subs.length;
    put(subSelect, h('option', { value: '', text: 'すべての補助科目' }), ...subs.map((s) => h('option', { value: s.id, text: s.name, selected: s.id === subId })));
  }
  const extra = () => ({ account: accountId, ...(subId ? { sub: subId } : {}) });
  const picker = monthRangePicker({ period, query, path: '/reports/ledger', onChange: paint, extra });
  function update() {
    const r = picker.range();
    history.replaceState(history.state, '', `#/reports/ledger?${new URLSearchParams({ ...extra(), from: r.fromMonth, to: r.toMonth })}`);
    paint();
  }
  const body = h('div');

  function paint() {
    const { from, to } = picker.range();
    const ctx = { accounts, subAccounts, period, journals, from, to };
    const ledgers = accountId === ALL ? generalLedgers(ctx) : [generalLedger({ ...ctx, accountId, subAccountId: subId || null })];
    const subName = subId ? subAccounts.find((s) => s.id === subId)?.name ?? '' : '';
    const csv = () => saveFile(new Blob([ledgerCsv(ledgers, { carried: carriedLabel(period, from), subName })], { type: 'text/csv' }), csvFileName('ledger'));
    put(
      body,
      ledgers.map((lg) => ledgerTable(lg, from, accountId === ALL)),
      accountId === ALL && !ledgers.length ? emptyState('この期間の取引はありません', null, { face: null }) : null,
      h('div', { class: 'report-tools no-print' }, h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: csv })),
    );
  }

  function ledgerTable(lg, from, many) {
    const side = lg.account.normalSide === 'debit' ? '借方残' : '貸方残';
    return h(
      'section',
      { class: 'lg-section' },
      many ? h('h2', { class: 'section-title', text: `${lg.account.code} ${lg.account.name}` }) : null,
      h('p', { class: 'list-meta', text: `${many ? '' : `${lg.account.code} ${lg.account.name}・`}${side}・${lg.rows.length}件` }),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report ledger' },
          h('thead', {}, h('tr', {}, ['日付', '相手科目／摘要', '借方', '貸方', '残高'].map((t) => h('th', { scope: 'col', text: t })))),
          h(
            'tbody',
            {},
            h('tr', { class: 'carried' }, h('td'), h('td', { text: carriedLabel(period, from) }), h('td'), h('td'), amountCell('td', lg.carried)),
            lg.rows.map((r) =>
              h(
                'tr',
                {},
                h('td', { class: 'nowrap' }, h('a', { href: `#/journal/${encodeURIComponent(r.journal.id)}/edit`, text: r.date.slice(5).replace('-', '/') }), h('span', { class: 'lg-no', text: `No.${r.journal.no}` })),
                h('td', {}, h('span', { class: 'lg-counter', text: r.counterpart }), r.memo ? h('span', { class: 'lg-memo', text: r.memo }) : null),
                amountCell('td', r.debit, { blankZero: true }),
                amountCell('td', r.credit, { blankZero: true }),
                amountCell('td', r.balance),
              ),
            ),
          ),
          h('tfoot', {}, h('tr', {}, h('th', { colspan: 2, text: '期間計' }), amountCell('td', lg.debit), amountCell('td', lg.credit), amountCell('td', lg.closing))),
        ),
      ),
      lg.rows.length || many ? null : emptyState('この期間の取引はありません', null, { face: null }),
    );
  }
  paintSubs();
  put(outlet, h('div', { class: 'ledger-pick' }, accSelect, subSelect), picker.el, body);
  paint();
}
