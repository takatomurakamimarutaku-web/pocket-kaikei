// 仕訳帳：月別表示・並び順（日付順・入力順・伝票No順）・検索・CSV 出力。タップで編集
import { h, put, emptyState, saveFile, showToast, field, segmented } from '../ui.js';
import { JOURNAL_ORDERS, matchJournal, linesToRows, voucherOf, parseVoucherNo } from '../journal.js';
import { monthsInPeriod, todayString } from '../period.js';
import { monthRangeOptions, printRange } from './report-common.js';
import { journalBookDoc, docHead } from '../print-forms.js';
import { formatYen } from '../money.js';
import { TAX_BY_CODE } from '../tax.js';
import { normalize } from '../search.js';
import { journalsCsv, csvFileName } from '../csv.js';
import { searchJournals, hasCriteria } from '../journal-history.js';
import { parseYen } from '../money.js';
import { icon } from '../icons.js';

export async function render({ app, outlet, query }) {
  const data = await app.load();
  const { settings, period, journals, accountById, subById, departmentById } = data;
  // 証憑を添付した仕訳に印を付ける
  const attachCount = new Map();
  for (const a of await app.db.listAttachments()) if (a.journalId) attachCount.set(a.journalId, (attachCount.get(a.journalId) || 0) + 1);
  const months = monthsInPeriod(period);
  const today = todayString().slice(0, 7);
  let month = query.month === 'all' ? 'all' : months.includes(query.month) ? query.month : months.includes(today) ? today : months[0];
  let q = query.q || '';
  // 並び順：日付順（同じ日は伝票No順）・入力順（入力No）・伝票No順。印刷・CSV もこの順
  let order = Object.hasOwn(JOURNAL_ORDERS, query.order) ? query.order : 'date';
  // 詳しい検索（優良な電子帳簿の要件：日付・金額の範囲指定、取引先、2つ以上の項目の組合せ）
  const crit = { dateFrom: '', dateTo: '', amountMin: null, amountMax: null, accountId: '', party: '', voucherFrom: null, voucherTo: null };

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
    if (order !== 'date') params.set('order', order);
    history.replaceState(history.state, '', `#/journals?${params}`);
  }

  function visible() {
    const ctx = { accountById, subById, normalize, departmentById };
    // 詳しい検索の条件があるときは、会計期間の全体から探す
    const adv = hasCriteria(crit);
    const base = journals.filter((j) => (adv || month === 'all' || j.date.startsWith(month)) && matchJournal(j, q, ctx));
    return (adv ? searchJournals(base, crit, ctx) : base).sort(JOURNAL_ORDERS[order]);
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
        } else if (key === 'voucherFrom' || key === 'voucherTo') {
          const r = v === '' ? null : parseVoucherNo(v);
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
    h('summary', { text: '詳しく検索（日付・金額の範囲・取引先・科目・伝票No）' }),
    h('div', { class: 'field-row' }, field('日付（から）', advInput('dateFrom', { type: 'date', min: period.startDate, max: period.endDate })), field('日付（まで）', advInput('dateTo', { type: 'date', min: period.startDate, max: period.endDate }))),
    h('div', { class: 'field-row' }, field('金額（以上）', advInput('amountMin', { type: 'text', inputmode: 'numeric', placeholder: '0' })), field('金額（以下）', advInput('amountMax', { type: 'text', inputmode: 'numeric', placeholder: '上限なし' }))),
    field('取引先', advInput('party', { type: 'text', placeholder: '補助科目・摘要に含まれる名前' })),
    field(
      '科目',
      h('select', { id: 'adv-accountId', onchange: (e) => ((crit.accountId = e.target.value), paint()) }, [h('option', { value: '', text: 'すべての科目' }), ...accountOptions.map((a) => h('option', { value: a.id, text: `${a.code} ${a.name}` }))]),
    ),
    h('div', { class: 'field-row' }, field('伝票No（から）', advInput('voucherFrom', { type: 'text', inputmode: 'numeric' })), field('伝票No（まで）', advInput('voucherTo', { type: 'text', inputmode: 'numeric' }))),
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
        ? items.map((j) => journalCard(j, accountById, subById, { attachments: attachCount.get(j.id) || 0, departmentById, showInputNo: order === 'input' }))
        : [emptyState(journals.length ? '条件に合う仕訳はありません' : 'まだ仕訳がありません', journals.length ? null : h('a', { href: '#/entry', class: 'btn btn-primary', text: '取引を入力する' }))]),
    );
  }

  // 印刷：表示中の仕訳（月・検索・並び順）を仕訳日記帳の様式で
  // 印刷条件：期間（月）・並び順・月計・月ごとの改ページ・画面の検索の絞り込み
  app.printDoc = ({ printedAt }) => {
    const filtered = Boolean(q) || hasCriteria(crit);
    const all = month === 'all' || hasCriteria(crit);
    return {
      options: [
        ...monthRangeOptions(period, all ? undefined : month, all ? undefined : month),
        { key: 'order', label: '並び順', type: 'select', choices: [['date', '日付順'], ['voucher', '伝票No順'], ['input', '入力順']], value: order },
        { key: 'monthTotal', label: '月計を出す', type: 'check', value: false },
        { key: 'monthBreak', label: '月ごとに改ページ', type: 'check', value: false },
        filtered ? { key: 'filter', label: '画面の検索の条件で絞り込む', type: 'check', value: true } : null,
      ].filter(Boolean),
      build: (v) => {
        const r = printRange(period, v);
        const base = v.filter ? visible() : journals;
        const list = base.filter((j) => j.date >= r.from && j.date <= r.to).sort(JOURNAL_ORDERS[v.order]);
        return journalBookDoc({ journals: list, accountById, subById, departmentById, head: docHead({ settings, period, ...r, printedAt }), monthTotal: v.monthTotal, monthBreak: v.monthBreak });
      },
    };
  };
  put(outlet, 
    h('div', { class: 'month-bar' }, prev, monthLabel, next, allBtn),
    h('div', { class: 'search-bar' }, search),
    h(
      'div',
      { class: 'journal-order no-print' },
      segmented({
        name: '並び順',
        options: [
          { value: 'date', label: '日付順' },
          { value: 'input', label: '入力順' },
          { value: 'voucher', label: '伝票No順' },
        ],
        value: order,
        onChange: (v) => {
          order = v;
          paint();
          syncUrl();
        },
      }),
    ),
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

/**
 * 仕訳1件のカード（振替伝票の行を並べる）。attachments：添付した証憑の件数
 * showInputNo：入力No も出す（入力順のとき。伝票No と入力No が違う仕訳はいつも出す）
 */
export function journalCard(j, accountById, subById, { attachments = 0, departmentById = new Map(), showInputNo = false } = {}) {
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
      h('span', { class: 'jc-no' }, `伝票No.${voucherOf(j)}`, showInputNo || voucherOf(j) !== j.no ? h('span', { class: 'jc-input-no', text: `入力No.${j.no}` }) : null),
    ),
    h(
      'div',
      { class: 'jc-rows' },
      rows.map((r) => h('div', { class: 'jc-row' }, sideCell(r.debit), sideCell(r.credit), r.memo ? h('div', { class: 'jc-memo', text: r.memo }) : null)),
    ),
  );
}
