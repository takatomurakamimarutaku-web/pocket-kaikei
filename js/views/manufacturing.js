// 製造原価報告書（法人）：材料費・労務費・製造経費 → 当期総製造費用 → 仕掛品の増減 → 当期製品製造原価
// 期間の合計と、月ごとに横に並べる表示を切り替える
import { h, put, amountCell, saveFile, segmented } from '../ui.js';
import { closingRows, manufacturingReport } from '../statements.js';
import { monthlyManufacturing, isAllZero } from '../monthly.js';
import { manufacturingCsv, monthlyCsv, csvFileName } from '../csv.js';
import { formatPeriod } from '../period.js';
import { formatYen } from '../money.js';
import { zeroToggle, unitPicker } from './report-common.js';

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

  function totalTable() {
    const rows = [];
    for (const it of report.items) {
      if (it.type === 'subtotal') {
        rows.push(h('tr', { class: it.plain ? 'st-line' : `st-subtotal ${it.strong ? 'strong' : ''}` }, h('th', { text: it.label }), amountCell('td', it.amount)));
        continue;
      }
      const lines = it.lines.filter((l) => showZero || l.amount);
      rows.push(h('tr', { class: 'st-group' }, h('th', { colspan: 2, text: it.label })));
      for (const l of lines) rows.push(h('tr', { class: 'st-line' }, h('th', { text: l.account.name }), amountCell('td', l.amount)));
      rows.push(h('tr', { class: 'st-total' }, h('th', { text: `${it.label} 計` }), amountCell('td', it.total)));
    }
    return h('div', { class: 'table-wrap' }, h('table', { class: 'report statement' }, h('caption', { text: '製造原価報告書' }), h('tbody', {}, rows)));
  }

  function monthlyTable() {
    monthly = monthly || monthlyManufacturing({ accounts, period, journals });
    const head = h('tr', {}, h('th', { scope: 'col', text: '科目' }), monthly.months.map((m) => h('th', { scope: 'col', text: monthLabel(m) })), h('th', { scope: 'col', text: '合計' }));
    const rows = [];
    for (const item of monthly.items) {
      if (item.type === 'group') {
        rows.push(h('tr', { class: 'tb-group' }, h('th', { scope: 'row', text: item.label }), item.values.map((v) => amountCell('td', v)), amountCell('td', item.total)));
        for (const l of item.lines.filter((x) => showZero || !isAllZero(x.values))) {
          rows.push(h('tr', {}, h('th', { scope: 'row', class: 'mt-acc', text: l.account.name }), l.values.map((v) => amountCell('td', v, { blankZero: true })), amountCell('td', l.total)));
        }
      } else {
        rows.push(h('tr', { class: item.strong ? 'mt-strong' : item.plain ? '' : 'tb-subtotal' }, h('th', { scope: 'row', class: item.plain ? 'mt-acc' : '', text: item.label }), item.values.map((v) => amountCell('td', v, { blankZero: item.plain })), amountCell('td', item.total)));
      }
    }
    return h('div', { class: 'table-wrap' }, h('table', { class: 'report monthly' }, h('thead', {}, head), h('tbody', {}, rows)));
  }

  function csv() {
    const text = mode === 'monthly' ? monthlyCsv(monthly.items, monthly.months, { total: true, includeZero: showZero }) : manufacturingCsv(report.items, { includeZero: showZero });
    saveFile(new Blob([text], { type: 'text/csv' }), csvFileName(mode === 'monthly' ? 'manufacturing-monthly' : 'manufacturing'));
  }

  function paint() {
    history.replaceState(history.state, '', `#/reports/manufacturing${mode === 'monthly' ? '?mode=monthly' : ''}`);
    put(body, mode === 'monthly' ? monthlyTable() : totalTable());
  }

  put(
    outlet,
    h('p', { class: 'muted small', text: `${settings.businessName}　${formatPeriod(period)}` }),
    h(
      'div',
      { class: 'no-print' },
      segmented({
        name: '表示',
        options: [
          { value: 'total', label: '期間の合計' },
          { value: 'monthly', label: '月次推移' },
        ],
        value: mode,
        onChange: (v) => ((mode = v), paint()),
      }),
    ),
    unit.el,
    h('div', { class: 'option-bar no-print' }, zero.el),
    body,
    h('div', { class: 'actions no-print' }, h('button', { type: 'button', class: 'btn', text: 'CSVで書き出す', onclick: csv })),
    h(
      'div',
      { class: 'panel small muted' },
      h('p', { text: `当期製品製造原価 ${formatYen(report.cost)}円 は、損益計算書の売上原価に「当期製品製造原価」として入ります。` }),
      h('p', { text: '材料費は 期首材料棚卸高＋材料仕入高−期末材料棚卸高、当期製品製造原価は 当期総製造費用＋期首仕掛品棚卸高−期末仕掛品棚卸高 です（財務諸表等規則の製造原価明細書の並び）。' }),
      h('p', {}, '原材料・仕掛品・製品の期末の棚卸は ', h('a', { href: '#/closing', class: 'link', text: '決算・繰越' }), ' の画面から登録します。工場の機械などの減価償却費は、固定資産の画面で償却費の科目を「減価償却費（製造）」にすると製造経費に入ります。'),
    ),
  );
  paint();
}
