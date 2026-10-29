// 月次推移の試算表：期間を選び、科目ごとに月の数字を横に並べる（貸借は月末残高、損益は月の発生額）
// 四半期・半期の合計と、決算整理の仕訳を別の列にするかを選べる
import { h, put, amountCell, saveFile } from '../ui.js';
import { monthlyTrialBalance } from '../monthly.js';
import { groupLabel } from '../accounts.js';
import { monthlyTrialCsv, csvFileName } from '../csv.js';
import { monthRangePicker, openingWarning, unitPicker, monthRangeOptions, printRange, unitPrintOptions } from './report-common.js';
import { monthlyDoc, docHead } from '../print-forms.js';
import { normalizeUnit } from '../money.js';
import { openingDiff } from '../ledger.js';

const OPTIONS = [
  ['q', '四半期の合計'],
  ['hy', '半期の合計'],
  ['adj', '決算整理を別の列に'],
  ['zero', '0円の科目も表示'],
];

export async function render({ app, outlet, query }) {
  const { settings, period, accounts, journals } = await app.load();
  const entityType = settings.entityType;
  const opts = Object.fromEntries(OPTIONS.map(([k]) => [k, query[k] === '1']));
  const body = h('div');
  const picker = monthRangePicker({ period, query, path: '/reports/trial-monthly', onChange: paint, extra: () => Object.fromEntries(Object.entries(opts).filter(([, v]) => v).map(([k]) => [k, '1'])) });
  let mtb;
  const unit = unitPicker({ key: '/reports/trial-monthly', onChange: () => paint() });
  const toggles = h(
    'div',
    { class: 'option-bar' },
    OPTIONS.map(([k, label]) => {
      const input = h('input', {
        type: 'checkbox',
        checked: opts[k],
        onchange: () => {
          opts[k] = input.checked;
          picker.refreshUrl();
          paint();
        },
      });
      return h('label', { class: 'check small' }, input, label);
    }),
  );

  // 印刷：A4横の推移表。印刷条件：期間・四半期／半期の合計・決算整理の列・0円の科目・金額の単位
  app.printDoc = ({ printedAt }) => {
    const r0 = picker.range();
    return {
      options: [
        ...monthRangeOptions(period, r0.fromMonth, r0.toMonth),
        ...OPTIONS.map(([k, label]) => ({ key: k, label, type: 'check', value: opts[k] })),
        ...unitPrintOptions(unit.value()),
        { key: 'orientation', label: '用紙の向き', type: 'select', choices: [['landscape', 'A4横'], ['portrait', 'A4縦']], value: 'landscape' },
      ],
      build: (v) => {
        const r = printRange(period, v);
        const t = monthlyTrialBalance({ accounts, period, journals, fromMonth: r.fromMonth, toMonth: r.toMonth, quarters: v.q, halves: v.hy, separateAdjusting: v.adj });
        const rows = [];
        for (const g of t.groups) {
          const lines = g.rows.filter((x) => v.zero || x.values.some((n) => n !== 0));
          if (!lines.length) continue;
          rows.push({ kind: 'group', label: groupLabel(g.group, entityType), values: g.values });
          for (const x of lines) rows.push({ kind: 'line', label: x.account.name, values: x.values });
        }
        return monthlyDoc({
          title: '月次推移試算表',
          head: docHead({ settings, period, ...r, printedAt }),
          columns: t.columns.map((c) => c.label),
          sections: [{ rows }],
          unit: normalizeUnit(v),
          orientation: v.orientation,
          notes: ['資産・負債・純資産の科目は各月末の残高、収益・費用の科目はその月の発生額です。'],
        });
      },
    };
  };

  function paint() {
    const { fromMonth, toMonth } = picker.range();
    mtb = monthlyTrialBalance({ accounts, period, journals, fromMonth, toMonth, quarters: opts.q, halves: opts.hy, separateAdjusting: opts.adj });
    const cls = (c) => `mt-col-${c.type}`;
    const head = h('tr', {}, h('th', { scope: 'col', text: '勘定科目' }), mtb.columns.map((c) => h('th', { scope: 'col', class: cls(c), text: c.label })));
    const rows = [];
    for (const g of mtb.groups) {
      const lines = g.rows.filter((r) => opts.zero || r.values.some((v) => v !== 0));
      if (!lines.length) continue;
      rows.push(h('tr', { class: 'tb-group' }, h('th', { scope: 'row', text: groupLabel(g.group, entityType) }), g.values.map((v, i) => amountCell('td', v, { cls: cls(mtb.columns[i]) }))));
      for (const r of lines) {
        rows.push(
          h(
            'tr',
            {},
            h('th', { scope: 'row', class: 'mt-acc' }, h('a', { href: `#/reports/ledger?account=${r.account.id}&from=${fromMonth}&to=${toMonth}`, text: r.account.name })),
            r.values.map((v, i) => amountCell('td', v, { blankZero: true, cls: cls(mtb.columns[i]) })),
          ),
        );
      }
    }
    put(
      body,
      openingWarning(entityType === 'individual' ? 0 : openingDiff(period, accounts)),
      rows.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'report monthly mtb' }, h('thead', {}, head), h('tbody', {}, rows)))
        : h('p', { class: 'empty', text: 'この期間の仕訳・残高はありません。' }),
    );
  }

  put(
    outlet,
    picker.el,
    unit.el,
    toggles,
    body,
    h(
      'div',
      { class: 'actions no-print' },
      h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: () => saveFile(new Blob([monthlyTrialCsv(mtb, { entityType, includeZero: opts.zero })], { type: 'text/csv' }), csvFileName('trial-balance-monthly')) }),
    ),
    h(
      'div',
      { class: 'panel small muted' },
      h('p', { text: '資産・負債・純資産の科目は各月末（四半期・半期はその最後の月末）の残高、収益・費用の科目はその月（四半期・半期）の発生額です。繰越残高は開始月の前日までの残高です。' }),
      h('p', { text: '「決算整理を別の列に」を選ぶと、決算整理仕訳を月の数字から外して「決算整理」の列に出します。貸借の科目の「決算整理」の列は決算整理後の残高です。減価償却・消費税等・期末棚卸の画面で作った仕訳と、振替伝票で「決算整理仕訳」にした仕訳が対象です。' }),
      h('p', { text: '四半期・半期は、会計期間の最初の月から3か月・6か月ずつ区切ります。' }),
    ),
  );
  paint();
}
