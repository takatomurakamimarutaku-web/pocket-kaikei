// 製造原価報告書（法人）：材料費・労務費・製造経費 → 当期総製造費用 → 仕掛品の増減 → 当期製品製造原価
// 期間の合計は決算書と同じ体裁（税務申告に添付する決算書の1枚。行は fs-rows.js）、月ごとに横に並べる表示に切り替えられる
import { h, put, amountCell, saveFile, segmented } from '../ui.js';
import { closingRows, manufacturingReport } from '../statements.js';
import { monthlyManufacturing, manufacturingMonthlyRows } from '../monthly.js';
import { manufacturingCsv, monthlyCsv, csvFileName } from '../csv.js';
import { formatPeriod } from '../period.js';
import { formatYen, unitCaption, normalizeUnit } from '../money.js';
import { zeroToggle, unitPicker, unitPrintOptions } from './report-common.js';
import { fsPaper, fsPeriod, incomeStatementTable } from './fs-view.js';
import { incomeStatementDoc, monthlyDoc, docHead } from '../print-forms.js';

export async function render({ app, outlet, query }) {
  const { settings, period, accounts, journals } = await app.load();
  if (settings.entityType !== 'corporation') return put(outlet, h('p', { class: 'notice', text: '製造原価報告書は法人だけで使えます。' }));
  const report = manufacturingReport(closingRows({ accounts, period, journals }));
  if (!report.used) {
    return put(
      outlet,
      h(
        'section',
        { class: 'panel' },
        h('p', { text: '製造原価の科目がありません。' }),
        h('p', { class: 'small' }, h('a', { href: '#/settings', class: 'link', text: '事業者の設定' }), ' で「製造原価」を「使う」にすると、材料費・労務費・製造経費・仕掛品の科目を追加して、この報告書を作れます。'),
      ),
    );
  }
  let mode = query.mode === 'monthly' ? 'monthly' : 'total';
  let showZero = false;
  let monthly = null;
  const body = h('div');
  const zero = zeroToggle((v) => ((showZero = v), paint()));
  const unit = unitPicker({ key: '/reports/manufacturing', onChange: () => paint() });
  const monthLabel = (m) => `${Number(m.slice(5))}月`;
  const getMonthly = () => (monthly = monthly || monthlyManufacturing({ accounts, period, journals }));

  // 期間の合計：決算書と同じ用紙（表題・期間・会社名・単位）と、科目｜金額（内訳）｜金額（合計）の表
  function totalTable() {
    return fsPaper({
      title: '製造原価報告書',
      period: fsPeriod.range(period),
      company: settings.businessName,
      unit: unitCaption(unit.value()),
      body: incomeStatementTable(report.items, { entityType: 'corporation', showZero, label: '製造原価報告書' }),
    });
  }

  function monthlyTable() {
    const m = getMonthly();
    const head = h('tr', {}, h('th', { scope: 'col', text: '科目' }), m.months.map((x) => h('th', { scope: 'col', text: monthLabel(x) })), h('th', { scope: 'col', class: 'mt-col-total', text: '合計' }));
    const ROW_CLASS = { subtotal: 'tb-subtotal', profit: 'mt-profit', calc: 'mt-calc', total: 'mt-strong' };
    const cls = (i) => (i === m.months.length ? 'mt-col-total' : '');
    const rows = manufacturingMonthlyRows(m.items, { showZero }).map((r) => {
      if (r.kind === 'group') return h('tr', { class: 'tb-group mt-head' }, h('th', { scope: 'row', text: r.label }), [...m.months, 'total'].map((_, i) => h('td', { class: cls(i) })));
      if (r.kind === 'line') return h('tr', {}, h('th', { scope: 'row', class: 'mt-acc', text: r.label }), r.values.map((v, i) => amountCell('td', v, { blankZero: true, cls: cls(i) })));
      return h('tr', { class: ROW_CLASS[r.kind] }, h('th', { scope: 'row', title: r.label, text: r.label }), r.values.map((v, i) => amountCell('td', v, { cls: cls(i) })));
    });
    return [
      h('p', { class: 'muted small', text: `${settings.businessName}　${formatPeriod(period)}` }),
      h('div', { class: 'table-wrap' }, h('table', { class: 'report monthly mtb', 'aria-label': '製造原価報告書（月次推移）' }, h('thead', {}, head), h('tbody', {}, rows))),
    ];
  }

  // 印刷：期間の合計は決算書の体裁（A4縦、表題・期間・会社名・単位）。月次推移はA4横の推移表
  app.printDoc = ({ printedAt }) => {
    const monthlyMode = mode === 'monthly';
    return {
      options: [
        { key: 'mode', label: '印刷する表', type: 'select', choices: [['total', '製造原価報告書（期間の合計）'], ['monthly', '月次推移']], value: mode },
        { key: 'zero', label: '0円の科目も出す', type: 'check', value: showZero },
        ...unitPrintOptions(unit.value()),
        { key: 'orientation', label: '用紙の向き', type: 'select', choices: [['portrait', 'A4縦'], ['landscape', 'A4横']], value: monthlyMode ? 'landscape' : 'portrait' },
      ],
      build: (v) => {
        const head = docHead({ settings, period, printedAt });
        if (v.mode === 'monthly') {
          const m = getMonthly();
          return monthlyDoc({
            title: '製造原価報告書（月次推移）',
            head,
            columns: [...m.months.map(monthLabel), '合計'],
            sections: [{ rows: manufacturingMonthlyRows(m.items, { showZero: v.zero }) }],
            unit: normalizeUnit(v),
            orientation: v.orientation,
            notes: ['各月の発生額です。仕掛品の棚卸高は決算整理の仕訳を登録した月に出ます。'],
          });
        }
        return incomeStatementDoc(report.items, { head, title: '製造原価報告書', entityType: 'corporation', showZero: v.zero, unit: normalizeUnit(v), orientation: v.orientation });
      },
    };
  };

  function csv() {
    const text = mode === 'monthly' ? monthlyCsv(getMonthly().items, monthly.months, { total: true, includeZero: showZero }) : manufacturingCsv(report.items, { includeZero: showZero });
    saveFile(new Blob([text], { type: 'text/csv' }), csvFileName(mode === 'monthly' ? 'manufacturing-monthly' : 'manufacturing'));
  }

  function paint() {
    history.replaceState(history.state, '', `#/reports/manufacturing${mode === 'monthly' ? '?mode=monthly' : ''}`);
    put(body, mode === 'monthly' ? monthlyTable() : totalTable());
  }

  put(
    outlet,
    h(
      'div',
      { class: 'report-tools no-print' },
      segmented({
        name: '表示',
        options: [
          { value: 'total', label: '期間の合計' },
          { value: 'monthly', label: '月次推移' },
        ],
        value: mode,
        onChange: (v) => ((mode = v), paint()),
      }),
      unit.el,
    ),
    h('div', { class: 'option-bar no-print' }, zero.el),
    body,
    h('div', { class: 'actions no-print' }, h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: csv })),
    h(
      'div',
      { class: 'panel small muted' },
      h('p', { text: `当期製品製造原価 ${formatYen(report.cost)}円 は、損益計算書の売上原価に「当期製品製造原価」として入ります。` }),
      h('p', { text: '様式は決算書の製造原価報告書の並びです：材料費（期首材料棚卸高＋材料仕入高−期末材料棚卸高＝当期材料費）・労務費（当期労務費）・製造経費（当期製造経費）の合計が当期総製造費用、これに期首仕掛品棚卸高を足し、期末仕掛品棚卸高を引いたものが当期製品製造原価です。印刷すると、決算書と同じ体裁（表題・期間・会社名・単位）で申告書に添付できます。他勘定振替高（製品を自社で使ったときなど）は扱いません。' }),
      h('p', {}, '原材料・仕掛品・製品の期末の棚卸は ', h('a', { href: '#/closing', class: 'link', text: '決算・繰越' }), ' の画面から登録します。工場の機械などの減価償却費は、固定資産の画面で償却費の科目を「減価償却費（製造）」にすると製造経費に入ります。'),
    ),
  );
  paint();
}
