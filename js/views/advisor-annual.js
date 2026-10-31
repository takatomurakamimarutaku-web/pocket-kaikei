// 年計（移動年計）：各月から過去12か月の合計。季節変動をならして、伸びているか落ちているかを見る
// 表は月次推移表と同じ並び（縦に科目、横に月）。グラフは売上と利益、または選んだ科目の年計の線
import { h, put, amountCell, segmented } from '../ui.js';
import { lineChart } from '../chart.js';
import { GROUPS, GROUP_BY_ID } from '../accounts.js';
import { movingAnnual } from '../advisor/simulation.js';
import { loadAdvisor, estimateNote, monthLabel } from './advisor-common.js';

const GROUP_ORDER = GROUPS.map((g) => g.id);
const sign = (p) => (p === null ? '—' : `${p > 0 ? '+' : p < 0 ? '−' : ''}${(Math.abs(p) / 10).toFixed(1)}%`);

export async function render({ app, outlet, isStale }) {
  const { data, landing, previous } = await loadAdvisor(app);
  if (isStale?.()) return;
  const { settings, accounts } = data;
  const corp = settings.entityType === 'corporation';
  const r = movingAnnual({ accounts, landing, prev: previous });
  const salesWord = corp ? '売上高' : '売上(収入)金額';
  const profitWord = corp ? '利益（税引前）' : '所得（控除前）';
  const labels = r.months.map(monthLabel);
  let target = 'total'; // グラフの項目：total（売上と利益）か科目の id
  let mode = 'annual'; // 表：annual（年計）か monthly（各月の金額）

  const chartEl = h('div', { class: 'card advisor-chart' });
  const tableEl = h('div', {});

  const paintChart = () => {
    const row = r.rows.find((x) => x.account.id === target);
    const series = row ? [{ label: `${row.account.name}の年計`, values: row.annual }] : [{ label: `年計の${salesWord}`, values: r.sales }, { label: `年計の${profitWord}`, values: r.profit }];
    // 年計が2か月以上そろわないと線にならないので、グラフは出さない
    const ready = series[0].values.filter((x) => x !== null).length >= 2;
    put(
      chartEl,
      h(
        'label',
        { class: 'field advisor-annual-pick' },
        h('span', { class: 'small', text: 'グラフにする項目' }),
        h(
          'select',
          { onchange: (e) => { target = e.target.value; paintChart(); } },
          h('option', { value: 'total', text: `${salesWord}と${profitWord}`, selected: target === 'total' }),
          r.rows.map((x) => h('option', { value: x.account.id, text: x.account.name, selected: target === x.account.id })),
        ),
      ),
      ready ? lineChart({ labels, series, title: '年計の推移', planFrom: r.planFrom }) : h('p', { class: 'muted small', text: '年計が2か月以上そろわないため、グラフは出せません。' }),
      ready ? h('p', { class: 'muted small', text: '破線と白い点は、見込みの月を含む年計です。右上がりなら伸びている、右下がりなら落ちています。' }) : null,
    );
  };

  const paintTable = () => {
    const pick = (x) => (mode === 'annual' ? x.annual : x.monthly);
    const cell = (v) => (v === null ? h('td', { class: 'num muted', text: '—' }) : amountCell('td', v));
    const sumAt = (list, i) => (mode === 'annual' && list.some((x) => x.annual[i] === null) ? null : list.reduce((t, x) => t + pick(x)[i], 0));
    const lastCol = (values, change) => (mode === 'annual' ? h('td', { class: 'num', text: change === undefined ? '' : sign(change) }) : cell(values.reduce((t, v) => t + (v || 0), 0)));
    const pctOf = (xs) => {
      const first = xs.findIndex((x) => x !== null);
      return first >= 0 && first < xs.length - 1 && xs[first] !== 0 ? Math.round(((xs.at(-1) - xs[first]) * 1000) / Math.abs(xs[first])) : null;
    };
    // 製造原価の区分（材料費・労務費・製造経費）は売上原価の前に並べる（損益計算書の順）
    const rank = (g) => (GROUP_BY_ID[g]?.mfg ? GROUP_ORDER.indexOf('cost_of_sales') - 0.5 : GROUP_ORDER.indexOf(g));
    const byGroup = new Map();
    for (const x of [...r.rows].sort((a, b) => rank(a.account.group) - rank(b.account.group))) {
      if (!byGroup.has(x.account.group)) byGroup.set(x.account.group, []);
      byGroup.get(x.account.group).push(x);
    }
    const body = [];
    for (const [group, list] of byGroup) {
      const label = GROUP_BY_ID[group]?.label || group;
      body.push(h('tr', { class: 'fs-r-group' }, h('th', { class: 'grid-account', scope: 'rowgroup', text: label }), h('td', { colspan: String(r.months.length + 1) })));
      for (const x of list) body.push(h('tr', {}, h('th', { class: 'grid-account', scope: 'row', text: x.account.name }), pick(x).map((v, i) => cellAt(cell(v), i)), lastCol(pick(x), x.change)));
      const sub = r.months.map((_, i) => sumAt(list, i));
      body.push(h('tr', { class: 'grid-subtotal' }, h('th', { class: 'grid-account', scope: 'row', text: `${label} 計` }), sub.map((v, i) => cellAt(cell(v), i)), lastCol(sub, pctOf(sub))));
    }
    const profit = mode === 'annual' ? r.profit : r.monthlyProfit;
    body.push(h('tr', { class: 'mt-strong' }, h('th', { class: 'grid-account', scope: 'row', text: profitWord }), profit.map((v, i) => cellAt(cell(v), i)), lastCol(profit, mode === 'annual' ? r.change?.profit ?? null : undefined)));
    const head = h(
      'tr',
      {},
      h('th', { class: 'grid-account', text: '科目' }),
      r.months.map((m, i) => h('th', { class: i >= r.planFrom ? 'is-plan' : '' }, monthLabel(m), h('span', { class: 'grid-kind', text: i >= r.planFrom ? '見込み' : '実績' }))),
      h('th', { text: mode === 'annual' ? '増減' : '合計' }),
    );
    put(
      tableEl,
      h(
        'div',
        { class: 'card-title-row advisor-grid-head' },
        h('h2', { class: 'section-title', text: mode === 'annual' ? '科目ごとの年計' : '科目ごとの月の金額' }),
        segmented({ name: '表の金額', options: [{ value: 'annual', label: '年計' }, { value: 'monthly', label: '各月の金額' }], value: mode, onChange: (v) => { mode = v; paintTable(); } }),
      ),
      h('p', { class: 'muted small', text: mode === 'annual' ? '各月のマスは、その月までの12か月の合計です。「—」は12か月そろわない月です。増減は、年計がそろった最初の月から最後の月までの変化です。' : '各月のマスは、その月1か月分の金額です。' }),
      h('div', { class: 'table-wrap advisor-grid-wrap' }, h('table', { class: 'report advisor-grid advisor-annual', 'aria-label': mode === 'annual' ? '科目ごとの年計' : '科目ごとの月の金額' }, h('thead', {}, head), h('tbody', {}, body))),
    );
  };
  // 見込みの月のマスに色を付ける
  const cellAt = (td, i) => {
    if (i >= r.planFrom) td.classList.add('is-plan');
    return td;
  };

  paintChart();
  paintTable();
  put(
    outlet,
    h('p', { class: 'muted small', text: '年計（移動年計）は、その月までの12か月の合計です。毎月1か月分ずつ入れ替わるので、季節の変動が消え、事業が伸びているか落ちているかが線の向きで分かります。' }),
    previous ? null : h('p', { class: 'notice small', text: '前期の帳簿が無いため、12か月そろうのは期間の最後の月だけです。前期の帳簿があると、毎月の年計を出せます。' }),
    chartEl,
    r.change ? h('p', { class: 'panel small' }, `年計の${salesWord}は、${monthLabel(r.months[r.sales.findIndex((x) => x !== null)])}から${monthLabel(r.months.at(-1))}で `, h('strong', { text: sign(r.change.sales) }), `、${profitWord}は `, h('strong', { text: sign(r.change.profit) }), '。') : null,
    tableEl,
    estimateNote(),
  );
}
