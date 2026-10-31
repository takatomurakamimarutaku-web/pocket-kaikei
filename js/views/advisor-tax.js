// 納税予測：着地見込みの利益から、納める税金（税目・年税額・中間納付・差引納付額・納期限）を出す
import { h, put, amountCell } from '../ui.js';
import { formatYen } from '../money.js';
import { TAX_METHODS } from '../tax-return.js';
import { loadAdvisor, estimateNote, monthLabel } from './advisor-common.js';

const slash = (d) => d.replaceAll('-', '/');

export async function render({ app, outlet }) {
  const { data, landing, taxes } = await loadAdvisor(app);
  const { settings } = data;
  const corp = settings.entityType === 'corporation';
  const items = taxes.items;
  const sum = (f) => items.reduce((s, i) => s + f(i), 0);
  const through = landing.actualThrough ? `${monthLabel(landing.actualThrough)}までの実績と、残りの月の見込みから計算しています。` : 'すべての月を見込みで計算しています。';

  const rows = items.map((i) =>
    h(
      'tr',
      {},
      h('th', { scope: 'row' }, i.label, i.note ? h('span', { class: 'muted small block', text: i.note }) : null),
      amountCell('td', i.annual),
      amountCell('td', i.interim, { blankZero: true }),
      amountCell('td', i.due, { cls: 'strong' }),
      h('td', { class: 'num', text: slash(i.deadline) }),
    ),
  );
  const table = h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'report advisor-taxes', 'aria-label': '納める税金の見込み' },
      h('thead', {}, h('tr', {}, h('th', { text: '税目' }), h('th', { text: '年税額' }), h('th', { text: '中間納付' }), h('th', { text: '差引納付額' }), h('th', { text: '納期限' }))),
      h('tbody', {}, rows, h('tr', { class: 'mt-strong' }, h('th', { scope: 'row', text: '合計' }), amountCell('td', sum((i) => i.annual)), amountCell('td', sum((i) => i.interim), { blankZero: true }), amountCell('td', taxes.total), h('td', { text: '' }))),
    ),
  );

  // 消費税の計算方法ごとの税額（簡易課税・2割特例などを選べるかの目安）
  const consumption = taxes.consumption;
  const compare = consumption
    ? h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'report advisor-compare', 'aria-label': '消費税の計算方法ごとの税額' },
          h('thead', {}, h('tr', {}, h('th', { text: '計算方法' }), h('th', { text: '納める税額（年税額）' }))),
          h(
            'tbody',
            {},
            TAX_METHODS.filter((m) => consumption.compare[m.id]).map((m) => {
              const c = consumption.compare[m.id];
              return h('tr', { class: m.id === consumption.method ? 'mt-strong' : '' }, h('th', { scope: 'row' }, m.label, m.id === consumption.method ? h('span', { class: 'muted small block', text: '申告計算で選んでいる方法' }) : null, c.unavailable ? h('span', { class: 'muted small block', text: c.unavailable }) : null), amountCell('td', c.total));
            }),
          ),
        ),
      )
    : null;

  put(
    outlet,
    h(
      'div',
      { class: 'kpi-grid' },
      h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: taxes.total >= 0 ? '納める税金の見込み' : '還付される税金の見込み' }), h('span', { class: 'kpi-value num', text: `${formatYen(Math.abs(taxes.total))}円` }), h('span', { class: 'kpi-sub', text: '中間納付・予定納税を引いた額' })),
      corp
        ? h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: '着地の税引前当期純利益' }), h('span', { class: `kpi-value num ${taxes.pretax < 0 ? 'neg' : ''}`, text: `${formatYen(taxes.pretax)}円` }), h('span', { class: 'kpi-sub', text: `所得金額 ${formatYen(taxes.taxableIncome)}円` }))
        : h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: '着地の所得金額（控除前）' }), h('span', { class: `kpi-value num ${taxes.pretax < 0 ? 'neg' : ''}`, text: `${formatYen(taxes.pretax)}円` }), h('span', { class: 'kpi-sub', text: `税金を引いた目安 ${formatYen(taxes.afterTax)}円` })),
    ),
    h('p', { class: 'muted small', text: through }),
    h('h2', { class: 'section-title', text: '納める税金' }),
    items.length ? table : h('p', { class: 'muted', text: '納める税金の見込みはありません。' }),
    taxes.notes.map((n) => h('p', { class: 'muted small', text: n })),
    compare ? [h('h2', { class: 'section-title', text: '消費税の計算方法ごとの税額' }), compare, h('p', { class: 'muted small', text: '簡易課税は、原則として適用したい課税期間が始まる前に届出が必要です。2割特例は個人は令和8年分まで、3割特例は登録を機に課税事業者になった個人の令和9年分・10年分に使えます（国税庁）。' })] : null,
    h('h2', { class: 'section-title', text: '計算の条件を直す' }),
    h(
      'ul',
      { class: 'plain-list small' },
      corp ? h('li', {}, h('a', { class: 'link', href: '#/reports/corporate-tax/input', text: '法人税の計算の条件' }), '（中間納付・欠損金・交際費・住民税の均等割など）') : h('li', {}, h('a', { class: 'link', href: '#/reports/income-tax', text: '所得税の確定申告書' }), '（所得控除・予定納税・源泉徴収税額など）'),
      h('li', {}, h('a', { class: 'link', href: '#/reports/enterprise-tax', text: '事業税' }), corp ? '（税率・中間納付）' : '（業種・損失の繰越）'),
      settings.taxStatus === 'taxable' ? h('li', {}, h('a', { class: 'link', href: '#/reports/tax-return', text: '消費税の申告計算' }), '（計算方法・中間納付）') : null,
      h('li', {}, h('a', { class: 'link', href: '#/advisor/forecast', text: '着地見込み' }), '（残りの月の見込み）'),
    ),
    estimateNote(),
  );
}
