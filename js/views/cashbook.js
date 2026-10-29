// 現金出納帳・預金出納帳：口座（補助科目）ごとの入金・出金・残高。ここから入金・出金を記録できる
import { h, put, amountCell, emptyState, saveFile } from '../ui.js';
import { ledgerCsv, csvFileName } from '../csv.js';
import { generalLedger, carriedLabel, firstNegativeDate } from '../ledger.js';
import { compareAccounts } from '../accounts.js';
import { isCashAccount } from '../quick.js';
import { monthsInPeriod, monthRange, todayString } from '../period.js';
import { formatYen } from '../money.js';

export async function render({ app, outlet, query }) {
  const { period, accounts, subAccounts, journals } = await app.load();
  const used = new Set(journals.flatMap((j) => j.lines.map((l) => l.accountId)));
  for (const ob of period.openingBalances || []) if (ob.amount) used.add(ob.accountId);
  // 有効な口座と、無効でも当期に動きのある口座
  const cashAccounts = accounts.filter((a) => isCashAccount(a) && (a.active || used.has(a.id))).sort(compareAccounts);
  const options = [];
  for (const a of cashAccounts) {
    options.push({ key: a.id, accountId: a.id, subId: '', label: a.name });
    for (const s of subAccounts.filter((x) => x.accountId === a.id).sort((x, y) => (x.sortOrder ?? 0) - (y.sortOrder ?? 0))) {
      options.push({ key: `${a.id}|${s.id}`, accountId: a.id, subId: s.id, label: `${a.name}／${s.name}`, indent: true });
    }
  }
  const initial = options.find((o) => o.accountId === query.account && o.subId === (query.sub || '')) || options[0];
  let accountId = initial.accountId;
  let subId = initial.subId;
  const months = monthsInPeriod(period);
  const today = todayString().slice(0, 7);
  let month = query.month === 'all' ? 'all' : months.includes(query.month) ? query.month : months.includes(today) ? today : months[0];

  const accSelect = h(
    'select',
    {
      'aria-label': '口座',
      onchange: (e) => {
        const o = options.find((x) => x.key === e.target.value);
        accountId = o.accountId;
        subId = o.subId;
        update();
      },
    },
    options.map((o) => h('option', { value: o.key, text: o.indent ? `　${o.label}` : o.label, selected: o === initial })),
  );
  const monthLabel = h('span', { class: 'month-label' });
  const prev = h('button', { type: 'button', class: 'btn btn-small', 'aria-label': '前の月', text: '‹', onclick: () => move(-1) });
  const next = h('button', { type: 'button', class: 'btn btn-small', 'aria-label': '次の月', text: '›', onclick: () => move(1) });
  const allBtn = h('button', { type: 'button', class: 'seg', role: 'switch', text: '全期間', onclick: () => ((month = month === 'all' ? (months.includes(today) ? today : months[0]) : 'all'), update()) });
  const body = h('div');

  function move(d) {
    const n = months[months.indexOf(month) + d];
    if (n) {
      month = n;
      update();
    }
  }
  const params = () => new URLSearchParams({ account: accountId, ...(subId ? { sub: subId } : {}) });
  function update() {
    const p = params();
    p.set('month', month);
    history.replaceState(history.state, '', `#/cashbook?${p}`);
    paint();
  }

  const open = (r) => app.navigate(`#/journal/${encodeURIComponent(r.journal.id)}/edit`);

  function paint() {
    const isAll = month === 'all';
    monthLabel.textContent = isAll ? '全期間' : `${month.slice(0, 4)}年${Number(month.slice(5))}月`;
    prev.disabled = isAll || months.indexOf(month) <= 0;
    next.disabled = isAll || months.indexOf(month) >= months.length - 1;
    allBtn.setAttribute('aria-checked', String(isAll));
    const { from, to } = isAll ? { from: period.startDate, to: period.endDate } : monthRange(period, month, month);
    const ctx = { accountId, subAccountId: subId || null, accounts, subAccounts, period, journals };
    const lg = generalLedger({ ...ctx, from, to });
    const negative = lg.account.role === 'cash' ? firstNegativeDate(ctx) : null;
    const add = (kind, label, cls) => h('a', { class: `btn ${cls}`, href: `#/quick/${kind}?${params()}`, text: label });
    put(
      body,
      negative
        ? h('div', { class: 'notice' }, h('span', { text: `${negative.replaceAll('-', '/')} の現金残高がマイナスです。入金の記帳漏れや日付の誤りがないか確認してください。` }))
        : null,
      h(
        'section',
        { class: 'stat-grid cb-stats' },
        stat(carriedLabel(period, from), lg.carried),
        stat('入金', lg.debit),
        stat('出金', lg.credit),
        stat('残高', lg.closing),
      ),
      period.closed ? null : lg.account.active ? [h('div', { class: 'actions cb-actions' }, add('cash_in', '＋ 入金を記録', 'btn-primary'), add('cash_out', '− 出金を記録', 'btn-primary')), h('p', { class: 'center small' }, h('a', { class: 'link', href: `#/import/bank?${params()}`, text: '銀行明細のCSVを取り込む' }))] : h('p', { class: 'muted small', text: 'この科目は無効のため、記録はできません' }),
      lg.rows.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'report ledger cashbook' },
              h('thead', {}, h('tr', {}, ['日付', '相手科目／摘要', '入金', '出金', '残高'].map((t) => h('th', { scope: 'col', text: t })))),
              h(
                'tbody',
                {},
                h('tr', { class: 'carried' }, h('td'), h('td', { text: carriedLabel(period, from) }), h('td'), h('td'), amountCell('td', lg.carried)),
                lg.rows.map((r) =>
                  h(
                    'tr',
                    { class: 'tap-row', tabindex: 0, role: 'link', 'aria-label': `${r.date} ${r.counterpart} の仕訳を開く`, onclick: () => open(r), onkeydown: (e) => e.key === 'Enter' && open(r) },
                    h('td', { class: 'nowrap', text: r.date.slice(5).replace('-', '/') }),
                    h('td', {}, h('span', { class: 'lg-counter', text: r.counterpart }), r.memo ? h('span', { class: 'lg-memo', text: r.memo }) : null),
                    amountCell('td', r.debit, { blankZero: true }),
                    amountCell('td', r.credit, { blankZero: true }),
                    amountCell('td', r.balance),
                  ),
                ),
              ),
            ),
          )
        : emptyState(isAll ? 'この口座の取引はまだありません' : 'この月の取引はありません'),
      lg.rows.length
        ? h(
            'div',
            { class: 'report-tools no-print' },
            h('button', {
              type: 'button',
              class: 'btn',
              text: '表示中の出納帳をCSVで書き出す',
              onclick: () => {
                const subName = subId ? subAccounts.find((x) => x.id === subId)?.name ?? '' : '';
                saveFile(new Blob([ledgerCsv([lg], { carried: carriedLabel(period, from), debitLabel: '入金', creditLabel: '出金', subName })], { type: 'text/csv' }), csvFileName('cashbook'));
              },
            }),
          )
        : null,
    );
  }

  put(outlet, h('div', { class: 'ledger-pick' }, accSelect), h('div', { class: 'month-bar' }, prev, monthLabel, next, allBtn), body);
  paint();
}

function stat(label, n) {
  return h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: label }), h('span', { class: `stat-value num ${n < 0 ? 'neg' : ''}`, text: `${formatYen(n)}円` }));
}
