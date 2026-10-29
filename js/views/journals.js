// 仕訳帳：月別表示・検索・CSV 出力。タップで編集
import { h, put, emptyState, saveFile, showToast, field } from '../ui.js';
import { compareJournals, matchJournal, linesToRows } from '../journal.js';
import { monthsInPeriod, todayString } from '../period.js';
import { formatYen } from '../money.js';
import { TAX_BY_CODE } from '../tax.js';
import { normalize } from '../search.js';
import { journalsCsv, csvFileName } from '../csv.js';
import { searchJournals, hasCriteria } from '../journal-history.js';
import { parseYen } from '../money.js';
import { icon } from '../icons.js';

export async function render({ app, outlet, query }) {
  const data = await app.load();
  const { period, journals, accountById, subById, departmentById } = data;
  // 証憑を添付した仕訳に印を付ける
  const attachCount = new Map();
  for (const a of await app.db.listAttachments()) if (a.journalId) attachCount.set(a.journalId, (attachCount.get(a.journalId) || 0) + 1);
  const months = monthsInPeriod(period);
  const today = todayString().slice(0, 7);
  let month = query.month === 'all' ? 'all' : months.includes(query.month) ? query.month : months.includes(today) ? today : months[0];
  let q = query.q || '';
  // 詳しい検索（優良な電子帳簿の要件：日付・金額の範囲指定、取引先、2つ以上の項目の組合せ）
  const crit = { dateFrom: '', dateTo: '', amountMin: null, amountMax: null, accountId: '', party: '' };

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
    const ctx = { accountById, subById, normalize, departmentById };
    // 詳しい検索の条件があるときは、会計期間の全体から探す
    const adv = hasCriteria(crit);
    const base = journals.filter((j) => (adv || month === 'all' || j.date.startsWith(month)) && matchJournal(j, q, ctx));
    return (adv ? searchJournals(base, crit, ctx) : base).sort(compareJournals);
  }

  const advInput = (key, attrs) =>
    h('input', {
      id: `adv-${key}`,
      ...attrs,
      oninput: (e) => {
        const v = e.target.value.trim();
        if (key === 'amountMin' || key === 'amountMax') {
          const r = v === '' ? null : parseYen(v, { allowZero: true });
          if (r && !r.ok) return;
          crit[key] = r ? r.value : null;
        } else crit[key] = v;
        paint();
      },
    });
  const accountOptions = [...accountById.values()].filter((a) => a.active || journals.some((j) => j.lines.some((l) => l.accountId === a.id))).sort((a, b) => String(a.code).localeCompare(String(b.code)));
  const advanced = h(
    'details',
    { class: 'panel adv-search no-print' },
    h('summary', { text: '詳しく検索（日付・金額の範囲・取引先・科目）' }),
    h('div', { class: 'field-row' }, field('日付（から）', advInput('dateFrom', { type: 'date', min: period.startDate, max: period.endDate })), field('日付（まで）', advInput('dateTo', { type: 'date', min: period.startDate, max: period.endDate }))),
    h('div', { class: 'field-row' }, field('金額（以上）', advInput('amountMin', { type: 'text', inputmode: 'numeric', placeholder: '0' })), field('金額（以下）', advInput('amountMax', { type: 'text', inputmode: 'numeric', placeholder: '上限なし' }))),
    field('取引先', advInput('party', { type: 'text', placeholder: '補助科目・摘要に含まれる名前' })),
    field(
      '科目',
      h('select', { id: 'adv-accountId', onchange: (e) => ((crit.accountId = e.target.value), paint()) }, [h('option', { value: '', text: 'すべての科目' }), ...accountOptions.map((a) => h('option', { value: a.id, text: `${a.code} ${a.name}` }))]),
    ),
    h('p', { class: 'muted small', text: '入力した条件をすべて満たす仕訳を、会計期間の全体から探します。上の検索欄とも組み合わせられます。' }),
  );

  function paint() {
    const isAll = month === 'all';
    monthLabel.textContent = isAll ? '全期間' : `${month.slice(0, 4)}年${Number(month.slice(5))}月`;
    prev.disabled = isAll || months.indexOf(month) <= 0;
    next.disabled = isAll || months.indexOf(month) >= months.length - 1;
    allBtn.setAttribute('aria-checked', String(isAll));
    const items = visible();
    const total = items.reduce((s, j) => s + j.lines.filter((l) => l.side === 'debit').reduce((a, l) => a + l.amount, 0), 0);
    meta.textContent = `${hasCriteria(crit) ? '詳しい検索：会計期間の全体から ' : ''}${items.length}件・借方合計 ${formatYen(total)}円`;
    put(list, 
      ...(items.length
        ? items.map((j) => journalCard(j, accountById, subById, { attachments: attachCount.get(j.id) || 0, departmentById }))
        : [emptyState(journals.length ? '条件に合う仕訳はありません' : 'まだ仕訳がありません', journals.length ? null : h('a', { href: '#/entry', class: 'btn btn-primary', text: '取引を入力する' }))]),
    );
  }

  put(outlet, 
    h('div', { class: 'month-bar' }, prev, monthLabel, next, allBtn),
    h('div', { class: 'search-bar' }, search),
    advanced,
    meta,
    list,
    h(
      'div',
      { class: 'actions' },
      h('a', { href: '#/journals/history', class: 'btn', text: '訂正・削除の履歴' }),
      h('button', {
        type: 'button',
        class: 'btn',
        text: '表示中の仕訳をCSVで書き出す',
        onclick: async () => {
          const items = visible();
          if (!items.length) return showToast('書き出す仕訳がありません');
          const blob = new Blob([journalsCsv(items, { accountById, subById, departmentById })], { type: 'text/csv' });
          await saveFile(blob, csvFileName('journals'));
        },
      }),
    ),
  );
  paint();
}

/** 仕訳1件のカード（振替伝票の行を並べる）。attachments：添付した証憑の件数 */
export function journalCard(j, accountById, subById, { attachments = 0, departmentById = new Map() } = {}) {
  const sideCell = (s) => {
    if (!s.accountId) return h('div', { class: 'jc-side jc-empty' });
    const acc = accountById.get(s.accountId);
    const sub = s.subAccountId ? subById.get(s.subAccountId) : null;
    const tax = TAX_BY_CODE[s.taxCategory];
    const dep = s.departmentId ? departmentById.get(s.departmentId) : null;
    return h(
      'div',
      { class: 'jc-side' },
      h('span', { class: 'jc-acc', text: acc ? acc.name : '（不明な科目）' }),
      sub ? h('span', { class: 'jc-sub', text: sub.name }) : null,
      dep ? h('span', { class: 'jc-dep', text: dep.name }) : null,
      h('span', { class: 'jc-amt num', text: formatYen(Number(s.amount)) }),
      tax?.short ? h('span', { class: 'jc-tax', text: tax.short }) : null,
    );
  };
  const rows = linesToRows(j.lines);
  return h(
    'a',
    { class: 'jcard', href: `#/journal/${encodeURIComponent(j.id)}/edit` },
    h(
      'div',
      { class: 'jc-head' },
      h('span', { class: 'jc-date', text: j.date.slice(5).replace('-', '/') }),
      attachments ? h('span', { class: 'jc-attach', title: `証憑${attachments}件`, 'aria-label': `証憑${attachments}件` }, icon('attach'), attachments > 1 ? String(attachments) : null) : null,
      h('span', { class: 'jc-no', text: `No.${j.no}` }),
    ),
    h(
      'div',
      { class: 'jc-rows' },
      rows.map((r) => h('div', { class: 'jc-row' }, sideCell(r.debit), sideCell(r.credit), r.memo ? h('div', { class: 'jc-memo', text: r.memo }) : null)),
    ),
  );
}
