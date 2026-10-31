// 部門別損益：部門ごとの売上・段階利益。部門を付けなかった明細（共通）は配賦しないか、売上高の割合・均等で配る
import { h, put, amountCell, saveFile, segmented, showToast, emptyState } from '../ui.js';
import { departmentIncome } from '../departments.js';
import { isAllZero } from '../monthly.js';
import { plFigures, permille } from '../analysis.js';
import { formatPermille } from '../compare.js';
import { monthlyCsv, csvFileName } from '../csv.js';
import { formatPeriod, formatRange } from '../period.js';
import { isWhite } from '../white-return.js';
import { monthRangePicker, zeroToggle, unitPicker } from './report-common.js';

const ALLOCATION_OPTIONS = [
  { value: 'none', label: '配賦しない' },
  { value: 'sales', label: '売上高の割合' },
  { value: 'equal', label: '均等' },
];
const monthText = (m) => `${Number(m.slice(5))}月`;

export async function render({ app, outlet, query }) {
  const { settings, period, accounts, journals, departments } = await app.load();
  const entityType = settings.entityType;
  const individual = entityType === 'individual';
  const white = isWhite(settings);
  const head = h('p', { class: 'muted small', text: `${settings.businessName}　${formatPeriod(period)}` });
  if (!departments.length) {
    return put(
      outlet,
      head,
      emptyState('部門はまだありません', h('p', { class: 'muted small', text: '店舗・事業・商品などの部門を登録して、仕訳の売上・経費の行に付けると、部門ごとの売上と利益をここで見られます。' }), { title: '部門別損益' }),
      h('a', { href: '#/departments', class: 'btn btn-block', text: '部門を登録する' }),
    );
  }

  let allocation = ALLOCATION_OPTIONS.some((o) => o.value === query.alloc) ? query.alloc : 'none';
  let showZero = false;
  let result = null;
  const body = h('div');
  const zero = zeroToggle((v) => ((showZero = v), paint()));
  const unit = unitPicker({ key: '/reports/departments', onChange: () => paint() });
  const picker = monthRangePicker({ period, query, path: '/reports/departments', extra: () => ({ alloc: allocation }), onChange: () => paint() });

  // 利益率の行：法人は売上総利益率・営業利益率、個人は売上総利益率（差引金額の率）・所得率
  function ratioRows(statements, total) {
    const figs = [...statements, total].map((s) => plFigures(entityType, s.profits));
    const defs = individual
      ? [
          ['売上総利益率', (f) => permille(f.gross, f.sales)],
          ['所得率', (f) => permille(f.income, f.sales)],
        ]
      : [
          ['売上総利益率', (f) => permille(f.gross, f.sales)],
          ['営業利益率', (f) => permille(f.operating, f.sales)],
        ];
    return defs.map(([label, fn]) => h('tr', { class: 'mt-ratio' }, h('th', { scope: 'row', text: label }), figs.map((f) => h('td', { class: 'num', text: formatPermille(fn(f)) }))));
  }

  function table({ columns, items, statements, total }, { fromMonth, toMonth, from, to, query: rq }) {
    const headRow = h('tr', {}, h('th', { scope: 'col', text: '科目' }), columns.map((c) => h('th', { scope: 'col', class: c.department ? '' : 'dep-common', text: c.label })), h('th', { scope: 'col', text: '合計' }));
    const rows = [];
    for (const item of items) {
      if (item.type === 'group') {
        const lines = item.lines.filter((l) => showZero || !isAllZero(l.values));
        if (!lines.length && !item.total && !showZero) continue;
        rows.push(h('tr', { class: 'tb-group' }, h('th', { scope: 'row', title: item.label, text: item.label }), item.values.map((v) => amountCell('td', v)), amountCell('td', item.total)));
        for (const l of lines) {
          rows.push(h('tr', {}, h('th', { scope: 'row', class: 'mt-acc', text: l.account.name }), l.values.map((v) => amountCell('td', v, { blankZero: true })), amountCell('td', l.total)));
        }
      } else {
        if (item.heading && !showZero && isAllZero(item.values) && !item.total) continue;
        rows.push(h('tr', { class: item.strong ? 'mt-strong' : 'tb-subtotal' }, h('th', { scope: 'row', title: item.label, text: item.label }), item.values.map((v) => amountCell('td', v)), amountCell('td', item.total)));
      }
    }
    // 月の区切りなら「2026年4月〜2026年6月」、日で選んだときは日付の範囲
    const range = rq.from.length > 7 ? formatRange({ from, to }) : fromMonth === toMonth ? monthText(fromMonth) : `${monthText(fromMonth)}〜${monthText(toMonth)}`;
    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'report monthly dep-pl' },
        h('caption', { text: `部門別損益（${range}）` }),
        h('thead', {}, headRow),
        h('tbody', {}, rows, ratioRows(statements, total)),
      ),
    );
  }

  function paint() {
    picker.refreshUrl();
    const range = picker.range();
    result = departmentIncome({ entityType, accounts, period, journals, departments, from: range.from, to: range.to, allocation, white });
    const { allocation: alloc } = result;
    const explain =
      alloc.basis === 'none'
        ? '部門を付けなかった売上・経費は「共通（部門なし）」の列に出しています。'
        : alloc.applied
          ? alloc.basis === 'sales'
            ? '部門を付けなかった売上・経費（共通）を、科目ごとに各部門の売上高の割合で配っています。円未満は合計が合うように割り振っています。'
            : '部門を付けなかった売上・経費（共通）を、科目ごとに部門の数で均等に配っています。円未満は合計が合うように割り振っています。'
          : '';
    put(
      body,
      alloc.note ? h('p', { class: 'notice', text: alloc.note }) : null,
      explain ? h('p', { class: 'muted small', text: explain }) : null,
      table(result, range),
      h('p', { class: 'muted small', text: `${individual ? `売上総利益率＝差引金額÷売上(収入)金額、所得率＝${white ? '専従者控除前' : '青色申告特別控除前'}の所得金額÷売上(収入)金額` : '売上総利益率＝売上総利益÷売上高、営業利益率＝営業利益÷売上高'}（売上が0以下の列は「—」）。` }),
      h('p', { class: 'muted small', text: '合計の列は損益計算書と同じ数字です。部門は管理用の集計で、決算書・申告書には影響しません。' }),
    );
  }

  const csvBtn = h('button', {
    type: 'button',
    class: 'btn',
    text: 'CSVで書き出す',
    onclick: async () => {
      if (!journals.length) return showToast('書き出す取引がありません');
      const text = monthlyCsv(result.items, [], { total: true, includeZero: showZero, labels: result.columns.map((c) => c.label) });
      await saveFile(new Blob([text], { type: 'text/csv' }), csvFileName('departments'));
    },
  });

  put(
    outlet,
    head,
    h(
      'div',
      { class: 'report-tools' },
      picker.el,
      h('div', { class: 'field-label small', text: '共通の売上・経費の配賦' }),
      segmented({ name: '共通の配賦', options: ALLOCATION_OPTIONS, value: allocation, onChange: (v) => ((allocation = v), paint()) }),
      unit.el,
      zero.el,
    ),
    body,
    h('div', { class: 'actions' }, csvBtn, h('a', { href: '#/departments', class: 'btn', text: '部門の設定' })),
  );
  paint();
}
