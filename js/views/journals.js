// 仕訳帳：月別表示・検索・CSV 出力。タップで編集
import { h, put, emptyState, saveFile, showToast } from '../ui.js';
import { compareJournals, matchJournal, linesToRows } from '../journal.js';
import { monthsInPeriod, todayString } from '../period.js';
import { formatYen } from '../money.js';
import { TAX_BY_CODE } from '../tax.js';
import { normalize } from '../search.js';
import { journalsCsv, csvFileName } from '../csv.js';

export async function render({ app, outlet, query }) {
  const data = await app.load();
  const { period, journals, accountById, subById } = data;
  const months = monthsInPeriod(period);
  const today = todayString().slice(0, 7);
  let month = query.month === 'all' ? 'all' : months.includes(query.month) ? query.month : months.includes(today) ? today : months[0];
  let q = query.q || '';

  const list = h('div', { class: 'journal-list' });
  const meta = h('p', { class: 'list-meta' });
  const monthLabel = h('span', { class: 'month-label' });
  const prev = h('button', { type: 'button', class: 'btn btn-small', 'aria-label': '前の月', text: '‹', onclick: () => move(-1) });
  const next = h('button', { type: 'button', class: 'btn btn-small', 'aria-label': '次の月', text: '›', onclick: () => move(1) });
  const allBtn = h('button', { type: 'button', class: 'seg', role: 'switch', text: '全期間', onclick: () => setMonth(month === 'all' ? (months.includes(today) ? today : months[0]) : 'all') });
  const search = h('input', {
    type: 'search',
    class: 'search-input',
    placeholder: '摘要・科目・金額で検索',
    'aria-label': '仕訳を検索',
    value: q,
    oninput: (e) => {
      q = e.target.value;
      paint();
      syncUrl();
    },
  });

  function move(d) {
    const i = months.indexOf(month);
    if (i < 0) return;
    const n = months[i + d];
    if (n) setMonth(n);
  }
  function setMonth(m) {
    month = m;
    paint();
    syncUrl();
  }
  function syncUrl() {
    const params = new URLSearchParams();
    params.set('month', month);
    if (q) params.set('q', q);
    history.replaceState(history.state, '', `#/journals?${params}`);
  }

  function visible() {
    const ctx = { accountById, subById, normalize };
    return journals
      .filter((j) => (month === 'all' || j.date.startsWith(month)) && matchJournal(j, q, ctx))
      .sort(compareJournals);
  }

  function paint() {
    const isAll = month === 'all';
    monthLabel.textContent = isAll ? '全期間' : `${month.slice(0, 4)}年${Number(month.slice(5))}月`;
    prev.disabled = isAll || months.indexOf(month) <= 0;
    next.disabled = isAll || months.indexOf(month) >= months.length - 1;
    allBtn.setAttribute('aria-checked', String(isAll));
    const items = visible();
    const total = items.reduce((s, j) => s + j.lines.filter((l) => l.side === 'debit').reduce((a, l) => a + l.amount, 0), 0);
    meta.textContent = `${items.length}件・借方合計 ${formatYen(total)}円`;
    put(list, 
      ...(items.length
        ? items.map((j) => journalCard(j, accountById, subById))
        : [emptyState(journals.length ? '条件に合う仕訳はありません' : 'まだ仕訳がありません', journals.length ? null : h('a', { href: '#/journal/new', class: 'btn btn-primary', text: '仕訳を入力する' }))]),
    );
  }

  put(outlet, 
    h('div', { class: 'month-bar' }, prev, monthLabel, next, allBtn),
    h('div', { class: 'search-bar' }, search),
    meta,
    list,
    h(
      'div',
      { class: 'actions' },
      h('button', {
        type: 'button',
        class: 'btn',
        text: '表示中の仕訳をCSVで書き出す',
        onclick: async () => {
          const items = visible();
          if (!items.length) return showToast('書き出す仕訳がありません');
          const blob = new Blob([journalsCsv(items, { accountById, subById })], { type: 'text/csv' });
          await saveFile(blob, csvFileName('journals'));
        },
      }),
    ),
  );
  paint();
}

/** 仕訳1件のカード（振替伝票の行を並べる） */
export function journalCard(j, accountById, subById) {
  const sideCell = (s) => {
    if (!s.accountId) return h('div', { class: 'jc-side jc-empty' });
    const acc = accountById.get(s.accountId);
    const sub = s.subAccountId ? subById.get(s.subAccountId) : null;
    const tax = TAX_BY_CODE[s.taxCategory];
    return h(
      'div',
      { class: 'jc-side' },
      h('span', { class: 'jc-acc', text: acc ? acc.name : '（不明な科目）' }),
      sub ? h('span', { class: 'jc-sub', text: sub.name }) : null,
      h('span', { class: 'jc-amt num', text: formatYen(Number(s.amount)) }),
      tax?.short ? h('span', { class: 'jc-tax', text: tax.short }) : null,
    );
  };
  const rows = linesToRows(j.lines);
  return h(
    'a',
    { class: 'jcard', href: `#/journal/${encodeURIComponent(j.id)}/edit` },
    h('div', { class: 'jc-head' }, h('span', { class: 'jc-date', text: j.date.slice(5).replace('-', '/') }), h('span', { class: 'jc-no', text: `No.${j.no}` })),
    h(
      'div',
      { class: 'jc-rows' },
      rows.map((r) => h('div', { class: 'jc-row' }, sideCell(r.debit), sideCell(r.credit), r.memo ? h('div', { class: 'jc-memo', text: r.memo }) : null)),
    ),
  );
}
