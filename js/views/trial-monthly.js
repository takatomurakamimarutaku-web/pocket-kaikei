// 月次推移の試算表：期間を選び、科目ごとに月の数字を横に並べる（貸借は月末残高、損益は月の発生額）
// 市販の会計ソフトの推移試算表と同じく、貸借対照表・損益計算書・製造原価の部に分け（画面はタブ、印刷は部ごとに改ページ）、
// 区分の合計・段階利益・当期純損益金額・負債・純資産合計の行を入れる
// 四半期・半期の合計と、決算整理の仕訳を別の列にするかを選べる
import { h, put, amountCell, saveFile, segmented } from '../ui.js';
import { monthlyTrialBalance, monthlyTrialStatements } from '../monthly.js';
import { monthlyTrialCsv, csvFileName } from '../csv.js';
import { monthRangePicker, openingWarning, unitPicker, monthRangeOptions, printRange, unitPrintOptions } from './report-common.js';
import { monthlyDoc, docHead, TRIAL_PARTS } from '../print-forms.js';
import { isWhite } from '../white-return.js';
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
  const white = isWhite(settings);
  const opts = Object.fromEntries(OPTIONS.map(([k]) => [k, query[k] === '1']));
  const body = h('div');
  // 部（貸借対照表・損益計算書・製造原価）はタブで切り替える。製造原価のタブは製造原価の科目を使っているときだけ
  const hasMfg = monthlyTrialStatements({ accounts, period, journals }, { entityType, white }).mfg.rows.length > 0;
  const partList = TRIAL_PARTS.filter(([key]) => key !== 'mfg' || hasMfg);
  let part = partList.some(([key]) => key === query.part) ? query.part : 'bs';
  const extra = () => ({ ...(part === 'bs' ? {} : { part }), ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v).map(([k]) => [k, '1'])) });
  // 列が月の帳票なので、期間は月の単位で選ぶ
  const picker = monthRangePicker({ period, query, path: '/reports/trial-monthly', onChange: paint, extra, monthsOnly: true });
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
  const statements = (r, v) => monthlyTrialStatements({ accounts, period, journals, fromMonth: r.fromMonth, toMonth: r.toMonth, quarters: v.q, halves: v.hy, separateAdjusting: v.adj }, { entityType, white, showZero: v.zero });
  const NOTES = {
    bs: '各月末（四半期・半期はその最後の月末）の残高です。当期純損益金額は期首からその月末までの累計です。',
    pl: '各月（四半期・半期）の発生額です。',
    mfg: '各月（四半期・半期）の発生額です。',
  };

  // 印刷：A4横の推移表。貸借対照表・損益計算書・製造原価の部ごとに改ページする
  // 印刷条件：印刷する部・期間・四半期／半期の合計・決算整理の列・0円の科目・金額の単位・用紙の向き
  app.printDoc = ({ printedAt }) => {
    const r0 = picker.range();
    return {
      options: [
        { key: 'parts', label: '印刷する部', type: 'select', choices: [['all', 'すべて（部ごとに改ページ）'], ...partList.map(([key, name]) => [key, `${name}だけ`])], value: 'all' },
        ...monthRangeOptions(period, r0.fromMonth, r0.toMonth),
        ...OPTIONS.map(([k, label]) => ({ key: k, label, type: 'check', value: opts[k] })),
        ...unitPrintOptions(unit.value()),
        { key: 'orientation', label: '用紙の向き', type: 'select', choices: [['landscape', 'A4横'], ['portrait', 'A4縦']], value: 'landscape' },
      ],
      build: (v) => {
        const r = printRange(period, v);
        const st = statements(r, v);
        const keys = partList.map(([key]) => key).filter((key) => (v.parts === 'all' ? key === 'bs' || st[key].rows.length : key === v.parts));
        return monthlyDoc({
          title: '月次推移試算表',
          head: docHead({ settings, period, ...r, printedAt }),
          columns: [],
          sections: keys.map((key) => ({ title: `月次推移試算表（${TRIAL_PARTS.find(([k]) => k === key)[1]}）`, columns: st[key].columns.map((c) => c.label), rows: st[key].rows })),
          unit: normalizeUnit(v),
          orientation: v.orientation,
          notes: keys.length === 1 ? [NOTES[keys[0]]] : ['貸借対照表は各月末の残高（当期純損益金額は期首からの累計）、損益計算書・製造原価は各月の発生額です。'],
        });
      },
    };
  };

  function paint() {
    const r = picker.range();
    const { fromMonth, toMonth } = r;
    // CSV は今までどおり全科目の一覧（区分の計つき）で書き出す
    mtb = monthlyTrialBalance({ accounts, period, journals, fromMonth, toMonth, quarters: opts.q, halves: opts.hy, separateAdjusting: opts.adj });
    const st = statements(r, opts)[part];
    const cls = (c) => `mt-col-${c.type}`;
    const head = h('tr', {}, h('th', { scope: 'col', text: '勘定科目' }), st.columns.map((c) => h('th', { scope: 'col', class: cls(c), text: c.label })));
    const ROW_CLASS = { subtotal: 'tb-subtotal', total: 'mt-total', profit: 'mt-profit', calc: 'mt-calc', income: 'mt-calc' };
    const rows = st.rows.map((x) => {
      if (x.kind === 'group') return h('tr', { class: 'tb-group mt-head' }, h('th', { scope: 'row', text: x.label }), st.columns.map((c) => h('td', { class: cls(c) })));
      if (x.kind === 'line') {
        return h(
          'tr',
          {},
          h('th', { scope: 'row', class: 'mt-acc' }, h('a', { href: `#/reports/ledger?account=${x.account.id}&from=${fromMonth}&to=${toMonth}`, text: x.label })),
          x.values.map((v, i) => amountCell('td', v, { blankZero: true, cls: cls(st.columns[i]) })),
        );
      }
      const c = x.strong || x.grand ? 'mt-strong' : ROW_CLASS[x.kind];
      return h('tr', { class: c }, h('th', { scope: 'row', title: x.label, text: x.label }), x.values.map((v, i) => amountCell('td', v, { cls: cls(st.columns[i]) })));
    });
    put(
      body,
      openingWarning(entityType === 'individual' ? 0 : openingDiff(period, accounts)),
      rows.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'report monthly mtb', 'aria-label': `月次推移試算表（${TRIAL_PARTS.find(([k]) => k === part)[1]}）` }, h('thead', {}, head), h('tbody', {}, rows)))
        : h('p', { class: 'empty', text: 'この期間の仕訳・残高はありません。' }),
    );
  }

  put(
    outlet,
    h(
      'div',
      { class: 'report-tools' },
      segmented({
        name: '表示する部',
        options: partList.map(([value, label]) => ({ value, label })),
        value: part,
        onChange: (v) => {
          part = v;
          picker.refreshUrl();
          paint();
        },
      }),
      picker.el,
      unit.el,
    ),
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
      h('p', { text: '貸借対照表は各月末（四半期・半期はその最後の月末）の残高で、純資産に期首からの当期純損益金額を入れています。損益計算書・製造原価はその月（四半期・半期）の発生額です。繰越は開始月の前日までの残高（損益は期首からの累計）です。' }),
      h('p', { text: '「決算整理を別の列に」を選ぶと、決算整理仕訳を月の数字から外して「決算整理」の列に出します。貸借対照表では「決算整理後」の残高を出します。減価償却・消費税等・期末棚卸の画面で作った仕訳と、振替伝票で「決算整理仕訳」にした仕訳が対象です。' }),
      h('p', { text: '四半期・半期は、会計期間の最初の月から3か月・6か月ずつ区切ります。' }),
    ),
  );
  paint();
}
